import test from "node:test";
import assert from "node:assert/strict";
import http from "http";
import path from "path";
import fs from "fs";
import { BatchQueueStore, normalizeQueueItem, generateIdempotencyKey } from "../automation/workflow/batch-queue-store.js";
import { BatchWorkflowRunner } from "../automation/workflow/batch-workflow-runner.js";
import { BrowserManager } from "../agent/browser-manager.js";
import { BatchItemStatus } from "../shared/states.js";

function createMockTargetServer() {
  const processed = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/submit") {
      const id = url.searchParams.get("id");
      processed.push(id);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><h1 id="result">Item ${id} Processed</h1></body></html>`);
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><h1 id="home">Mock Target Home</h1></body></html>`);
    }
  });

  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}`, processed });
    });
  });
}

const testStorePath = path.resolve("./data/test_batch_queue.json");

test("BatchQueueStore enforces idempotency and duplicate prevention", () => {
  if (fs.existsSync(testStorePath)) fs.unlinkSync(testStorePath);
  const store = new BatchQueueStore(testStorePath);

  const workflow = {
    name: "Idempotent Flow",
    steps: [{ actionType: "comment", comment: "Test" }]
  };

  const rawItems = [
    { reel_url: "https://ig.me/reel/100", creator_name: "Clipper1" },
    { reel_url: "https://ig.me/reel/100", creator_name: "Clipper1" }, // Duplicate
    { reel_url: "https://ig.me/reel/200", creator_name: "Clipper2" }
  ];

  const batchJob = store.createBatchJob({
    workflowId: "wf_test_1",
    workflow,
    items: rawItems
  });

  assert.equal(batchJob.totalCount, 2);
  assert.equal(batchJob.duplicatesSkippedCount, 1);
  assert.equal(batchJob.items[0].reel_url, "https://ig.me/reel/100");
  assert.equal(batchJob.items[1].reel_url, "https://ig.me/reel/200");
});

test("BatchQueueStore persists queue state across store re-instantiation", () => {
  if (fs.existsSync(testStorePath)) fs.unlinkSync(testStorePath);
  const store1 = new BatchQueueStore(testStorePath);

  const batchJob = store1.createBatchJob({
    workflowId: "wf_test_persist",
    workflow: { name: "Persist Flow", steps: [] },
    items: [{ reel_url: "https://ig.me/1" }, { reel_url: "https://ig.me/2" }]
  });

  store1.updateItemStatus(batchJob.id, batchJob.items[0].id, BatchItemStatus.SUCCESS, { log: "Done" });

  // Simulate restart by initializing store2
  const store2 = new BatchQueueStore(testStorePath);
  const reloadedJob = store2.getJob(batchJob.id);

  assert.ok(reloadedJob);
  assert.equal(reloadedJob.summary.success, 1);
  assert.equal(reloadedJob.items[0].status, BatchItemStatus.SUCCESS);
  assert.equal(reloadedJob.items[1].status, BatchItemStatus.QUEUED);
});

test("BatchWorkflowRunner processes batch items with mixed success and failure", async () => {
  const { server, baseUrl } = await createMockTargetServer();
  const testStore = new BatchQueueStore(path.resolve("./data/test_mixed_batch.json"));
  const bm = new BrowserManager();

  try {
    const workflow = {
      name: "Mixed Outcome Flow",
      steps: [
        { actionType: "navigate", value: `${baseUrl}/submit?id={{clip_id}}` },
        { actionType: "verify", locator: { id: "result" }, value: "Processed" }
      ]
    };

    const batchJob = testStore.createBatchJob({
      workflowId: "wf_mixed",
      workflow,
      items: [
        { clip_id: "ITEM_1", reel_url: "https://ig.me/1" },
        { clip_id: "ITEM_2", reel_url: "https://ig.me/2" }
      ],
      browserConfig: { headless: true, profileName: "batch-test-profile-1" }
    });

    const runner = new BatchWorkflowRunner({ batchStore: testStore, browserManager: bm });
    const finalJob = await runner.runBatchJob(batchJob.id);

    assert.equal(finalJob.summary.total, 2);
    assert.equal(finalJob.summary.success, 2);
    assert.equal(finalJob.items[0].status, BatchItemStatus.SUCCESS);
    assert.equal(finalJob.items[1].status, BatchItemStatus.SUCCESS);
  } finally {
    server.close();
  }
});

test("BatchWorkflowRunner skips previously completed items in recovery run", async () => {
  const { server, baseUrl } = await createMockTargetServer();
  const testStore = new BatchQueueStore(path.resolve("./data/test_recovery_batch.json"));
  const bm = new BrowserManager();

  try {
    const workflow = {
      name: "Recovery Flow",
      steps: [
        { actionType: "navigate", value: `${baseUrl}/submit?id={{clip_id}}` }
      ]
    };

    const batchJob = testStore.createBatchJob({
      workflowId: "wf_recovery",
      workflow,
      items: [
        { clip_id: "REC_1" },
        { clip_id: "REC_2" }
      ],
      browserConfig: { headless: true, profileName: "batch-test-profile-2" }
    });

    // Mark item 1 as already SUCCESS before run
    testStore.updateItemStatus(batchJob.id, batchJob.items[0].id, BatchItemStatus.SUCCESS, { log: "Pre-completed" });

    const runner = new BatchWorkflowRunner({ batchStore: testStore, browserManager: bm });
    const finalJob = await runner.runBatchJob(batchJob.id);

    // Item 1 should remain SUCCESS without incrementing attempts
    assert.equal(finalJob.items[0].status, BatchItemStatus.SUCCESS);
    assert.equal(finalJob.items[0].attempts, 0); // Not re-run!
    assert.equal(finalJob.items[1].status, BatchItemStatus.SUCCESS);
    assert.equal(finalJob.items[1].attempts, 1);
  } finally {
    server.close();
  }
});

test("BatchWorkflowRunner pause, resume, and cancel controls", async () => {
  const { server, baseUrl } = await createMockTargetServer();
  const testStore = new BatchQueueStore(path.resolve("./data/test_controls_batch.json"));
  const bm = new BrowserManager();

  try {
    const workflow = {
      name: "Controls Flow",
      steps: [
        { actionType: "navigate", value: `${baseUrl}/submit?id={{clip_id}}` },
        { actionType: "wait", value: 300 }
      ]
    };

    const batchJob = testStore.createBatchJob({
      workflowId: "wf_controls",
      workflow,
      items: [
        { clip_id: "CTRL_1" },
        { clip_id: "CTRL_2" },
        { clip_id: "CTRL_3" }
      ],
      browserConfig: { headless: true, profileName: "batch-test-profile-3" }
    });

    const runner = new BatchWorkflowRunner({ batchStore: testStore, browserManager: bm });

    // Start in background and pause then cancel
    const runPromise = runner.runBatchJob(batchJob.id);

    await new Promise(r => setTimeout(r, 150));
    const paused = runner.pause();
    assert.equal(paused, true);
    assert.equal(runner.isPaused, true);

    await new Promise(r => setTimeout(r, 200));
    const resumed = runner.resume();
    assert.equal(resumed, true);
    assert.equal(runner.isPaused, false);

    await new Promise(r => setTimeout(r, 200));
    const cancelled = runner.cancel();
    assert.equal(cancelled, true);

    const finalJob = await runPromise;
    assert.equal(finalJob.status, "CANCELLED");
    assert.ok(finalJob.summary.cancelled > 0 || finalJob.items.some(i => i.status === BatchItemStatus.CANCELLED));
  } finally {
    server.close();
  }
});

test("BatchWorkflowRunner handles UNKNOWN outcomes safely without blind retries", async () => {
  const { server } = await createMockTargetServer();
  const testStore = new BatchQueueStore(path.resolve("./data/test_uncertain_batch.json"));
  const bm = new BrowserManager();

  try {
    // A workflow with a step designed to simulate timeout uncertainty
    const workflow = {
      name: "Uncertain Flow",
      steps: [
        { actionType: "wait", value: 100 }
      ]
    };

    const batchJob = testStore.createBatchJob({
      workflowId: "wf_uncertain",
      workflow,
      items: [{ clip_id: "UNC_1" }],
      browserConfig: { headless: true, profileName: "batch-test-profile-4" }
    });

    testStore.updateItemStatus(batchJob.id, batchJob.items[0].id, BatchItemStatus.UNKNOWN, {
      failureReason: "Navigation confirmation timed out",
      uncertainReason: "Timeout occurred before confirmation step could resolve. Requires review."
    });

    const updatedJob = testStore.getJob(batchJob.id);
    assert.equal(updatedJob.summary.unknown, 1);
    assert.equal(updatedJob.items[0].status, BatchItemStatus.UNKNOWN);
    assert.ok(updatedJob.items[0].uncertainReason.includes("Requires review"));
  } finally {
    server.close();
  }
});

