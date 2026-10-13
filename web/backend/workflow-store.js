import fs from "fs";
import path from "path";
import crypto from "crypto";

const DATA_DIR = path.resolve("./data");
const WORKFLOWS_FILE = path.join(DATA_DIR, "workflows.json");

export const SupportedActionTypes = [
  "click",
  "dblclick",
  "type_text",
  "select_option",
  "press_key",
  "wait",
  "navigate",
  "comment",
  "verify"
];

export const WorkflowStatus = {
  DRAFT: "draft",
  PUBLISHED: "published"
};

/**
 * Validates a single workflow step.
 */
export function validateStep(step, index = 0) {
  if (!step || typeof step !== "object") {
    throw new Error(`Step at index ${index} must be an object.`);
  }

  const stepId = step.stepId || `step_${crypto.randomUUID().slice(0, 8)}`;
  const actionType = String(step.actionType || "").toLowerCase().trim();

  if (!SupportedActionTypes.includes(actionType)) {
    throw new Error(`Invalid or unsupported actionType "${actionType}" at step ${index + 1}.`);
  }

  // Locator is required for interaction actions
  const requiresLocator = ["click", "dblclick", "type_text", "select_option"].includes(actionType);
  if (requiresLocator && (!step.locator || typeof step.locator !== "object")) {
    throw new Error(`Action "${actionType}" at step ${index + 1} requires a valid locator object.`);
  }

  // Safe timeouts
  const timeout = typeof step.timeout === "number" && step.timeout > 0 ? step.timeout : 5000;
  const enabled = step.enabled !== false;
  const failurePolicy = ["stop", "continue", "retry_twice"].includes(step.failurePolicy)
    ? step.failurePolicy
    : "stop";

  return {
    stepId,
    sequence: typeof step.sequence === "number" ? step.sequence : index + 1,
    actionType,
    locator: step.locator || null,
    value: step.value !== undefined ? step.value : null,
    timeout,
    enabled,
    comment: typeof step.comment === "string" ? step.comment : "",
    failurePolicy,
    isSensitive: Boolean(step.isSensitive)
  };
}

/**
 * Validates entire workflow structure.
 */
export function validateWorkflow(workflow) {
  if (!workflow || typeof workflow !== "object") {
    throw new Error("Workflow payload must be an object.");
  }

  if (!workflow.name || typeof workflow.name !== "string" || !workflow.name.trim()) {
    throw new Error("Workflow 'name' is required.");
  }

  const steps = Array.isArray(workflow.steps)
    ? workflow.steps.map((s, idx) => validateStep(s, idx))
    : [];

  // Extract template variables like {{var_name}}
  const detectedVariables = new Set();
  const varRegex = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g;
  for (const step of steps) {
    if (typeof step.value === "string") {
      let match;
      while ((match = varRegex.exec(step.value)) !== null) {
        detectedVariables.add(match[1]);
      }
    }
  }

  return {
    name: workflow.name.trim(),
    description: typeof workflow.description === "string" ? workflow.description.trim() : "",
    steps,
    requiredVariables: Array.from(new Set([...(workflow.requiredVariables || []), ...detectedVariables])),
    settings: {
      stepTimeoutMs: typeof workflow.settings?.stepTimeoutMs === "number" ? workflow.settings.stepTimeoutMs : 15000,
      failurePolicy: ["stop", "continue", "retry_twice"].includes(workflow.settings?.failurePolicy)
        ? workflow.settings.failurePolicy
        : "stop",
      screenshotOnFailure: Boolean(workflow.settings?.screenshotOnFailure)
    }
  };
}

/**
 * Pre-flight validation for a workflow before saving or executing.
 * Checks for missing required fields, empty locators, unsafe timeouts,
 * undefined variables, and returns structured errors & warnings.
 */
export function preflightValidateWorkflow(workflow, availableVariables = ["reel_url", "creator_name", "clip_id", "campaign_name", "submission_type", "discord_url", "comment_text"]) {
  const errors = [];
  const warnings = [];

  if (!workflow || typeof workflow !== "object") {
    return { valid: false, errors: ["Workflow definition must be an object."], warnings };
  }

  if (!workflow.name || typeof workflow.name !== "string" || !workflow.name.trim()) {
    errors.push("Workflow name is required.");
  }

  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  if (steps.length === 0) {
    errors.push("Workflow must contain at least one step.");
  }

  const varRegex = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g;
  const availableSet = new Set(availableVariables.map(v => v.toLowerCase()));

  steps.forEach((step, idx) => {
    const stepNum = idx + 1;
    const action = String(step.actionType || "").toLowerCase().trim();

    if (!SupportedActionTypes.includes(action)) {
      errors.push(`Step ${stepNum}: Invalid or unsupported action type "${action}".`);
      return;
    }

    if (step.enabled === false) {
      warnings.push(`Step ${stepNum} (${action}): Step is disabled and will be skipped during execution.`);
    }

    // Actions requiring a locator
    const requiresLocator = ["click", "dblclick", "type_text", "select_option"].includes(action);
    if (requiresLocator) {
      if (!step.locator || typeof step.locator !== "object") {
        errors.push(`Step ${stepNum} (${action}): A target locator is required.`);
      } else {
        const hasAnySelector = Boolean(
          step.locator.testId ||
          (step.locator.role && step.locator.accessibleName) ||
          step.locator.id ||
          step.locator.css ||
          step.locator.primary
        );
        if (!hasAnySelector) {
          errors.push(`Step ${stepNum} (${action}): Target locator must specify at least one valid selector (testId, role, id, css, or primary).`);
        }
      }
    }

    // Value requirements
    if (["type_text", "select_option"].includes(action)) {
      if (step.value === undefined || step.value === null || String(step.value).trim() === "") {
        warnings.push(`Step ${stepNum} (${action}): Text value is empty.`);
      }
    }

    if (action === "wait") {
      const waitVal = Number(step.value);
      if (isNaN(waitVal) || waitVal <= 0) {
        errors.push(`Step ${stepNum} (wait): Wait duration must be a positive number in milliseconds.`);
      } else if (waitVal > 120000) {
        warnings.push(`Step ${stepNum} (wait): Wait duration exceeds 2 minutes (${waitVal / 1000}s).`);
      }
    }

    if (action === "navigate") {
      if (!step.value || typeof step.value !== "string" || !step.value.trim()) {
        errors.push(`Step ${stepNum} (navigate): URL value is required.`);
      } else if (!step.value.startsWith("http://") && !step.value.startsWith("https://") && !step.value.includes("{{")) {
        warnings.push(`Step ${stepNum} (navigate): URL should begin with http:// or https://.`);
      }
    }

    if (action === "verify") {
      const hasSelector = Boolean(step.locator && (step.locator.testId || step.locator.role || step.locator.id || step.locator.css || step.locator.primary));
      const hasText = Boolean(step.value && String(step.value).trim());
      if (!hasSelector && !hasText) {
        errors.push(`Step ${stepNum} (verify): Verify step must specify either a locator or an expected text value.`);
      }
    }

    // Check variable interpolation
    if (typeof step.value === "string") {
      let match;
      varRegex.lastIndex = 0;
      while ((match = varRegex.exec(step.value)) !== null) {
        const varName = match[1].toLowerCase();
        if (!availableSet.has(varName)) {
          warnings.push(`Step ${stepNum}: References variable "{{${match[1]}}}" which is not in standard variables (${availableVariables.join(", ")}).`);
        }
      }
    }

    // Timeouts
    if (typeof step.timeout === "number" && step.timeout > 60000) {
      warnings.push(`Step ${stepNum}: Timeout is unusually long (${step.timeout / 1000}s).`);
    }
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stepCount: steps.length,
    enabledStepCount: steps.filter(s => s.enabled !== false).length
  };
}

export class WorkflowStore {
  constructor(customFilePath = null) {
    this.filePath = customFilePath || WORKFLOWS_FILE;
    this.dataDir = path.dirname(this.filePath);
    this.ensureDataDir();
    this.activeJobWorkflows = new Set(); // Tracks workflows currently running in a job
    this.workflows = this.loadWorkflows();
  }

  ensureDataDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  loadWorkflows() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        return JSON.parse(raw);
      }
    } catch (err) {
      console.warn(`[WorkflowStore] Could not read ${this.filePath}, initializing empty store:`, err.message);
    }
    return [];
  }

  /**
   * Atomic write to avoid data corruption, with Windows file lock retries.
   */
  saveWorkflows() {
    this.ensureDataDir();
    const tempFile = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
    const data = JSON.stringify(this.workflows, null, 2);
    try {
      fs.writeFileSync(tempFile, data, "utf-8");
      
      // On Windows, renameSync can momentarily fail with EPERM if an AV or file watcher touches the file
      let renamed = false;
      let lastErr = null;
      for (let i = 0; i < 5; i++) {
        try {
          fs.renameSync(tempFile, this.filePath);
          renamed = true;
          break;
        } catch (rErr) {
          lastErr = rErr;
          // Short synchronous backoff
          const end = Date.now() + 20;
          while (Date.now() < end) {}
        }
      }

      if (!renamed) {
        // Fallback to writeFileSync directly if renameSync remains blocked
        fs.writeFileSync(this.filePath, data, "utf-8");
        try { fs.unlinkSync(tempFile); } catch {}
      }
    } catch (err) {
      if (fs.existsSync(tempFile)) {
        try { fs.unlinkSync(tempFile); } catch {}
      }
      console.error(`[WorkflowStore] Atomic write failed for ${this.filePath}:`, err.message);
      throw err;
    }
  }

  lockWorkflowForJob(workflowId) {
    this.activeJobWorkflows.add(String(workflowId));
  }

  unlockWorkflowForJob(workflowId) {
    this.activeJobWorkflows.delete(String(workflowId));
  }

  isWorkflowLocked(workflowId) {
    return this.activeJobWorkflows.has(String(workflowId));
  }

  listWorkflows(workspaceId = "default") {
    return this.workflows
      .filter(w => (w.workspaceId || "default") === workspaceId)
      .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
  }

  getWorkflow(workflowId, workspaceId = "default") {
    return this.workflows.find(w => String(w.id) === String(workflowId) && (w.workspaceId || "default") === workspaceId) || null;
  }

  createWorkflow(input, workspaceId = "default") {
    const validated = validateWorkflow(input);
    const id = `wf_${crypto.randomUUID().slice(0, 10)}`;
    const now = new Date().toISOString();

    const newWorkflow = {
      id,
      workspaceId: workspaceId || "default",
      name: validated.name,
      description: validated.description,
      version: 1,
      status: WorkflowStatus.DRAFT,
      createdAt: now,
      updatedAt: now,
      steps: validated.steps,
      requiredVariables: validated.requiredVariables,
      settings: validated.settings
    };

    this.workflows.unshift(newWorkflow);
    this.saveWorkflows();
    return newWorkflow;
  }

  updateWorkflow(workflowId, input, workspaceId = "default") {
    if (this.isWorkflowLocked(workflowId)) {
      throw new Error(`Cannot update workflow #${workflowId} while it is currently executing in an active job.`);
    }

    const index = this.workflows.findIndex(w => String(w.id) === String(workflowId) && (w.workspaceId || "default") === workspaceId);
    if (index === -1) {
      throw new Error(`Workflow #${workflowId} not found in workspace "${workspaceId}".`);
    }

    const existing = this.workflows[index];

    // If existing workflow is published, update creates a new DRAFT version rather than mutating the published record
    if (existing.status === WorkflowStatus.PUBLISHED) {
      const validated = validateWorkflow({ ...existing, ...input });
      const now = new Date().toISOString();
      const newVersionWorkflow = {
        ...existing,
        id: `wf_${crypto.randomUUID().slice(0, 10)}`,
        name: validated.name,
        description: validated.description,
        version: (existing.version || 1) + 1,
        status: WorkflowStatus.DRAFT,
        createdAt: now,
        updatedAt: now,
        steps: validated.steps,
        requiredVariables: validated.requiredVariables,
        settings: validated.settings,
        previousVersionId: existing.id
      };
      this.workflows.unshift(newVersionWorkflow);
      this.saveWorkflows();
      return newVersionWorkflow;
    }

    // Otherwise, update existing draft
    const validated = validateWorkflow({ ...existing, ...input });
    const updated = {
      ...existing,
      name: validated.name,
      description: validated.description,
      steps: validated.steps,
      requiredVariables: validated.requiredVariables,
      settings: validated.settings,
      updatedAt: new Date().toISOString()
    };

    this.workflows[index] = updated;
    this.saveWorkflows();
    return updated;
  }

  publishWorkflow(workflowId, workspaceId = "default") {
    if (this.isWorkflowLocked(workflowId)) {
      throw new Error(`Cannot change publish state of workflow #${workflowId} while it is running.`);
    }

    const index = this.workflows.findIndex(w => String(w.id) === String(workflowId) && (w.workspaceId || "default") === workspaceId);
    if (index === -1) {
      throw new Error(`Workflow #${workflowId} not found.`);
    }

    const existing = this.workflows[index];
    if (existing.status === WorkflowStatus.PUBLISHED) {
      return existing; // Already published
    }

    const updated = {
      ...existing,
      status: WorkflowStatus.PUBLISHED,
      publishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.workflows[index] = updated;
    this.saveWorkflows();
    return updated;
  }

  deleteDraftWorkflow(workflowId, workspaceId = "default") {
    if (this.isWorkflowLocked(workflowId)) {
      throw new Error(`Cannot delete workflow #${workflowId} while it is running.`);
    }

    const index = this.workflows.findIndex(w => String(w.id) === String(workflowId) && (w.workspaceId || "default") === workspaceId);
    if (index === -1) {
      throw new Error(`Workflow #${workflowId} not found.`);
    }

    const existing = this.workflows[index];
    if (existing.status === WorkflowStatus.PUBLISHED) {
      throw new Error(`Cannot delete published workflow #${workflowId}. Published versions are immutable.`);
    }

    this.workflows.splice(index, 1);
    this.saveWorkflows();
    return { success: true, id: workflowId };
  }
}
