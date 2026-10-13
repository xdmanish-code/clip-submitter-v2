import test from "node:test";
import assert from "node:assert/strict";
import { preflightValidateWorkflow, SupportedActionTypes } from "../web/backend/workflow-store.js";

test("preflightValidateWorkflow catches empty workflow and missing names", () => {
  const res1 = preflightValidateWorkflow(null);
  assert.equal(res1.valid, false);
  assert.ok(res1.errors.length > 0);

  const res2 = preflightValidateWorkflow({ name: "", steps: [] });
  assert.equal(res2.valid, false);
  assert.ok(res2.errors.includes("Workflow name is required."));
  assert.ok(res2.errors.includes("Workflow must contain at least one step."));
});

test("preflightValidateWorkflow enforces locator requirements for clicks and inputs", () => {
  const invalidWorkflow = {
    name: "Test Flow",
    steps: [
      { actionType: "click", locator: null },
      { actionType: "type_text", locator: { primary: "" }, value: "test" }
    ]
  };

  const res = preflightValidateWorkflow(invalidWorkflow);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some(e => e.includes("Step 1 (click): A target locator is required.")));
  assert.ok(res.errors.some(e => e.includes("Step 2 (type_text): Target locator must specify at least one valid selector")));
});

test("preflightValidateWorkflow warns on disabled steps and empty values", () => {
  const workflow = {
    name: "Valid With Warnings",
    steps: [
      { actionType: "click", locator: { testId: "submit-btn" }, enabled: false },
      { actionType: "type_text", locator: { css: "#caption" }, value: "" }
    ]
  };

  const res = preflightValidateWorkflow(workflow);
  assert.equal(res.valid, true);
  assert.equal(res.errors.length, 0);
  assert.ok(res.warnings.some(w => w.includes("Step 1 (click): Step is disabled")));
  assert.ok(res.warnings.some(w => w.includes("Step 2 (type_text): Text value is empty")));
});

test("preflightValidateWorkflow validates template variable interpolation safely", () => {
  const workflow = {
    name: "Variable Flow",
    steps: [
      {
        actionType: "type_text",
        locator: { id: "reel-input" },
        value: "Reel: {{reel_url}} from {{creator_name}}"
      },
      {
        actionType: "type_text",
        locator: { id: "unknown-input" },
        value: "Custom: {{unsupported_variable}}"
      }
    ]
  };

  const res = preflightValidateWorkflow(workflow);
  assert.equal(res.valid, true);
  assert.ok(res.warnings.some(w => w.includes('References variable "{{unsupported_variable}}"')));
});

test("preflightValidateWorkflow validates wait, navigate, and verify steps", () => {
  const validWorkflow = {
    name: "Full Step Types",
    steps: [
      { actionType: "navigate", value: "https://example.com/login" },
      { actionType: "wait", value: 3000 },
      { actionType: "verify", locator: { testId: "dashboard-header" }, value: "Welcome" },
      { actionType: "comment", comment: "Finished assertion" }
    ]
  };

  const res = preflightValidateWorkflow(validWorkflow);
  assert.equal(res.valid, true);
  assert.equal(res.errors.length, 0);
  assert.equal(res.stepCount, 4);
  assert.equal(res.enabledStepCount, 4);
});
