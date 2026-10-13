import test from "node:test";
import assert from "node:assert/strict";
import http from "http";
import { BrowserManager } from "../agent/browser-manager.js";
import { WorkflowExecutor, interpolateVariables, resolveLocator } from "../automation/workflow/workflow-executor.js";

// Helper to spawn a tiny local HTTP test server
function createLocalTestServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <!DOCTYPE html>
      <html>
      <head><title>Test Automation Page</title></head>
      <body>
        <h1 id="page-title">Welcome to Automation Testing</h1>
        <div id="target-output">Initial Output</div>
        <input type="text" id="username-input" data-testid="user-input" placeholder="Enter username">
        <select id="role-select">
          <option value="editor">Editor</option>
          <option value="admin">Admin</option>
        </select>
        <button id="submit-btn" data-testid="btn-submit" onclick="document.getElementById('target-output').textContent = 'Form Submitted: ' + document.getElementById('username-input').value">Submit</button>
        <button id="dbl-btn" ondblclick="document.getElementById('target-output').textContent = 'Double Clicked!'">Double Click Me</button>
        <div class="duplicate-btn">Duplicate 1</div>
        <div class="duplicate-btn">Duplicate 2</div>
      </body>
      </html>
    `);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

test("interpolateVariables accurately substitutes clip variables without eval", () => {
  const tpl = "Reel: {{reel_url}}, Author: {{creator_name}}, ID: {{clip_id}}";
  const data = { reel_url: "https://ig.me/123", creator_name: "Manish", clip_id: "CLIP-99" };
  const res = interpolateVariables(tpl, data);
  assert.equal(res, "Reel: https://ig.me/123, Author: Manish, ID: CLIP-99");

  // Preserves unknown variables untouched
  assert.equal(interpolateVariables("Keep {{unknown_var}}", {}), "Keep {{unknown_var}}");
});

test("WorkflowExecutor executes navigate, type, click, select, and verify steps on local page", async () => {
  const { server, url } = await createLocalTestServer();
  const bm = new BrowserManager();
  const { context } = await bm.launchNewChromium({ headless: true, profileName: "test-wf-profile-1" });

  try {
    const executor = new WorkflowExecutor();
    const workflow = {
      name: "E2E Test Flow",
      steps: [
        { actionType: "navigate", value: url },
        { actionType: "wait", value: 200 },
        { actionType: "type_text", locator: { testId: "user-input" }, value: "User_{{clip_id}}" },
        { actionType: "select_option", locator: { id: "role-select" }, value: "admin" },
        { actionType: "click", locator: { testId: "btn-submit" } },
        { actionType: "wait", value: 100 },
        { actionType: "verify", locator: { id: "target-output" }, value: "Form Submitted: User_TEST42" }
      ]
    };

    const logs = [];
    const stepsRun = [];

    const result = await executor.execute({
      context,
      workflow,
      clipData: { clip_id: "TEST42" },
      onStep: (step, detail) => stepsRun.push({ step, detail }),
      onLog: (msg) => logs.push(msg)
    });

    assert.equal(result.success, true);
    assert.equal(result.completedSteps, 7);
    assert.equal(stepsRun.length, 7);

    // Verify DOM state
    const page = context.pages()[0];
    const outputText = await page.textContent("#target-output");
    assert.equal(outputText, "Form Submitted: User_TEST42");
  } finally {
    await context.close().catch(() => {});
    server.close();
  }
});

test("WorkflowExecutor skips disabled steps", async () => {
  const { server, url } = await createLocalTestServer();
  const bm = new BrowserManager();
  const { context } = await bm.launchNewChromium({ headless: true, profileName: "test-wf-profile-2" });

  try {
    const executor = new WorkflowExecutor();
    const workflow = {
      name: "Skip Disabled Flow",
      steps: [
        { actionType: "navigate", value: url },
        { actionType: "click", locator: { id: "submit-btn" }, enabled: false }, // Disabled step
        { actionType: "verify", locator: { id: "target-output" }, value: "Initial Output" }
      ]
    };

    const result = await executor.execute({
      context,
      workflow,
      clipData: {}
    });

    assert.equal(result.success, true);
    assert.equal(result.completedSteps, 2); // 1 skipped
  } finally {
    await context.close().catch(() => {});
    server.close();
  }
});

test("WorkflowExecutor safely throws on missing element and obeys stop policy", async () => {
  const { server, url } = await createLocalTestServer();
  const bm = new BrowserManager();
  const { context } = await bm.launchNewChromium({ headless: true, profileName: "test-wf-profile-3" });

  try {
    const executor = new WorkflowExecutor();
    const workflow = {
      name: "Missing Element Flow",
      steps: [
        { actionType: "navigate", value: url },
        { actionType: "click", locator: { id: "non-existent-button-xyz" }, timeout: 800, failurePolicy: "stop" }
      ]
    };

    await assert.rejects(
      async () => {
        await executor.execute({ context, workflow, clipData: {} });
      },
      /Workflow halted at step 2/
    );
  } finally {
    await context.close().catch(() => {});
    server.close();
  }
});

test("WorkflowExecutor continues on failure when failurePolicy is 'continue'", async () => {
  const { server, url } = await createLocalTestServer();
  const bm = new BrowserManager();
  const { context } = await bm.launchNewChromium({ headless: true, profileName: "test-wf-profile-4" });

  try {
    const executor = new WorkflowExecutor();
    const workflow = {
      name: "Continue Policy Flow",
      steps: [
        { actionType: "navigate", value: url },
        { actionType: "click", locator: { id: "non-existent-button-xyz" }, timeout: 600, failurePolicy: "continue" },
        { actionType: "comment", comment: "Step after failure" }
      ]
    };

    const result = await executor.execute({ context, workflow, clipData: {} });
    assert.equal(result.success, true);
    assert.equal(result.stepResults.length, 3);
    assert.equal(result.stepResults[1].success, false);
    assert.equal(result.stepResults[2].success, true);
  } finally {
    await context.close().catch(() => {});
    server.close();
  }
});

test("WorkflowExecutor catches ambiguous locators safely", async () => {
  const { server, url } = await createLocalTestServer();
  const bm = new BrowserManager();
  const { context } = await bm.launchNewChromium({ headless: true, profileName: "test-wf-profile-5" });

  try {
    const executor = new WorkflowExecutor();
    const workflow = {
      name: "Ambiguous Locator Flow",
      steps: [
        { actionType: "navigate", value: url },
        // '.duplicate-btn' matches 2 visible divs
        { actionType: "click", locator: { css: ".duplicate-btn" }, timeout: 800, failurePolicy: "stop" }
      ]
    };

    await assert.rejects(
      async () => {
        await executor.execute({ context, workflow, clipData: {} });
      },
      /Ambiguous locator: matched 2 elements/
    );
  } finally {
    await context.close().catch(() => {});
    server.close();
  }
});

test("WorkflowExecutor aborts immediately when cancellation is signaled", async () => {
  const { server, url } = await createLocalTestServer();
  const bm = new BrowserManager();
  const { context } = await bm.launchNewChromium({ headless: true, profileName: "test-wf-profile-6" });

  try {
    const executor = new WorkflowExecutor();
    let cancelled = false;

    const workflow = {
      name: "Cancel Flow",
      steps: [
        { actionType: "navigate", value: url },
        { actionType: "wait", value: 1000 },
        { actionType: "click", locator: { id: "submit-btn" } }
      ]
    };

    // Cancel after first step
    setTimeout(() => { cancelled = true; }, 150);

    await assert.rejects(
      async () => {
        await executor.execute({
          context,
          workflow,
          clipData: {},
          isCancelled: () => cancelled
        });
      },
      /Workflow cancelled by user/
    );
  } finally {
    await context.close().catch(() => {});
    server.close();
  }
});
