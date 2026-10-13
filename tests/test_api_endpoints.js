import assert from "node:assert";

process.env.NODE_ENV = "test";
const { app, server, jobManager, wssAgent, wssClient } = await import("../web/backend/server.js");

console.log("==================================================");
console.log("RUNNING REST API & RPC ENDPOINT TESTS");
console.log("==================================================");

// Start server on random port
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;

async function request(path, options = {}) {
  const url = `${baseUrl}${path}`;
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  const res = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

try {
  // TEST 1: GET /api/workflows (Initial empty or existing)
  console.log("\n--- TEST 1: GET /api/workflows ---");
  const res1 = await request("/api/workflows");
  assert.strictEqual(res1.status, 200);
  assert.strictEqual(res1.data.success, true);
  assert(Array.isArray(res1.data.workflows));
  console.log("✓ TEST 1 PASSED: Successfully retrieved workflows list");

  // TEST 2: POST /api/workflows (Create Draft)
  console.log("\n--- TEST 2: POST /api/workflows ---");
  const newWfPayload = {
    name: "API Test Workflow",
    description: "Testing workflow REST API",
    steps: [
      {
        actionType: "click",
        locator: { role: "button", name: "Next" },
        timeout: 4000
      },
      {
        actionType: "wait",
        value: 3000,
        comment: "Wait 3s"
      }
    ]
  };

  const res2 = await request("/api/workflows", {
    method: "POST",
    body: newWfPayload
  });
  assert.strictEqual(res2.status, 201);
  assert.strictEqual(res2.data.success, true);
  assert(res2.data.workflow.id.startsWith("wf_"));
  assert.strictEqual(res2.data.workflow.name, "API Test Workflow");
  assert.strictEqual(res2.data.workflow.status, "draft");
  const createdId = res2.data.workflow.id;
  console.log("✓ TEST 2 PASSED: Successfully created draft workflow via POST");

  // TEST 3: GET /api/workflows/:id
  console.log("\n--- TEST 3: GET /api/workflows/:id ---");
  const res3 = await request(`/api/workflows/${createdId}`);
  assert.strictEqual(res3.status, 200);
  assert.strictEqual(res3.data.workflow.id, createdId);
  console.log("✓ TEST 3 PASSED: Retrieved created workflow by ID");

  // TEST 4: GET /api/workflows/:id 404 on non-existent
  console.log("\n--- TEST 4: GET 404 on missing workflow ---");
  const res4 = await request("/api/workflows/wf_nonexistent");
  assert.strictEqual(res4.status, 404);
  assert.strictEqual(res4.data.success, false);
  console.log("✓ TEST 4 PASSED: Missing ID properly returned 404");

  // TEST 5: PUT /api/workflows/:id (Update Draft)
  console.log("\n--- TEST 5: PUT /api/workflows/:id ---");
  const res5 = await request(`/api/workflows/${createdId}`, {
    method: "PUT",
    body: {
      name: "Updated API Test Workflow",
      steps: [
        {
          actionType: "type_text",
          locator: { id: "url-field" },
          value: "{{reel_url}}"
        }
      ]
    }
  });
  assert.strictEqual(res5.status, 200);
  assert.strictEqual(res5.data.workflow.name, "Updated API Test Workflow");
  assert.strictEqual(res5.data.workflow.steps.length, 1);
  console.log("✓ TEST 5 PASSED: Draft updated successfully via PUT");

  // TEST 6: POST /api/workflows/:id/publish
  console.log("\n--- TEST 6: POST /api/workflows/:id/publish ---");
  const res6 = await request(`/api/workflows/${createdId}/publish`, { method: "POST" });
  assert.strictEqual(res6.status, 200);
  assert.strictEqual(res6.data.workflow.status, "published");
  console.log("✓ TEST 6 PASSED: Workflow published successfully");

  // TEST 7: PUT on Published creates Version 2 Draft
  console.log("\n--- TEST 7: PUT on Published Creates New Version Draft ---");
  const res7 = await request(`/api/workflows/${createdId}`, {
    method: "PUT",
    body: { name: "Version 2 Workflow" }
  });
  assert.strictEqual(res7.status, 200);
  assert.strictEqual(res7.data.workflow.version, 2);
  assert.strictEqual(res7.data.workflow.status, "draft");
  assert.strictEqual(res7.data.workflow.previousVersionId, createdId);
  const v2Id = res7.data.workflow.id;
  console.log("✓ TEST 7 PASSED: Immutable versioning preserved, Version 2 created");

  // TEST 8: DELETE Published vs Draft
  console.log("\n--- TEST 8: DELETE Draft vs Published ---");
  const res8PubDelete = await request(`/api/workflows/${createdId}`, { method: "DELETE" });
  assert.strictEqual(res8PubDelete.status, 400); // Cannot delete published
  assert(res8PubDelete.data.error.includes("Published versions are immutable"));

  const res8DraftDelete = await request(`/api/workflows/${v2Id}`, { method: "DELETE" });
  assert.strictEqual(res8DraftDelete.status, 200);
  assert.strictEqual(res8DraftDelete.data.success, true);
  console.log("✓ TEST 8 PASSED: Blocked deleting published workflow; successfully deleted draft");

  // TEST 9: POST /api/workflows with malformed body returns 400
  console.log("\n--- TEST 9: POST with malformed body returns 400 ---");
  const res9 = await request("/api/workflows", {
    method: "POST",
    body: { name: "", steps: [{ actionType: "invalid_type" }] }
  });
  assert.strictEqual(res9.status, 400);
  assert.strictEqual(res9.data.success, false);
  console.log("✓ TEST 9 PASSED: Malformed workflow payload returned 400 with structured error");

  // TEST 10: GET /api/recorder/status
  console.log("\n--- TEST 10: GET /api/recorder/status ---");
  const res10 = await request("/api/recorder/status");
  assert.strictEqual(res10.status, 200);
  assert.strictEqual(res10.data.success, true);
  console.log("✓ TEST 10 PASSED: Recorder status endpoint returned successfully");

  // Cleanup created test workflow from store
  jobManager.workflowStore.workflows = jobManager.workflowStore.workflows.filter(w => w.id !== createdId && w.id !== v2Id);
  jobManager.workflowStore.saveWorkflows();

  console.log("\n==================================================");
  console.log("ALL 10 API & RPC ENDPOINT TESTS PASSED!");
  console.log("==================================================");
} finally {
  wssAgent.close();
  wssClient.close();
  await new Promise((resolve) => server.close(resolve));
}
