import { executeDualJob, previewDualQueue } from "../automation/dual/engine.js";
import { executeKickJob } from "../automation/kick/engine.js";
import { runClipsterSubmission } from "../automation/clipster/index.js";
import { WorkflowExecutor } from "../automation/workflow/workflow-executor.js";
import { BatchWorkflowRunner } from "../automation/workflow/batch-workflow-runner.js";
import { BatchQueueStore } from "../automation/workflow/batch-queue-store.js";
import { JobStatus } from "../shared/states.js";
import { SubmissionType } from "../shared/submission-types.js";

export class JobRunner {
  constructor(browserManager) {
    this.browserManager = browserManager;
    this.batchStore = new BatchQueueStore();
    this.batchRunner = new BatchWorkflowRunner({
      batchStore: this.batchStore,
      browserManager: this.browserManager
    });
    this.currentJob = null;
    this.isCancelled = false;
  }

  cancelCurrentJob() {
    if (this.currentJob) {
      this.isCancelled = true;
      return true;
    }
    return false;
  }

  async loadQueuePreview({ submissionType, browserConfig, websiteUrl, emitLog = () => {}, emitStep = () => {} }) {
    if (submissionType !== SubmissionType.DUAL) {
      throw new Error(`Queue preview is only available for Dual submission.`);
    }

    emitStep("Connecting to browser", "Accessing browser instance");
    const context = await this.browserManager.getContext(browserConfig);

    const result = await previewDualQueue({
      context,
      websiteUrl,
      onStep: (step, detail) => emitStep(step, detail),
      onLog: (msg) => emitLog(msg)
    });

    return result;
  }

  async runJob(jobPayload, callbacks = {}) {
    const {
      id,
      submissionType = SubmissionType.DUAL,
      browserConfig = {},
      websiteUrl,
      discordUrl,
      queueOverride = null,
      queue = null,
      reels = null
    } = jobPayload;

    const rawQueue = reels || queueOverride || queue || [];

    const {
      onStatusUpdate = () => {},
      onStep = () => {},
      onLog = () => {},
      onClipUpdate = () => {},
      onComplete = () => {},
      onError = () => {}
    } = callbacks;

    this.currentJob = jobPayload;
    this.isCancelled = false;

    onStatusUpdate(JobStatus.STARTING);
    onLog(`[Agent] Job #${id} starting (Type: ${submissionType}, Clips: ${rawQueue.length})...`);

    const normalizedType = String(submissionType || "").toLowerCase().trim();

    try {
      if (normalizedType === "clipster") {
        await runClipsterSubmission();
        return;
      }

      // KICK SUBMISSION EXECUTION
      if (normalizedType === "kick") {
        if (rawQueue.length === 0) {
          throw new Error("No reels selected or loaded in Kick queue.");
        }

        onStatusUpdate(JobStatus.BROWSER_CONNECTING);
        onStep("Connecting to browser", "Establishing browser session for Kick Discord");

        const context = await this.browserManager.getContext(browserConfig);

        onStatusUpdate(JobStatus.PROCESSING);
        const result = await executeKickJob({
          context,
          submissionType: "kick",
          discordUrl: discordUrl || process.env.KICK_DISCORD_URL || "",
          queueOverride: rawQueue,
          reels: rawQueue,
          jobId: id,
          agentId: process.env.AGENT_ID || "LocalAgent",
          onStep: (step, detail) => {
            onStep(step, detail);
          },
          onLog: (msg) => {
            onLog(msg);
          },
          onClipUpdate: (clip, progress) => {
            onClipUpdate(clip, progress);
          },
          isCancelled: () => this.isCancelled
        });

        const summary = result.summary || {};
        if (this.isCancelled) {
          onStatusUpdate(JobStatus.CANCELLED);
          onLog(`[Agent] Kick Job #${id} cancelled gracefully.`);
          onComplete({ ...result, status: JobStatus.CANCELLED });
        } else if (rawQueue.length > 0 && summary.success === 0 && summary.skipped === 0 && summary.failed > 0) {
          onStatusUpdate(JobStatus.FAILED);
          onLog(`[Agent] Kick Job #${id} finished with failures (${summary.failed} failed, 0 success).`);
          onComplete({ ...result, status: JobStatus.FAILED });
        } else {
          onStatusUpdate(JobStatus.COMPLETED);
          onLog(`[Agent] Kick Job #${id} completed. (Success: ${summary.success || 0}, Skipped: ${summary.skipped || 0}, Failed: ${summary.failed || 0})`);
          onComplete({ ...result, status: JobStatus.COMPLETED });
        }

        return result;
      }

      // DUAL SUBMISSION EXECUTION
      if (normalizedType === "dual") {
        onStatusUpdate(JobStatus.BROWSER_CONNECTING);
        onStep("Connecting to browser", "Establishing CDP / browser session");

        const context = await this.browserManager.getContext(browserConfig);

        onStatusUpdate(JobStatus.PROCESSING);
        const result = await executeDualJob({
          context,
          submissionType: "dual",
          websiteUrl,
          discordUrl,
          queueOverride: rawQueue,
          onStep: (step, detail) => {
            onStep(step, detail);
          },
          onLog: (msg) => {
            onLog(msg);
          },
          onClipUpdate: (clip, progress) => {
            onClipUpdate(clip, progress);
          },
          isCancelled: () => this.isCancelled
        });

        if (this.isCancelled) {
          onStatusUpdate(JobStatus.CANCELLED);
          onLog(`[Agent] Job #${id} cancelled gracefully.`);
          onComplete({ ...result, status: JobStatus.CANCELLED });
        } else {
          onStatusUpdate(JobStatus.COMPLETED);
          onLog(`[Agent] Job #${id} completed successfully.`);
          onComplete({ ...result, status: JobStatus.COMPLETED });
        }

        return result;
      }

      // CUSTOM TEACH MODE WORKFLOW EXECUTION
      if (normalizedType === "workflow") {
        onStatusUpdate(JobStatus.BROWSER_CONNECTING);
        onStep("Connecting to browser", "Establishing browser session for workflow execution");

        const context = await this.browserManager.getContext(browserConfig);
        const executor = new WorkflowExecutor();

        onStatusUpdate(JobStatus.PROCESSING);
        const workflowDefinition = jobPayload.workflow || {};
        const testClip = rawQueue[0] || jobPayload.clipData || {
          reel_url: "https://instagram.com/reel/preview",
          creator_name: "TestCreator",
          clip_id: "TEST_001"
        };

        const result = await executor.execute({
          context,
          workflow: workflowDefinition,
          clipData: testClip,
          onStep: (step, detail) => onStep(step, detail),
          onLog: (msg) => onLog(msg),
          isCancelled: () => this.isCancelled
        });

        if (this.isCancelled) {
          onStatusUpdate(JobStatus.CANCELLED);
          onLog(`[Agent] Workflow Job #${id} cancelled.`);
          onComplete({ ...result, status: JobStatus.CANCELLED });
        } else {
          onStatusUpdate(JobStatus.COMPLETED);
          onLog(`[Agent] Workflow Job #${id} completed.`);
          onComplete({ ...result, status: JobStatus.COMPLETED });
        }

        return result;
      }

      // BATCH WORKFLOW QUEUE EXECUTION
      if (normalizedType === "batch_workflow") {
        onStatusUpdate(JobStatus.BROWSER_CONNECTING);
        onStep("Connecting to browser", "Establishing dedicated browser session for batch execution");

        const batchJobId = jobPayload.batchJobId;
        if (!batchJobId) {
          throw new Error("Missing batchJobId for batch_workflow execution.");
        }

        const result = await this.batchRunner.runBatchJob(batchJobId, {
          onStatusUpdate: (status) => onStatusUpdate(status),
          onItemStart: (item, idx) => {
            onStep(`Batch Item ${idx + 1}/${rawQueue.length}`, `${item.reel_url || item.id} (${item.status})`);
            onClipUpdate(item, { current: idx + 1, total: rawQueue.length });
          },
          onItemComplete: (item) => {
            onClipUpdate(item, { current: item.index, total: rawQueue.length });
          },
          onLog: (msg) => onLog(msg),
          onComplete: (batchJob) => {
            onComplete(batchJob);
          },
          onError: (err) => {
            onError(err, JobStatus.FAILED);
          }
        });

        return result;
      }

      throw new Error(`INVALID ROUTING: Unknown submission type "${submissionType}".`);
    } catch (err) {
      const isCancel = this.isCancelled || err.message.includes("cancelled");
      const finalStatus = isCancel ? JobStatus.CANCELLED : JobStatus.FAILED;

      onStatusUpdate(finalStatus);
      onLog(`[Agent] Job #${id} error: ${err.message}`);
      onError(err, finalStatus);
      throw err;
    } finally {
      this.currentJob = null;
      this.isCancelled = false;
    }
  }
}
