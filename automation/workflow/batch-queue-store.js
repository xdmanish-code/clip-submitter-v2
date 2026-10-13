import fs from "fs";
import path from "path";
import crypto from "crypto";
import { BatchItemStatus } from "../../shared/states.js";

const DATA_DIR = path.resolve("./data");
const BATCH_FILE = path.join(DATA_DIR, "batch_jobs.json");

/**
 * Computes deterministic idempotency key for a queue item.
 */
export function generateIdempotencyKey(workflowId, itemData) {
  const primaryId = itemData.clip_id || itemData.id || itemData.reel_url || itemData.instagramLink || "";
  const normalizedTarget = String(itemData.reel_url || itemData.instagramLink || "").trim().toLowerCase();
  const raw = `${workflowId}::${primaryId}::${normalizedTarget}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

/**
 * Validates and normalizes a batch queue item.
 */
export function normalizeQueueItem(item, workflowId, index = 0) {
  if (!item || typeof item !== "object") {
    throw new Error(`Queue item at index ${index} must be an object.`);
  }

  const id = item.id || item.clip_id || `item_${index + 1}_${crypto.randomUUID().slice(0, 8)}`;
  const reelUrl = item.reel_url || item.instagramLink || "";
  const idempotencyKey = item.idempotencyKey || generateIdempotencyKey(workflowId, item);

  return {
    id: String(id),
    index: index + 1,
    idempotencyKey,
    reel_url: reelUrl,
    instagramLink: reelUrl,
    creator_name: item.creator_name || item.creator || "",
    creator: item.creator_name || item.creator || "",
    campaign_name: item.campaign_name || "Default",
    customVariables: item.customVariables || {},
    status: item.status || BatchItemStatus.QUEUED,
    attempts: typeof item.attempts === "number" ? item.attempts : 0,
    maxRetries: typeof item.maxRetries === "number" ? item.maxRetries : 1,
    failureReason: item.failureReason || null,
    uncertainReason: item.uncertainReason || null,
    startedAt: item.startedAt || null,
    completedAt: item.completedAt || null,
    logs: Array.isArray(item.logs) ? item.logs : []
  };
}

/**
 * BatchQueueStore manages persistent storage and state recovery for batch workflow jobs.
 */
export class BatchQueueStore {
  constructor(customFilePath = null) {
    this.filePath = customFilePath || BATCH_FILE;
    this.dataDir = path.dirname(this.filePath);
    this.ensureDataDir();
    this.jobs = this.loadJobs();
  }

  ensureDataDir() {
    if (!fs.existsSync(this.dataDir)) {
      try {
        fs.mkdirSync(this.dataDir, { recursive: true });
      } catch {}
    }
  }

  loadJobs() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        return JSON.parse(raw);
      }
    } catch (err) {
      console.warn(`[BatchQueueStore] Initializing empty store from ${this.filePath}:`, err.message);
    }
    return [];
  }

  saveJobs() {
    this.ensureDataDir();
    const tempFile = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
    const data = JSON.stringify(this.jobs, null, 2);
    try {
      fs.writeFileSync(tempFile, data, "utf-8");
      let renamed = false;
      for (let i = 0; i < 5; i++) {
        try {
          fs.renameSync(tempFile, this.filePath);
          renamed = true;
          break;
        } catch {
          const end = Date.now() + 20;
          while (Date.now() < end) {}
        }
      }
      if (!renamed) {
        fs.writeFileSync(this.filePath, data, "utf-8");
        try { fs.unlinkSync(tempFile); } catch {}
      }
    } catch (err) {
      if (fs.existsSync(tempFile)) {
        try { fs.unlinkSync(tempFile); } catch {}
      }
      console.error(`[BatchQueueStore] Atomic write failed:`, err.message);
      throw err;
    }
  }

  createBatchJob({ workflowId, workflow, items = [], browserConfig = {}, settings = {} }) {
    if (!workflowId || !workflow) {
      throw new Error("A valid workflow definition and workflowId are required for batch jobs.");
    }

    // De-duplicate items within the batch using idempotencyKey
    const seenKeys = new Set();
    const normalizedItems = [];
    const duplicatesSkipped = [];

    items.forEach((raw, idx) => {
      const item = normalizeQueueItem(raw, workflowId, idx);
      if (seenKeys.has(item.idempotencyKey)) {
        duplicatesSkipped.push(item);
      } else {
        seenKeys.add(item.idempotencyKey);
        normalizedItems.push(item);
      }
    });

    if (normalizedItems.length === 0) {
      throw new Error("Batch queue cannot be empty after de-duplication.");
    }

    const id = `batch_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`;
    const now = new Date().toISOString();

    const batchJob = {
      id,
      workflowId,
      workflowName: workflow.name || "Custom Batch Workflow",
      workflow,
      browserConfig,
      settings: {
        maxConcurrency: 1, // Enforced safety: 1 browser session per job
        stopOnFirstFailure: Boolean(settings.stopOnFirstFailure),
        reconcileUncertain: settings.reconcileUncertain !== false,
        ...settings
      },
      status: "QUEUED",
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      pausedAt: null,
      totalCount: normalizedItems.length,
      processedCount: 0,
      currentIndex: -1,
      currentItemId: null,
      items: normalizedItems,
      duplicatesSkippedCount: duplicatesSkipped.length,
      summary: {
        total: normalizedItems.length,
        success: 0,
        failed: 0,
        skipped: 0,
        cancelled: 0,
        unknown: 0
      }
    };

    this.jobs.unshift(batchJob);
    this.saveJobs();
    return batchJob;
  }

  getJob(batchJobId) {
    return this.jobs.find(j => String(j.id) === String(batchJobId)) || null;
  }

  listJobs() {
    return this.jobs;
  }

  updateJob(batchJobId, updaterFn) {
    const job = this.getJob(batchJobId);
    if (!job) throw new Error(`Batch job #${batchJobId} not found.`);
    updaterFn(job);
    job.updatedAt = new Date().toISOString();
    this.saveJobs();
    return job;
  }

  updateItemStatus(batchJobId, itemId, status, details = {}) {
    return this.updateJob(batchJobId, (job) => {
      const item = job.items.find(i => String(i.id) === String(itemId));
      if (!item) return;

      item.status = status;
      if (status === BatchItemStatus.RUNNING && !item.startedAt) {
        item.startedAt = new Date().toISOString();
      }
      if ([BatchItemStatus.SUCCESS, BatchItemStatus.FAILED, BatchItemStatus.SKIPPED, BatchItemStatus.CANCELLED, BatchItemStatus.UNKNOWN].includes(status)) {
        item.completedAt = new Date().toISOString();
      }

      if (details.failureReason) item.failureReason = details.failureReason;
      if (details.uncertainReason) item.uncertainReason = details.uncertainReason;
      if (typeof details.attempts === "number") item.attempts = details.attempts;
      if (details.log) item.logs.push(`[${new Date().toISOString()}] ${details.log}`);

      // Recalculate summary
      job.summary.success = job.items.filter(i => i.status === BatchItemStatus.SUCCESS).length;
      job.summary.failed = job.items.filter(i => i.status === BatchItemStatus.FAILED).length;
      job.summary.skipped = job.items.filter(i => i.status === BatchItemStatus.SKIPPED).length;
      job.summary.cancelled = job.items.filter(i => i.status === BatchItemStatus.CANCELLED).length;
      job.summary.unknown = job.items.filter(i => i.status === BatchItemStatus.UNKNOWN).length;
      job.processedCount = job.summary.success + job.summary.failed + job.summary.skipped + job.summary.cancelled + job.summary.unknown;
    });
  }
}
