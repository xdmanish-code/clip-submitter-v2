import assert from "node:assert";
import fs from "fs";
import path from "path";
import { WorkflowStore, WorkflowStatus, validateStep, validateWorkflow } from "../web/backend/workflow-store.js";

const TEST_DB = path.resolve("./data/test_workflows.json");

// Cleanup before run
if (fs.existsSync(TEST_DB)) {
  fs.unlinkSync(TEST_DB);
}

console.log("==================================================");
console.log("RUNNING WORKFLOW STORE TESTS");
console.log("==================================================");

const store = new WorkflowStore(TEST_DB);

// TEST 1: Create Draft Workflow
console.log("\n--- TEST 1: Create Draft Workflow ---");
const wf1 = store.createWorkflow({
  name: "Instagram Form Submission",
  description: "Automates Instagram post link submission",
  steps: [
    {
      actionType: "click",
      locator: { role: "button", name: "Submit" },
      timeout: 3000,
      comment: "Click submit trigger"
    },
    {
      actionType: "type_text",
      locator: { testId: "link-input" },
      value: "{{reel_url}}",
      comment: "Fill reel URL variable"
    }
  ]
});

assert(wf1.id.startsWith("wf_"), "Workflow ID must start with wf_");
assert.strictEqual(wf1.version, 1, "Initial version must be 1");
assert.strictEqual(wf1.status, WorkflowStatus.DRAFT, "Initial status must be draft");
assert.strictEqual(wf1.steps.length, 2, "Must contain 2 steps");
assert(wf1.requiredVariables.includes("reel_url"), "Must detect {{reel_url}} variable");
console.log("✓ TEST 1 PASSED: Created draft workflow with variable detection");

// TEST 2: List and Get Workflow
console.log("\n--- TEST 2: List and Get Workflow ---");
const list = store.listWorkflows();
assert.strictEqual(list.length, 1);
const retrieved = store.getWorkflow(wf1.id);
assert.strictEqual(retrieved.id, wf1.id);
console.log("✓ TEST 2 PASSED: Listed and retrieved workflow successfully");

// TEST 3: Update Draft Workflow
console.log("\n--- TEST 3: Update Draft Workflow ---");
const updatedDraft = store.updateWorkflow(wf1.id, {
  name: "Updated Instagram Submission",
  steps: [
    ...wf1.steps,
    {
      actionType: "wait",
      value: 5000,
      comment: "Wait 5s for confirmation"
    }
  ]
});
assert.strictEqual(updatedDraft.name, "Updated Instagram Submission");
assert.strictEqual(updatedDraft.version, 1, "Draft version remains 1");
assert.strictEqual(updatedDraft.steps.length, 3);
console.log("✓ TEST 3 PASSED: Updated draft in-place without version bump");

// TEST 4: Publish Workflow (Immutable Version)
console.log("\n--- TEST 4: Publish Workflow ---");
const published = store.publishWorkflow(wf1.id);
assert.strictEqual(published.status, WorkflowStatus.PUBLISHED);
assert(published.publishedAt, "Must have publishedAt timestamp");
console.log("✓ TEST 4 PASSED: Successfully published workflow");

// TEST 5: Update Published Workflow -> Generates New Version Draft
console.log("\n--- TEST 5: Update Published Workflow Generates Version 2 Draft ---");
const v2Draft = store.updateWorkflow(wf1.id, {
  name: "Instagram Submission V2"
});
assert.notStrictEqual(v2Draft.id, wf1.id, "V2 draft must have a new ID");
assert.strictEqual(v2Draft.version, 2, "V2 draft must have version 2");
assert.strictEqual(v2Draft.status, WorkflowStatus.DRAFT, "V2 draft must be draft");
assert.strictEqual(v2Draft.previousVersionId, wf1.id, "Must link to previous version");

// Original published workflow remains untouched
const originalPublished = store.getWorkflow(wf1.id);
assert.strictEqual(originalPublished.status, WorkflowStatus.PUBLISHED);
assert.strictEqual(originalPublished.version, 1);
assert.strictEqual(originalPublished.name, "Updated Instagram Submission");
console.log("✓ TEST 5 PASSED: Immutable versioning preserved, new draft created for edits");

// TEST 6: Prevent Deletion of Published Workflow
console.log("\n--- TEST 6: Prevent Deletion of Published Workflow ---");
assert.throws(() => {
  store.deleteDraftWorkflow(wf1.id);
}, /Cannot delete published workflow/);
console.log("✓ TEST 6 PASSED: Blocked deletion of published immutable workflow");

// TEST 7: Allow Deletion of Draft Workflow
console.log("\n--- TEST 7: Allow Deletion of Draft Workflow ---");
const deleteRes = store.deleteDraftWorkflow(v2Draft.id);
assert.strictEqual(deleteRes.success, true);
assert.strictEqual(store.getWorkflow(v2Draft.id), null);
console.log("✓ TEST 7 PASSED: Deleted draft workflow");

// TEST 8: Step Validation & Malformed Payloads
console.log("\n--- TEST 8: Malformed Step and Action Rejection ---");
assert.throws(() => {
  validateStep({ actionType: "invalid_action" });
}, /Invalid or unsupported actionType/);

assert.throws(() => {
  validateStep({ actionType: "click", locator: null });
}, /requires a valid locator object/);

assert.throws(() => {
  validateWorkflow({ name: "" });
}, /Workflow 'name' is required/);
console.log("✓ TEST 8 PASSED: Correctly rejected malformed step & workflow payloads");

// TEST 9: Active Job Locking
console.log("\n--- TEST 9: Active Job Locking ---");
store.lockWorkflowForJob(wf1.id);
assert.throws(() => {
  store.publishWorkflow(wf1.id);
}, /while it is running/);
assert.throws(() => {
  store.updateWorkflow(wf1.id, { name: "Illegal Mutation" });
}, /while it is currently executing/);
store.unlockWorkflowForJob(wf1.id);
console.log("✓ TEST 9 PASSED: Prevented mutations during active job execution");

// TEST 10: Atomic File Persistence Across Re-instantiation
console.log("\n--- TEST 10: Atomic Persistence Test ---");
const reloadedStore = new WorkflowStore(TEST_DB);
const loadedList = reloadedStore.listWorkflows();
assert.strictEqual(loadedList.length, 1);
assert.strictEqual(loadedList[0].id, wf1.id);
console.log("✓ TEST 10 PASSED: Verified persistence on disk");

// Cleanup
if (fs.existsSync(TEST_DB)) {
  fs.unlinkSync(TEST_DB);
}

console.log("\n==================================================");
console.log("ALL 10 WORKFLOW STORE TESTS PASSED!");
console.log("==================================================");
