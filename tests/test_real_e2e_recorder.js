import assert from "node:assert";
import http from "node:http";
import WebSocket from "ws";
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";

console.log("==================================================");
console.log("RUNNING REAL END-TO-END RECORDER & UI TEST SUITE");
console.log("==================================================");

// 1. Setup mock target web server serving an interactive test page
let targetPageServer;
let targetPageUrl;
let targetPage2Url;

const testPageHtml = `
<!DOCTYPE html>
<html>
<head><title>Recorder E2E Target Page</title></head>
<body>
  <h1>Interactive Target Application</h1>
  <button id="btn-submit" data-testid="target-submit-btn">Submit Reel</button>

  <form id="test-form">
    <label for="reel-title">Title:</label>
    <input id="reel-title" name="reel_title" type="text" placeholder="Enter title" />

    <label for="reel-category">Platform:</label>
    <select id="reel-category" name="platform">
      <option value="instagram">Instagram</option>
      <option value="kick">Kick</option>
      <option value="youtube">YouTube</option>
    </select>

    <label for="user-password">Password:</label>
    <input id="user-password" name="password" type="password" placeholder="Secret Key" />

    <button id="btn-final-confirm" type="button">Confirm</button>
  </form>
</body>
</html>
`;

const testPage2Html = `
<!DOCTYPE html>
<html><head><title>Target Page 2</title></head>
<body><h1>Page 2 Navigation Success</h1></body>
</html>
`;

targetPageServer = http.createServer((req, res) => {
  if (req.url === "/page2") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(testPage2Html);
  } else {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(testPageHtml);
  }
});

await new Promise((resolve) => targetPageServer.listen(0, resolve));
const targetPort = targetPageServer.address().port;
targetPageUrl = `http://127.0.0.1:${targetPort}/`;
targetPage2Url = `http://127.0.0.1:${targetPort}/page2`;
console.log(`[Target Server] Running at ${targetPageUrl}`);

// Set test environment
process.env.NODE_ENV = "test";
const { app, server, jobManager, wssAgent, wssClient } = await import("../web/backend/server.js");

// Start backend server
await new Promise((resolve) => server.listen(0, resolve));
const backendPort = server.address().port;
const backendUrl = `http://127.0.0.1:${backendPort}`;
const backendWsUrl = `ws://127.0.0.1:${backendPort}`;

console.log(`[Backend Server] Running at ${backendUrl}`);

// ----------------------------------------------------------------
// TEST 1: Backend, Local Agent, and Dashboard start correctly
// ----------------------------------------------------------------
console.log("\n--- TEST 1: Verify Backend, Agent, and Dashboard Start ---");

// Connect dashboard client WebSocket
const clientWs = new WebSocket(`${backendWsUrl}/client-ws`);
const clientMessages = [];
clientWs.on("message", (raw) => {
  try {
    clientMessages.push(JSON.parse(raw.toString()));
  } catch {}
});
await new Promise((resolve) => clientWs.on("open", resolve));

// Connect Local Agent via Agent WebSocket
process.env.BACKEND_WS_URL = `${backendWsUrl}/agent-ws`;
process.env.AGENT_TOKEN = "local-agent-secret";
const agentWs = new WebSocket(`${backendWsUrl}/agent-ws`, {
  headers: {
    "x-agent-token": "local-agent-secret",
    "x-agent-id": "test-agent-e2e"
  }
});

const agentMessages = [];
agentWs.on("message", (raw) => {
  try {
    agentMessages.push(JSON.parse(raw.toString()));
  } catch {}
});
await new Promise((resolve) => agentWs.on("open", resolve));

// Send agent handshake
agentWs.send(JSON.stringify({
  type: "AGENT_HANDSHAKE",
  payload: {
    agentId: "test-agent-e2e",
    hostname: "test-host",
    platform: process.platform,
    browsers: [{ name: "Chromium", available: true }]
  }
}));

// Wait for AGENT_STATUS online on client
await new Promise((resolve) => {
  const check = () => {
    const statusMsg = clientMessages.find(m => m.type === "AGENT_STATUS" && m.payload.online === true);
    if (statusMsg) resolve();
    else setTimeout(check, 100);
  };
  check();
});

assert.strictEqual(jobManager.isAgentOnline(), true, "Agent must be reported online by JobManager");
console.log("✓ TEST 1 PASSED: Backend, Local Agent, and Dashboard client connected and online");

// Wire real RecorderEngine to Agent WS for this E2E test
const { BrowserManager } = await import("../agent/browser-manager.js");
const { RecorderEngine } = await import("../automation/recorder/recorder-engine.js");

const browserManager = new BrowserManager();
const recorderEngine = new RecorderEngine(browserManager);

// Wire agent responses
agentWs.on("message", async (raw) => {
  const msg = JSON.parse(raw.toString());
  const { type, payload = {}, correlationId } = msg;

  if (type === "START_RECORDING") {
    try {
      const session = await recorderEngine.startRecording(payload);
      agentWs.send(JSON.stringify({
        type: "START_RECORDING_ACK",
        payload: { correlationId, success: true, ...session }
      }));
    } catch (err) {
      agentWs.send(JSON.stringify({
        type: "START_RECORDING_ACK",
        payload: { correlationId, success: false, error: err.message }
      }));
    }
  } else if (type === "PAUSE_RECORDING") {
    const res = await recorderEngine.pauseRecording();
    agentWs.send(JSON.stringify({
      type: "PAUSE_RECORDING_ACK",
      payload: { correlationId, success: true, ...res }
    }));
  } else if (type === "RESUME_RECORDING") {
    const res = await recorderEngine.resumeRecording();
    agentWs.send(JSON.stringify({
      type: "RESUME_RECORDING_ACK",
      payload: { correlationId, success: true, ...res }
    }));
  } else if (type === "STOP_RECORDING") {
    const res = await recorderEngine.stopRecording();
    agentWs.send(JSON.stringify({
      type: "STOP_RECORDING_ACK",
      payload: { correlationId, success: true, ...res }
    }));
  }
});

// Stream recorder engine events to backend
recorderEngine.on("recording_started", (ev) => {
  agentWs.send(JSON.stringify({ type: "RECORDING_STARTED", payload: ev }));
});
recorderEngine.on("recording_paused", (ev) => {
  agentWs.send(JSON.stringify({ type: "RECORDING_PAUSED", payload: ev }));
});
recorderEngine.on("recording_resumed", (ev) => {
  agentWs.send(JSON.stringify({ type: "RECORDING_RESUMED", payload: ev }));
});
recorderEngine.on("recorded_step", (ev) => {
  agentWs.send(JSON.stringify({ type: "RECORDED_STEP", payload: ev }));
});
recorderEngine.on("recording_stopped", (ev) => {
  agentWs.send(JSON.stringify({ type: "RECORDING_STOPPED", payload: ev }));
});
recorderEngine.on("recording_error", (ev) => {
  agentWs.send(JSON.stringify({ type: "RECORDING_ERROR", payload: ev }));
});

// ----------------------------------------------------------------
// TEST 2, 3, 4: Real Browser Recording (Click, Type, Dropdown, Key, Navigation, Sensitive Redaction)
// ----------------------------------------------------------------
console.log("\n--- TEST 2, 3, 4: Real Browser Recording & Action Capture ---");

// Start recording session via REST API
const startRes = await fetch(`${backendUrl}/api/recorder/start`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    browserConfig: { mode: "new", headless: true }
  })
}).then(r => r.json());

assert.strictEqual(startRes.success, true);
assert(startRes.session.sessionId.startsWith("rec_"));
console.log(`[Recorder] Recording session started: ${startRes.session.sessionId}`);

// Get target page and navigate to our test target page
const targetPage = recorderEngine.activePage;
assert(targetPage, "Target page must be initialized");
await targetPage.goto(targetPageUrl, { waitUntil: "domcontentloaded" });
await targetPage.waitForTimeout(400);

// 1. Perform Click on button
console.log("-> Interacting: Click #btn-submit");
await targetPage.click('[data-testid="target-submit-btn"]');
await targetPage.waitForTimeout(200);

// 2. Perform Text Input
console.log("-> Interacting: Type into #reel-title");
await targetPage.fill('#reel-title', 'Viral Clip Reel #101');
await targetPage.dispatchEvent('#reel-title', 'change');
await targetPage.waitForTimeout(200);

// 3. Perform Dropdown select
console.log("-> Interacting: Select #reel-category = kick");
await targetPage.selectOption('#reel-category', 'kick');
await targetPage.waitForTimeout(200);

// 4. Perform Keyboard Enter
console.log("-> Interacting: Press Enter");
await targetPage.focus('#reel-title');
await targetPage.keyboard.press('Enter');
await targetPage.waitForTimeout(200);

// 5. Perform Sensitive Password entry
console.log("-> Interacting: Type Sensitive Password into #user-password");
await targetPage.fill('#user-password', 'UltraSecretKey123!');
await targetPage.dispatchEvent('#user-password', 'change');
await targetPage.waitForTimeout(200);

// 6. Perform Navigation
console.log("-> Interacting: Navigate to Page 2");
await targetPage.goto(targetPage2Url, { waitUntil: "domcontentloaded" });
await targetPage.waitForTimeout(400);

// ----------------------------------------------------------------
// Pause and Resume Verification
// ----------------------------------------------------------------
console.log("\n--- Testing Pause and Resume ---");
const pauseRes = await fetch(`${backendUrl}/api/recorder/pause`, { method: "POST" }).then(r => r.json());
assert.strictEqual(pauseRes.success, true);
assert.strictEqual(recorderEngine.state, "PAUSED");

// Action during pause -> should not be recorded
await targetPage.click('body');
await targetPage.waitForTimeout(200);

const resumeRes = await fetch(`${backendUrl}/api/recorder/resume`, { method: "POST" }).then(r => r.json());
assert.strictEqual(resumeRes.success, true);
assert.strictEqual(recorderEngine.state, "RECORDING");

// Stop recording
console.log("-> Stopping recording session");
const stopRes = await fetch(`${backendUrl}/api/recorder/stop`, { method: "POST" }).then(r => r.json());
assert.strictEqual(stopRes.success, true);
assert.strictEqual(recorderEngine.state, "IDLE");

// Collect all RECORDED_STEP events received by the dashboard client
const recordedStepEvents = clientMessages.filter(m => m.type === "RECORDED_STEP").map(m => m.payload.step);
console.log(`[Dashboard Client] Received ${recordedStepEvents.length} recorded steps.`);

assert(recordedStepEvents.length >= 5, `Expected at least 5 recorded steps, got ${recordedStepEvents.length}`);

// Step 1: Click button
const stepClick = recordedStepEvents.find(s => s.actionType === "click");
assert(stepClick, "Click action must be captured");
assert.strictEqual(stepClick.locator.testId, "target-submit-btn");
assert.strictEqual(stepClick.locator.primary, '[data-testid="target-submit-btn"]');
console.log("✓ Click captured with data-testid locator");

// Step 2: Type text
const stepType = recordedStepEvents.find(s => s.actionType === "type_text" && s.value === "Viral Clip Reel #101");
assert(stepType, "Text input must be captured with exact text");
assert.strictEqual(stepType.isSensitive, false);
console.log("✓ Text input captured with accurate value");

// Step 3: Select option
const stepSelect = recordedStepEvents.find(s => s.actionType === "select_option");
assert(stepSelect, "Select option must be captured");
assert.strictEqual(stepSelect.value, "kick");
console.log("✓ Dropdown select option captured with selected value 'kick'");

// Step 4: Keydown
const stepKey = recordedStepEvents.find(s => s.actionType === "press_key");
assert(stepKey, "Press key action must be captured");
assert.strictEqual(stepKey.value, "Enter");
console.log("✓ Enter keypress captured");

// Step 5: SENSITIVE PASSWORD REDACTION
const stepPassword = recordedStepEvents.find(s => s.actionType === "type_text" && s.isSensitive === true);
assert(stepPassword, "Sensitive password input must be captured with isSensitive=true");
assert.strictEqual(stepPassword.value, "[REDACTED_SENSITIVE]", "Password value MUST be redacted!");
assert(!JSON.stringify(recordedStepEvents).includes("UltraSecretKey123!"), "Plaintext password must NOT appear anywhere in recorded steps!");
console.log("✓ Password field was accurately detected and redacted to [REDACTED_SENSITIVE]");

// Step 6: Navigation
const stepNav = recordedStepEvents.find(s => s.actionType === "navigate" && s.value.includes("/page2"));
assert(stepNav, "Navigation step to /page2 must be captured");
console.log(`✓ Page navigation captured accurately (${stepNav.value})`);

// Verify steps order: sequence numbers strictly incrementing 1, 2, 3...
for (let i = 0; i < recordedStepEvents.length; i++) {
  assert.strictEqual(recordedStepEvents[i].sequence, i + 1, `Step ${i + 1} must have sequence ${i + 1}`);
}
console.log("✓ Sequence numbers strictly preserved in order (1..N)");

// ----------------------------------------------------------------
// TEST 5: Save workflow draft, restart app, confirm persistence
// ----------------------------------------------------------------
console.log("\n--- TEST 5: Save Workflow Draft & Persistence Across Restart ---");

const workflowPayload = {
  name: "E2E Recorded Submission Flow",
  description: "End to end test workflow",
  steps: recordedStepEvents
};

const saveRes = await fetch(`${backendUrl}/api/workflows`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(workflowPayload)
}).then(r => r.json());

assert.strictEqual(saveRes.success, true);
const savedWorkflowId = saveRes.workflow.id;
console.log(`[Workflow Saved] Draft ID: ${savedWorkflowId}`);

// Now simulate complete application restart: instantiate fresh WorkflowStore pointing to the same file
const { WorkflowStore } = await import("../web/backend/workflow-store.js");
const freshStore = new WorkflowStore();
const reloadedWf = freshStore.getWorkflow(savedWorkflowId);
assert(reloadedWf, "Workflow must persist across restarts");
assert.strictEqual(reloadedWf.name, "E2E Recorded Submission Flow");
assert.strictEqual(reloadedWf.steps.length, recordedStepEvents.length);
assert.strictEqual(reloadedWf.steps.find(s => s.isSensitive).value, "[REDACTED_SENSITIVE]");
console.log("✓ TEST 5 PASSED: Workflow persisted to data/workflows.json and reloaded with redacted secrets intact");

// Clean up test workflow from disk
freshStore.deleteDraftWorkflow(savedWorkflowId);
freshStore.saveWorkflows();

// ----------------------------------------------------------------
// TEST 6: Test browser disconnection and accurate error state
// ----------------------------------------------------------------
console.log("\n--- TEST 6: Test Browser Disconnection ---");

let errorReceivedOnDashboard = false;
const errorListener = (raw) => {
  try {
    const m = JSON.parse(raw.toString());
    if (m.type === "RECORDING_ERROR") {
      errorReceivedOnDashboard = true;
    }
  } catch {}
};
clientWs.on("message", errorListener);

// Start another quick recording session
const rec2Res = await fetch(`${backendUrl}/api/recorder/start`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ browserConfig: { mode: "new", headless: true } })
}).then(r => r.json());

assert.strictEqual(rec2Res.success, true);
console.log(`[Recorder] Second recording session started: ${rec2Res.session.sessionId}`);

// Force-close the active target page
const p = recorderEngine.activePage;
if (p) {
  await p.close().catch(() => {});
}

// Wait for error event on client WebSocket
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Timeout waiting for RECORDING_ERROR")), 5000);
  const check = () => {
    if (errorReceivedOnDashboard) {
      clearTimeout(timer);
      resolve();
    } else {
      setTimeout(check, 100);
    }
  };
  check();
});

clientWs.off("message", errorListener);
assert.strictEqual(errorReceivedOnDashboard, true, "Dashboard must receive RECORDING_ERROR on browser tab close");
console.log("✓ TEST 6 PASSED: Browser disconnection triggered RECORDING_ERROR on dashboard client");

// ----------------------------------------------------------------
// TEST 8: Inspect Actual UI (HTML/DOM) in a Real Browser
// ----------------------------------------------------------------
console.log("\n--- TEST 8: Inspect Actual UI & Browser Behavior ---");

const { getStandardBrowserPaths } = await import("../agent/browser-discovery.js");
const standard = getStandardBrowserPaths();
const candidates = [...standard.chrome, ...standard.edge, ...standard.brave];
let execPath = null;
for (const c of candidates) {
  if (fs.existsSync(c)) { execPath = c; break; }
}

const uiBrowser = await chromium.launch({ headless: true, executablePath: execPath || undefined });
const uiPage = await uiBrowser.newPage();
await uiPage.goto(`${backendUrl}/index.html`, { waitUntil: "domcontentloaded" });
await uiPage.waitForTimeout(500);

// Check that top nav has Workflow Builder tab
const navWfBtn = await uiPage.$("#navWorkflowBuilder");
assert(navWfBtn, "Nav button #navWorkflowBuilder must exist in DOM");

// Click Workflow Builder tab
await uiPage.click("#navWorkflowBuilder");
await uiPage.waitForTimeout(300);

// Verify view panel became active
const isViewActive = await uiPage.$eval("#viewWorkflowBuilder", el => el.classList.contains("active"));
assert.strictEqual(isViewActive, true, "#viewWorkflowBuilder must have .active class");

// Verify UI controls exist
const startBtn = await uiPage.$("#btnStartRecording");
const saveDraftBtn = await uiPage.$("#btnSaveWorkflowDraft");
const stepsTable = await uiPage.$("#recordedStepsTableBody");
assert(startBtn, "Start button must be present in DOM");
assert(saveDraftBtn, "Save draft button must be present in DOM");
assert(stepsTable, "Steps table body must be present in DOM");

await uiBrowser.close();
console.log("✓ TEST 8 PASSED: Real browser verified Workflow Builder UI rendered and active");

if (browserManager.activeContext) {
  await browserManager.activeContext.close().catch(() => {});
}

// Clean up sockets and servers
clientWs.close();
agentWs.close();
wssAgent.close();
wssClient.close();
await new Promise((r) => server.close(r));
await new Promise((r) => targetPageServer.close(r));

console.log("\n==================================================");
console.log("ALL REAL END-TO-END RECORDER TESTS PASSED!");
console.log("==================================================");
process.exit(0);
