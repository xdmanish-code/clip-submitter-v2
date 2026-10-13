import assert from "node:assert";
import { RecorderEngine, RecorderState, isSensitiveField } from "../automation/recorder/recorder-engine.js";

console.log("==================================================");
console.log("RUNNING RECORDER ENGINE TESTS");
console.log("==================================================");

// Mock Browser Manager and Context
class MockPage {
  constructor(url = "https://example.com") {
    this._url = url;
    this.closed = false;
    this.exposed = {};
    this.scripts = [];
  }
  url() { return this._url; }
  async exposeFunction(name, fn) { this.exposed[name] = fn; }
  async evaluate(fnOrStr) {}
  async addInitScript(str) { this.scripts.push(str); }
  on(evt, handler) {}
  mainFrame() { return this; }
}

class MockContext {
  constructor(page) {
    this._pages = [page];
  }
  pages() { return this._pages; }
  async newPage() {
    const p = new MockPage("https://example.com/new");
    this._pages.push(p);
    return p;
  }
  on(evt, handler) {}
}

class MockBrowserManager {
  constructor() {
    this.page = new MockPage();
    this.context = new MockContext(this.page);
  }
  async getContext() {
    return this.context;
  }
}

const mockManager = new MockBrowserManager();
const recorder = new RecorderEngine(mockManager);

// TEST 1: Initial state
console.log("\n--- TEST 1: Initial Recorder State ---");
assert.strictEqual(recorder.state, RecorderState.IDLE);
assert.strictEqual(recorder.getState().session, null);
console.log("✓ TEST 1 PASSED: Recorder is initially IDLE");

// TEST 2: Start Recording
console.log("\n--- TEST 2: Start Recording ---");
let startEventEmitted = false;
recorder.once("recording_started", (ev) => {
  startEventEmitted = true;
  assert(ev.sessionId.startsWith("rec_"));
});

const startRes = await recorder.startRecording();
assert.strictEqual(recorder.state, RecorderState.RECORDING);
assert(startRes.sessionId.startsWith("rec_"));
assert.strictEqual(startEventEmitted, true);
console.log("✓ TEST 2 PASSED: Successfully transitioned to RECORDING");

// TEST 3: Prevent duplicate start
console.log("\n--- TEST 3: Prevent Duplicate Start ---");
await assert.rejects(async () => {
  await recorder.startRecording();
}, /already active/);
console.log("✓ TEST 3 PASSED: Duplicate start properly rejected");

// TEST 4: Action Capture & Locator Generation
console.log("\n--- TEST 4: Action Capture & Multi-Tier Locator ---");
let recordedSteps = [];
recorder.on("recorded_step", (ev) => {
  recordedSteps.push(ev.step);
});

// Simulate a button click with accessible role and name
recorder.handleRawAction({
  actionType: "click",
  target: {
    role: "button",
    accessibleName: "Submit Form",
    testId: "btn-submit",
    coordinates: { x: 120, y: 340 }
  }
});

assert.strictEqual(recordedSteps.length, 1);
const step1 = recordedSteps[0];
assert.strictEqual(step1.actionType, "click");
assert.strictEqual(step1.sequence, 1);
assert.strictEqual(step1.locator.testId, "btn-submit");
assert.strictEqual(step1.locator.primary, '[data-testid="btn-submit"]');
assert.strictEqual(step1.locator.fallbackCoordinates.x, 120);
console.log("✓ TEST 4 PASSED: Captured click step with strongest testId locator");

// TEST 5: Sensitive Field Redaction
console.log("\n--- TEST 5: Sensitive Field Detection & Redaction ---");
assert.strictEqual(isSensitiveField({ name: "user_password" }), true);
assert.strictEqual(isSensitiveField({ placeholder: "Enter API Token" }), true);
assert.strictEqual(isSensitiveField({ name: "public_username" }), false);

recorder.handleRawAction({
  actionType: "type_text",
  target: {
    name: "user_password",
    id: "pwd-field",
    type: "password"
  },
  value: "SuperSecret123"
});

assert.strictEqual(recordedSteps.length, 2);
const step2 = recordedSteps[1];
assert.strictEqual(step2.actionType, "type_text");
assert.strictEqual(step2.value, "[REDACTED_SENSITIVE]", "Password value must be redacted!");
assert.strictEqual(step2.isSensitive, true);
console.log("✓ TEST 5 PASSED: Password was automatically redacted from step data");

// TEST 6: Pause and Resume
console.log("\n--- TEST 6: Pause and Resume ---");
await recorder.pauseRecording();
assert.strictEqual(recorder.state, RecorderState.PAUSED);

// Raw actions during PAUSED should be ignored
recorder.handleRawAction({
  actionType: "click",
  target: { testId: "ignore-btn" }
});
assert.strictEqual(recordedSteps.length, 2, "Must not capture steps while paused");

await recorder.resumeRecording();
assert.strictEqual(recorder.state, RecorderState.RECORDING);

recorder.handleRawAction({
  actionType: "click",
  target: { testId: "after-resume-btn" }
});
assert.strictEqual(recordedSteps.length, 3, "Captured step after resume");
console.log("✓ TEST 6 PASSED: Pause and Resume correctly suspend and resume recording");

// TEST 7: Manual Wait & Comment Steps
console.log("\n--- TEST 7: Manual Wait & Comment Steps ---");
recorder.addWaitStep(10000, "Wait for animation");
recorder.addCommentStep("Verify user redirect");
assert.strictEqual(recordedSteps.length, 5);
const waitStep = recordedSteps[3];
assert.strictEqual(waitStep.actionType, "wait");
assert.strictEqual(waitStep.value, 10000);
const commentStep = recordedSteps[4];
assert.strictEqual(commentStep.actionType, "comment");
assert.strictEqual(commentStep.value, "Verify user redirect");
console.log("✓ TEST 7 PASSED: Added manual wait and comment steps with correct sequence numbers");

// TEST 8: Stop Recording and Cleanup
console.log("\n--- TEST 8: Stop Recording & Cleanup ---");
let stoppedEventEmitted = false;
recorder.once("recording_stopped", (ev) => {
  stoppedEventEmitted = true;
  assert.strictEqual(ev.stepsCount, 5);
});

const stopResult = await recorder.stopRecording();
assert.strictEqual(recorder.state, RecorderState.IDLE);
assert.strictEqual(stoppedEventEmitted, true);
assert.strictEqual(stopResult.steps.length, 5);
assert.strictEqual(recorder.getState().session, null);
console.log("✓ TEST 8 PASSED: Stopped recording and restored IDLE state");

console.log("\n==================================================");
console.log("ALL 8 RECORDER ENGINE TESTS PASSED!");
console.log("==================================================");
