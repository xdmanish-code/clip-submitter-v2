import { BatchItemStatus } from "../../shared/states.js";
import { WorkflowExecutor } from "./workflow-executor.js";

/**
 * BatchWorkflowRunner executes an ordered batch queue of items against a single browser session.
 * It manages pause, resume, cancel, per-item state tracking, and recovery from interruptions.
 */
export class BatchWorkflowRunner {
  constructor(options = {}) {
    this.batchStore = options.batchStore;
    this.browserManager = options.browserManager;
    this.executor = new WorkflowExecutor();
    this.activeBatchJobId = null;
    this.isPaused = false;
    this.isCancelled = false;
  }

  isJobActive() {
    return Boolean(this.activeBatchJobId);
  }

  getActiveJobId() {
    return this.activeBatchJobId;
  }

  pause() {
    if (this.activeBatchJobId) {
      this.isPaused = true;
      if (this.batchStore) {
        this.batchStore.updateJob(this.activeBatchJobId, (j) => {
          j.status = "PAUSED";
          j.pausedAt = new Date().toISOString();
        });
      }
      return true;
    }
    return false;
  }

  resume() {
    if (this.activeBatchJobId && this.isPaused) {
      this.isPaused = false;
      if (this.batchStore) {
        this.batchStore.updateJob(this.activeBatchJobId, (j) => {
          j.status = "PROCESSING";
          j.pausedAt = null;
        });
      }
      return true;
    }
    return false;
  }

  cancel() {
    if (this.activeBatchJobId) {
      this.isCancelled = true;
      this.isPaused = false;
      if (this.batchStore) {
        this.batchStore.updateJob(this.activeBatchJobId, (j) => {
          j.status = "CANCELLED";
          // Mark remaining queued items as CANCELLED
          j.items.forEach(item => {
            if (item.status === BatchItemStatus.QUEUED || item.status === BatchItemStatus.RUNNING) {
              item.status = BatchItemStatus.CANCELLED;
              item.completedAt = new Date().toISOString();
              item.failureReason = "Batch run cancelled by user.";
            }
          });
          j.summary.cancelled = j.items.filter(i => i.status === BatchItemStatus.CANCELLED).length;
          j.processedCount = j.items.length;
        });
      }
      return true;
    }
    return false;
  }

  /**
   * Executes or resumes a batch job.
   */
  async runBatchJob(batchJobId, callbacks = {}) {
    const {
      onStatusUpdate = () => {},
      onItemStart = () => {},
      onItemComplete = () => {},
      onLog = () => {},
      onComplete = () => {},
      onError = () => {}
    } = callbacks;

    if (this.activeBatchJobId && this.activeBatchJobId !== batchJobId) {
      throw new Error(`Another batch job (#${this.activeBatchJobId}) is currently active. Concurrency is limited to 1 browser session.`);
    }

    const job = this.batchStore.getJob(batchJobId);
    if (!job) {
      throw new Error(`Batch job #${batchJobId} not found in store.`);
    }

    this.activeBatchJobId = batchJobId;
    this.isPaused = false;
    this.isCancelled = false;

    this.batchStore.updateJob(batchJobId, (j) => {
      j.status = "PROCESSING";
      if (!j.startedAt) j.startedAt = new Date().toISOString();
    });
    onStatusUpdate("PROCESSING", job);

    onLog(`[BatchRunner] Starting execution of batch #${batchJobId} (${job.items.length} items total)...`);

    let context = null;

    try {
      context = await this.browserManager.getContext(job.browserConfig);

      for (let idx = 0; idx < job.items.length; idx++) {
        // Refresh job state in case updated
        const currentJob = this.batchStore.getJob(batchJobId);
        const item = currentJob.items[idx];

        // Recovery & Idempotence: Skip items that are already completed
        if ([BatchItemStatus.SUCCESS, BatchItemStatus.SKIPPED].includes(item.status)) {
          onLog(`[BatchRunner] Item #${idx + 1} (${item.id}) already completed (${item.status}). Skipping in recovery.`);
          continue;
        }

        // Handle cancellation
        if (this.isCancelled) {
          onLog(`[BatchRunner] Batch job #${batchJobId} cancelled.`);
          break;
        }

        // Handle pause
        while (this.isPaused && !this.isCancelled) {
          onLog(`[BatchRunner] Batch execution is paused. Waiting to resume...`);
          onStatusUpdate("PAUSED", this.batchStore.getJob(batchJobId));
          await new Promise(r => setTimeout(r, 1000));
        }

        if (this.isCancelled) break;

        // Process item
        this.batchStore.updateJob(batchJobId, (j) => {
          j.currentIndex = idx;
          j.currentItemId = item.id;
        });

        this.batchStore.updateItemStatus(batchJobId, item.id, BatchItemStatus.RUNNING, {
          log: `Started execution attempt ${(item.attempts || 0) + 1}`,
          attempts: (item.attempts || 0) + 1
        });
        onItemStart(item, idx);

        onLog(`[BatchRunner] Processing Item ${idx + 1}/${job.items.length}: ${item.reel_url || item.id}`);

        let itemSuccess = false;
        let itemError = null;
        let uncertain = false;

        try {
          // Execute workflow against item data
          const result = await this.executor.execute({
            context,
            workflow: job.workflow,
            clipData: {
              ...item,
              ...item.customVariables
            },
            onStep: (step, detail) => {
              // Log live step progress
            },
            onLog: (msg) => {
              this.batchStore.updateItemStatus(batchJobId, item.id, BatchItemStatus.RUNNING, { log: msg });
            },
            isCancelled: () => this.isCancelled
          });

          itemSuccess = Boolean(result.success);
        } catch (err) {
          itemError = err.message;
          // Check if failure indicates an uncertain outcome
          if (itemError.includes("timeout") && !itemError.includes("locator")) {
            uncertain = true;
          }
        }

        if (this.isCancelled) {
          this.batchStore.updateItemStatus(batchJobId, item.id, BatchItemStatus.CANCELLED, {
            failureReason: "Cancelled by user"
          });
          onItemComplete(this.batchStore.getJob(batchJobId).items[idx]);
          break;
        }

        if (itemSuccess) {
          this.batchStore.updateItemStatus(batchJobId, item.id, BatchItemStatus.SUCCESS, {
            log: "Workflow execution completed successfully"
          });
          onLog(`[BatchRunner] ✓ Item ${idx + 1} succeeded.`);
        } else if (uncertain) {
          // Safe handling for uncertain outcomes: never blindly mark success
          this.batchStore.updateItemStatus(batchJobId, item.id, BatchItemStatus.UNKNOWN, {
            failureReason: itemError,
            uncertainReason: "Timeout occurred before confirmation step could resolve. Requires review.",
            log: `Marked UNKNOWN: ${itemError}`
          });
          onLog(`[BatchRunner] ⚠️ Item ${idx + 1} marked UNKNOWN: ${itemError}`);
        } else {
          this.batchStore.updateItemStatus(batchJobId, item.id, BatchItemStatus.FAILED, {
            failureReason: itemError,
            log: `Execution failed: ${itemError}`
          });
          onLog(`[BatchRunner] ✕ Item ${idx + 1} failed: ${itemError}`);

          if (job.settings?.stopOnFirstFailure) {
            onLog(`[BatchRunner] Stopping batch on first failure as configured.`);
            break;
          }
        }

        onItemComplete(this.batchStore.getJob(batchJobId).items[idx]);
      }

      // Finalize batch status
      const finalJob = this.batchStore.getJob(batchJobId);
      const allDone = finalJob.items.every(i => [BatchItemStatus.SUCCESS, BatchItemStatus.FAILED, BatchItemStatus.SKIPPED, BatchItemStatus.UNKNOWN, BatchItemStatus.CANCELLED].includes(i.status));
      
      let finalStatus = "COMPLETED";
      if (this.isCancelled) {
        finalStatus = "CANCELLED";
      } else if (finalJob.summary.failed > 0 && finalJob.summary.success === 0) {
        finalStatus = "FAILED";
      }

      this.batchStore.updateJob(batchJobId, (j) => {
        j.status = finalStatus;
        j.completedAt = new Date().toISOString();
      });

      onStatusUpdate(finalStatus, this.batchStore.getJob(batchJobId));
      onComplete(this.batchStore.getJob(batchJobId));
      return this.batchStore.getJob(batchJobId);
    } catch (fatalErr) {
      onLog(`[BatchRunner] Fatal batch error: ${fatalErr.message}`);
      if (this.batchStore) {
        this.batchStore.updateJob(batchJobId, (j) => {
          j.status = "FAILED";
          j.completedAt = new Date().toISOString();
        });
      }
      onError(fatalErr);
      throw fatalErr;
    } finally {
      this.activeBatchJobId = null;
      this.isPaused = false;
      this.isCancelled = false;
    }
  }
}
