import path from "path";
import fs from "fs";

/**
 * Safely interpolates {{variables}} in strings using provided clip data.
 * Does not execute arbitrary code or functions.
 */
export function interpolateVariables(template, data = {}) {
  if (typeof template !== "string") return template;
  return template.replace(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (match, varName) => {
    // Check direct property, case-insensitive match, and fallbacks
    if (data[varName] !== undefined && data[varName] !== null) {
      return String(data[varName]);
    }
    const lowerKey = varName.toLowerCase();
    for (const [k, v] of Object.entries(data)) {
      if (k.toLowerCase() === lowerKey && v !== undefined && v !== null) {
        return String(v);
      }
    }
    return match; // Keep unchanged if not provided
  });
}

/**
 * Resolves Playwright locator from candidate hierarchy.
 * Returns { locator, description } or throws error if ambiguous or not found.
 */
export async function resolveLocator(page, locatorConfig, timeout = 5000) {
  if (!locatorConfig || typeof locatorConfig !== "object") {
    throw new Error("Missing locator configuration.");
  }

  const { testId, role, accessibleName, id, css, primary } = locatorConfig;
  let target = null;
  let desc = "";

  if (testId) {
    target = page.getByTestId(testId);
    desc = `getByTestId("${testId}")`;
  } else if (role && accessibleName) {
    target = page.getByRole(role, { name: accessibleName, exact: false });
    desc = `getByRole("${role}", { name: "${accessibleName}" })`;
  } else if (id) {
    target = page.locator(`#${id}`);
    desc = `locator("#${id}")`;
  } else if (css) {
    target = page.locator(css);
    desc = `locator("${css}")`;
  } else if (primary) {
    target = page.locator(primary);
    desc = `locator("${primary}")`;
  } else {
    throw new Error("Locator config specifies no valid selector.");
  }

  // Pre-action check: uniqueness and presence
  try {
    await target.first().waitFor({ state: "attached", timeout });
  } catch (err) {
    throw new Error(`Element not found within ${timeout}ms: ${desc}`);
  }

  const count = await target.count();
  if (count === 0) {
    throw new Error(`Element not found on page: ${desc}`);
  }
  if (count > 1) {
    // Ambiguous locator safety: do not execute blind action on multiple elements unless scoped
    // We use the first element only if clearly visible, otherwise warn
    const visibleCount = (await Promise.all(
      (await target.all()).map(async el => await el.isVisible().catch(() => false))
    )).filter(Boolean).length;

    if (visibleCount > 1) {
      throw new Error(`Ambiguous locator: matched ${count} elements (${visibleCount} visible) for ${desc}. Specify a more specific selector or testId.`);
    }
  }

  return { locator: target.first(), description: desc };
}

/**
 * WorkflowExecutor: Executes step-by-step browser workflows safely.
 */
export class WorkflowExecutor {
  constructor(options = {}) {
    this.options = options;
    this.screenshotsDir = path.resolve("./data/screenshots");
    this.ensureScreenshotsDir();
  }

  ensureScreenshotsDir() {
    if (!fs.existsSync(this.screenshotsDir)) {
      try {
        fs.mkdirSync(this.screenshotsDir, { recursive: true });
      } catch {}
    }
  }

  /**
   * Main execution method.
   */
  async execute({
    context,
    workflow,
    clipData = {},
    onStep = () => {},
    onLog = () => {},
    isCancelled = () => false
  }) {
    if (!context) throw new Error("A valid browser context is required for workflow execution.");
    if (!workflow || !Array.isArray(workflow.steps)) {
      throw new Error("A valid workflow with steps array is required.");
    }

    const steps = workflow.steps.filter(s => s.enabled !== false);
    onLog(`[WorkflowExecutor] Starting workflow "${workflow.name}" (${steps.length} enabled steps) for clip ${clipData.clip_id || clipData.id || "N/A"}...`);

    // Pick active or first page
    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    let completedSteps = 0;
    const stepResults = [];

    for (let i = 0; i < steps.length; i++) {
      if (isCancelled()) {
        onLog(`[WorkflowExecutor] Workflow execution cancelled by user at step #${i + 1}.`);
        throw new Error("Workflow cancelled by user.");
      }

      const step = steps[i];
      const stepIndex = i + 1;
      const actionType = String(step.actionType || "").toLowerCase().trim();
      const failurePolicy = step.failurePolicy || workflow.settings?.failurePolicy || "stop";
      const timeout = typeof step.timeout === "number" && step.timeout > 0 ? step.timeout : 5000;

      onStep(`Step ${stepIndex}/${steps.length}: ${actionType}`, step.comment || `Executing ${actionType}`);
      onLog(`[WorkflowExecutor] [Step ${stepIndex}/${steps.length}] ${actionType} (Policy: ${failurePolicy})...`);

      const executeSingleAttempt = async () => {
        switch (actionType) {
          case "navigate": {
            const rawUrl = String(step.value || "");
            const url = interpolateVariables(rawUrl, clipData);
            if (!url) throw new Error("Navigation URL cannot be empty.");
            await page.goto(url, { timeout: Math.max(timeout, 15000), waitUntil: "domcontentloaded" });
            return { action: "navigate", url };
          }

          case "click": {
            const { locator, description } = await resolveLocator(page, step.locator, timeout);
            await locator.waitFor({ state: "visible", timeout });
            await locator.click({ timeout });
            return { action: "click", locator: description };
          }

          case "dblclick": {
            const { locator, description } = await resolveLocator(page, step.locator, timeout);
            await locator.waitFor({ state: "visible", timeout });
            await locator.dblclick({ timeout });
            return { action: "dblclick", locator: description };
          }

          case "type_text": {
            const { locator, description } = await resolveLocator(page, step.locator, timeout);
            await locator.waitFor({ state: "visible", timeout });
            const interpolated = interpolateVariables(String(step.value !== null && step.value !== undefined ? step.value : ""), clipData);
            await locator.fill(interpolated, { timeout });
            return { action: "type_text", locator: description, length: interpolated.length };
          }

          case "select_option": {
            const { locator, description } = await resolveLocator(page, step.locator, timeout);
            await locator.waitFor({ state: "visible", timeout });
            const interpolated = interpolateVariables(String(step.value || ""), clipData);
            await locator.selectOption(interpolated, { timeout });
            return { action: "select_option", locator: description, value: interpolated };
          }

          case "press_key": {
            const key = String(step.value || "Enter");
            await page.keyboard.press(key);
            return { action: "press_key", key };
          }

          case "wait": {
            const waitMs = Number(step.value) || 1000;
            await page.waitForTimeout(waitMs);
            return { action: "wait", waitMs };
          }

          case "comment": {
            // No browser operation, acts as milestone marker
            return { action: "comment", text: step.comment || step.value };
          }

          case "verify": {
            // Verification step: checks element existence, visibility, or text presence
            let verified = false;
            let detail = "";

            if (step.locator) {
              const { locator, description } = await resolveLocator(page, step.locator, timeout);
              await locator.waitFor({ state: "visible", timeout });
              if (step.value) {
                const expectedText = interpolateVariables(String(step.value), clipData);
                const actualText = await locator.textContent();
                if (!actualText || !actualText.includes(expectedText)) {
                  throw new Error(`Verification failed: Expected element to contain "${expectedText}", but found "${actualText}".`);
                }
                detail = `Element ${description} contains "${expectedText}"`;
              } else {
                detail = `Element ${description} is visible`;
              }
              verified = true;
            } else if (step.value) {
              const expectedText = interpolateVariables(String(step.value), clipData);
              const content = await page.content();
              if (!content.includes(expectedText)) {
                throw new Error(`Verification failed: Page content does not contain text "${expectedText}".`);
              }
              detail = `Page contains text "${expectedText}"`;
              verified = true;
            } else {
              throw new Error("Verify step must specify a locator or expected text.");
            }

            return { action: "verify", detail, verified };
          }

          default:
            throw new Error(`Unsupported action type "${actionType}". Arbitrary code execution is strictly prohibited.`);
        }
      };

      // Execution with retry & failure policy handling
      let attempt = 0;
      const maxAttempts = failurePolicy === "retry_twice" ? 3 : 1;
      let stepSuccess = false;
      let lastError = null;

      while (attempt < maxAttempts && !stepSuccess) {
        attempt++;
        try {
          const detail = await executeSingleAttempt();
          stepSuccess = true;
          completedSteps++;
          stepResults.push({ stepIndex, actionType, success: true, detail });
          onLog(`[WorkflowExecutor] ✓ Step ${stepIndex} (${actionType}) succeeded.`);
        } catch (err) {
          lastError = err;
          if (attempt < maxAttempts) {
            onLog(`[WorkflowExecutor] ⚠️ Step ${stepIndex} failed attempt ${attempt}/${maxAttempts}: ${err.message}. Retrying...`);
            await page.waitForTimeout(1000);
          }
        }
      }

      if (!stepSuccess) {
        onLog(`[WorkflowExecutor] ✕ Step ${stepIndex} (${actionType}) failed: ${lastError.message}`);

        // Capture privacy-safe diagnostic failure screenshot if enabled
        let screenshotPath = null;
        if (workflow.settings?.screenshotOnFailure !== false) {
          try {
            const filename = `failure_${Date.now()}_step${stepIndex}.png`;
            screenshotPath = path.join(this.screenshotsDir, filename);
            await page.screenshot({ path: screenshotPath, fullPage: false });
            onLog(`[WorkflowExecutor] 📸 Diagnostic screenshot saved: ${filename}`);
          } catch (scErr) {
            onLog(`[WorkflowExecutor] Could not capture diagnostic screenshot: ${scErr.message}`);
          }
        }

        stepResults.push({
          stepIndex,
          actionType,
          success: false,
          error: lastError.message,
          screenshotPath
        });

        if (failurePolicy === "continue") {
          onLog(`[WorkflowExecutor] Failure policy is "continue". Proceeding to next step despite failure.`);
        } else {
          // Failure policy is 'stop'
          throw new Error(`Workflow halted at step ${stepIndex} (${actionType}): ${lastError.message}`);
        }
      }
    }

    onLog(`[WorkflowExecutor] Workflow "${workflow.name}" completed successfully (${completedSteps}/${steps.length} steps executed).`);
    return {
      success: true,
      workflowName: workflow.name,
      totalSteps: steps.length,
      completedSteps,
      stepResults
    };
  }
}
