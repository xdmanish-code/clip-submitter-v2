import { JobStatus, ClipState } from "../../shared/states.js";
import { HistoryStore } from "./history-store.js";
import { WorkflowStore } from "./workflow-store.js";
import { BatchQueueStore } from "../../automation/workflow/batch-queue-store.js";
import crypto from "crypto";

export class JobManager {
  constructor() {
    this.historyStore = new HistoryStore();
    this.workflowStore = new WorkflowStore();
    this.batchStore = new BatchQueueStore();
    this.agentSocket = null;
    this.agentInfo = null;
    this.activeJob = null;
    this.activeRecording = null;
    this.pendingCorrelations = new Map();
    this.clientSockets = new Set();
  }

  // Agent Connection Management
  setAgentSocket(ws, info = {}) {
    this.agentSocket = ws;
    this.agentInfo = {
      ...info,
      connectedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString()
    };
    this.broadcastToClients("AGENT_STATUS", {
      online: true,
      agent: this.agentInfo
    });
  }

  clearAgentSocket() {
    this.agentSocket = null;
    this.agentInfo = null;
    this.broadcastToClients("AGENT_STATUS", {
      online: false,
      agent: null
    });
  }

  isAgentOnline() {
    return Boolean(this.agentSocket && this.agentSocket.readyState === 1);
  }

  getAgentStatus() {
    return {
      online: this.isAgentOnline(),
      agent: this.agentInfo,
      activeJobId: this.activeJob?.id || null
    };
  }

  updateHeartbeat(payload = {}) {
    if (this.agentInfo) {
      this.agentInfo.lastHeartbeat = new Date().toISOString();
      this.agentInfo.status = payload.status || "IDLE";
    }
  }

  // Client WebSockets
  addClientSocket(ws) {
    this.clientSockets.add(ws);
    // Send initial status
    ws.send(JSON.stringify({
      type: "INIT_STATE",
      payload: {
        agent: this.getAgentStatus(),
        activeJob: this.activeJob,
        activeRecording: this.activeRecording,
        workflows: this.workflowStore.listWorkflows("default"),
        history: this.historyStore.getAll().slice(0, 20)
      }
    }));
  }

  removeClientSocket(ws) {
    this.clientSockets.delete(ws);
  }

  broadcastToClients(type, payload = {}) {
    const msg = JSON.stringify({
      type,
      payload,
      timestamp: new Date().toISOString()
    });

    for (const client of this.clientSockets) {
      if (client.readyState === 1) {
        client.send(msg);
      }
    }
  }

  // Agent Communication (RPC pattern)
  sendToAgent(type, payload = {}, timeoutMs = 25000) {
    if (!this.isAgentOnline()) {
      return Promise.reject(new Error("Local Desktop Agent is offline. Please start the agent first."));
    }

    const correlationId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCorrelations.delete(correlationId);
        reject(new Error(`Agent request (${type}) timed out after ${timeoutMs / 1000}s.`));
      }, timeoutMs);

      this.pendingCorrelations.set(correlationId, { resolve, reject, timer });

      this.agentSocket.send(JSON.stringify({
        type,
        payload,
        correlationId
      }));
    });
  }

  handleAgentResponse(type, payload = {}) {
    const { correlationId } = payload;
    if (correlationId && this.pendingCorrelations.has(correlationId)) {
      const { resolve, timer } = this.pendingCorrelations.get(correlationId);
      clearTimeout(timer);
      this.pendingCorrelations.delete(correlationId);
      resolve(payload);
    }
  }

  // Action: Test browser
  async testBrowser(browserConfig) {
    const result = await this.sendToAgent("TEST_BROWSER", { browserConfig }, 15000);
    return result;
  }

  // Action: Preview queue
  async previewQueue({ submissionType, browserConfig, websiteUrl }) {
    const result = await this.sendToAgent("LOAD_QUEUE_PREVIEW", {
      submissionType,
      browserConfig,
      websiteUrl
    }, 45000);
    return result;
  }

  // ==========================================
  // RECORDER ACTIONS & RPC
  // ==========================================

  getRecordingStatus() {
    return this.activeRecording;
  }

  async startRecording({ browserConfig = {}, permittedDomains = [] } = {}) {
    if (this.activeRecording && this.activeRecording.status === "RECORDING") {
      throw new Error("A browser recording session is already active.");
    }

    const result = await this.sendToAgent("START_RECORDING", { browserConfig, permittedDomains }, 20000);
    if (result.success === false) {
      throw new Error(result.error || "Failed to start browser recording.");
    }

    this.activeRecording = {
      sessionId: result.sessionId,
      status: "RECORDING",
      startedAt: new Date().toISOString(),
      stepsCount: 0
    };
    this.broadcastToClients("RECORDING_STARTED", result);
    return result;
  }

  async pauseRecording() {
    if (!this.activeRecording) {
      throw new Error("No active recording session to pause.");
    }
    const result = await this.sendToAgent("PAUSE_RECORDING", {}, 10000);
    if (result.success === false) {
      throw new Error(result.error || "Failed to pause recording.");
    }
    this.activeRecording.status = "PAUSED";
    this.broadcastToClients("RECORDING_PAUSED", result);
    return result;
  }

  async resumeRecording() {
    if (!this.activeRecording) {
      throw new Error("No active recording session to resume.");
    }
    const result = await this.sendToAgent("RESUME_RECORDING", {}, 10000);
    if (result.success === false) {
      throw new Error(result.error || "Failed to resume recording.");
    }
    this.activeRecording.status = "RECORDING";
    this.broadcastToClients("RECORDING_RESUMED", result);
    return result;
  }

  async stopRecording() {
    if (!this.activeRecording) {
      return { status: "STOPPED", steps: [] };
    }
    const result = await this.sendToAgent("STOP_RECORDING", {}, 15000);
    this.activeRecording = null;
    this.broadcastToClients("RECORDING_STOPPED", result);
    return result;
  }

  async addRecorderWait({ durationMs = 5000, comment = "" } = {}) {
    const result = await this.sendToAgent("ADD_RECORDER_WAIT", { durationMs, comment }, 5000);
    return result;
  }

  async addRecorderComment({ text = "" } = {}) {
    const result = await this.sendToAgent("ADD_RECORDER_COMMENT", { text }, 5000);
    return result;
  }

  handleRecorderEvent(type, payload = {}) {
    switch (type) {
      case "RECORDING_STARTED":
        this.activeRecording = {
          sessionId: payload.sessionId,
          status: "RECORDING",
          startedAt: payload.timestamp || new Date().toISOString(),
          stepsCount: 0
        };
        break;
      case "RECORDING_PAUSED":
        if (this.activeRecording) this.activeRecording.status = "PAUSED";
        break;
      case "RECORDING_RESUMED":
        if (this.activeRecording) this.activeRecording.status = "RECORDING";
        break;
      case "RECORDING_STOPPED":
        this.activeRecording = null;
        break;
      case "RECORDED_STEP":
        if (this.activeRecording) {
          this.activeRecording.stepsCount = (this.activeRecording.stepsCount || 0) + 1;
        }
        break;
    }
    this.broadcastToClients(type, payload);
  }

  // Action: Start Job
  async startJob({ submissionType, browserConfig, websiteUrl, discordUrl, queueOverride = null, reels = null }) {
    if (this.activeJob && (this.activeJob.status === JobStatus.PROCESSING || this.activeJob.status === JobStatus.STARTING)) {
      throw new Error(`A job (#${this.activeJob.id}) is already currently running.`);
    }

    const reelsList = reels || queueOverride || [];

    if (submissionType === "kick") {
      if (reelsList.length === 0) {
        throw new Error("No reels selected or loaded in Kick queue.");
      }
      const missingCreators = reelsList.filter(r => !r.creator);
      if (missingCreators.length > 0) {
        throw new Error(`${missingCreators.length} selected reel${missingCreators.length > 1 ? 's are' : ' is'} missing a Creator.`);
      }
      console.log(`[JOB] Kick job payload reels: ${reelsList.length}`);
    }

    const jobId = Math.floor(1000 + Math.random() * 9000);
    const job = {
      id: jobId,
      submissionType,
      browserConfig,
      websiteUrl,
      discordUrl,
      queue: reelsList,
      reels: reelsList,
      queueOverride: reelsList,
      totalCount: reelsList.length,
      processedCount: 0,
      currentClip: null,
      currentStep: "Job initialized",
      currentStepDetail: "",
      status: JobStatus.STARTING,
      logs: [],
      createdAt: new Date().toISOString(),
      summary: {
        total: reelsList.length,
        success: 0,
        already: 0,
        failed: 0
      }
    };

    this.activeJob = job;
    this.historyStore.addOrUpdate(job);

    this.broadcastToClients("JOB_STARTED", { job });

    // Send command to agent with both job and explicit reels arrays
    this.sendToAgent("START_JOB", {
      job,
      reels: reelsList,
      queueOverride: reelsList
    }).catch(err => {
      this.handleJobFailed(jobId, err.message);
    });

    return job;
  }

  // Action: Start Single-Item Workflow Test Job
  async startWorkflowTestJob({ workflow, clipData, browserConfig }) {
    if (this.activeJob && (this.activeJob.status === JobStatus.PROCESSING || this.activeJob.status === JobStatus.STARTING)) {
      throw new Error(`A job (#${this.activeJob.id}) is already currently running.`);
    }

    const jobId = Math.floor(1000 + Math.random() * 9000);
    const testClip = clipData || {
      reel_url: "https://instagram.com/reel/preview",
      creator_name: "TestCreator",
      clip_id: "TEST_001"
    };

    const job = {
      id: jobId,
      submissionType: "workflow",
      browserConfig: browserConfig || {},
      workflow,
      clipData: testClip,
      queue: [testClip],
      reels: [testClip],
      queueOverride: [testClip],
      totalCount: 1,
      processedCount: 0,
      currentClip: testClip,
      currentStep: "Starting single-item test execution",
      currentStepDetail: workflow.name || "Custom Workflow",
      status: JobStatus.STARTING,
      logs: [],
      createdAt: new Date().toISOString(),
      summary: { total: 1, success: 0, already: 0, failed: 0 }
    };

    this.activeJob = job;
    this.historyStore.addOrUpdate(job);
    this.broadcastToClients("JOB_STARTED", { job });

    this.sendToAgent("START_JOB", {
      job,
      reels: [testClip],
      queueOverride: [testClip]
    }).catch(err => {
      this.handleJobFailed(jobId, err.message);
    });

    return job;
  }

  // Action: Start Batch Workflow Execution Job
  async startBatchWorkflowJob({ workflowId, workflow, items, browserConfig, settings = {} }) {
    if (this.activeJob && (this.activeJob.status === JobStatus.PROCESSING || this.activeJob.status === JobStatus.STARTING)) {
      throw new Error(`A job (#${this.activeJob.id}) is already currently running. Concurrency limit is 1 browser session.`);
    }

    // Persist queue job in batch store
    const batchJob = this.batchStore.createBatchJob({
      workflowId,
      workflow,
      items,
      browserConfig,
      settings
    });

    const jobId = batchJob.id;
    const job = {
      id: jobId,
      submissionType: "batch_workflow",
      batchJobId: batchJob.id,
      workflowId,
      workflow,
      browserConfig: browserConfig || {},
      queue: batchJob.items,
      reels: batchJob.items,
      totalCount: batchJob.items.length,
      processedCount: 0,
      currentClip: batchJob.items[0] || null,
      currentStep: "Batch Job Initialized",
      currentStepDetail: `Workflow: ${workflow.name} (${batchJob.items.length} items)`,
      status: JobStatus.STARTING,
      logs: [],
      createdAt: new Date().toISOString(),
      summary: batchJob.summary
    };

    this.activeJob = job;
    this.historyStore.addOrUpdate(job);
    this.broadcastToClients("JOB_STARTED", { job });
    this.broadcastToClients("BATCH_JOB_CREATED", { batchJob });

    this.sendToAgent("START_JOB", {
      job,
      batchJobId: batchJob.id,
      reels: batchJob.items,
      queueOverride: batchJob.items
    }).catch(err => {
      this.handleJobFailed(jobId, err.message);
    });

    return { job, batchJob };
  }

  // Action: Pause Batch Job
  async pauseBatchJob(batchJobId) {
    if (!this.activeJob || String(this.activeJob.id) !== String(batchJobId)) {
      throw new Error(`Batch job #${batchJobId} is not currently running.`);
    }
    const result = await this.sendToAgent("PAUSE_BATCH_JOB", { batchJobId }, 5000);
    this.broadcastToClients("BATCH_JOB_PAUSED", { batchJobId });
    return result;
  }

  // Action: Resume Batch Job
  async resumeBatchJob(batchJobId) {
    if (!this.activeJob || String(this.activeJob.id) !== String(batchJobId)) {
      throw new Error(`Batch job #${batchJobId} is not currently running.`);
    }
    const result = await this.sendToAgent("RESUME_BATCH_JOB", { batchJobId }, 5000);
    this.broadcastToClients("BATCH_JOB_RESUMED", { batchJobId });
    return result;
  }

  // Action: Cancel Job
  async cancelJob(jobId) {
    if (!this.activeJob || String(this.activeJob.id) !== String(jobId)) {
      throw new Error(`Job #${jobId} is not active.`);
    }

    this.activeJob.status = JobStatus.CANCELLED;
    this.activeJob.currentStep = "Cancelling job...";

    await this.sendToAgent("CANCEL_JOB", { jobId }, 10000).catch(() => {});
    this.broadcastToClients("JOB_CANCELLED", { jobId });
    this.historyStore.addOrUpdate(this.activeJob);
    return { success: true, message: `Cancellation signal sent for Job #${jobId}` };
  }

  // Events from Agent
  handleJobStatusUpdate(jobId, status) {
    if (this.activeJob && String(this.activeJob.id) === String(jobId)) {
      this.activeJob.status = status;
      this.historyStore.addOrUpdate(this.activeJob);
      this.broadcastToClients("JOB_STATUS_UPDATE", { jobId, status });
    }
  }

  handleJobStep(jobId, step, detail) {
    if (this.activeJob && String(this.activeJob.id) === String(jobId)) {
      this.activeJob.currentStep = step;
      this.activeJob.currentStepDetail = detail;
      this.broadcastToClients("JOB_STEP", { jobId, step, detail });
    }
  }

  handleJobLog(jobId, message) {
    const logEntry = {
      timestamp: new Date().toLocaleTimeString(),
      message
    };

    if (this.activeJob && (!jobId || String(this.activeJob.id) === String(jobId))) {
      this.activeJob.logs.push(logEntry);
      if (this.activeJob.logs.length > 300) {
        this.activeJob.logs.shift();
      }
    }

    this.broadcastToClients("JOB_LOG", { jobId, log: logEntry });
  }

  handleJobClipUpdate(jobId, clip, progress) {
    if (this.activeJob && String(this.activeJob.id) === String(jobId)) {
      this.activeJob.currentClip = clip;
      this.activeJob.processedCount = progress.current;
      this.activeJob.totalCount = progress.total;

      // Update in queue array
      const idx = this.activeJob.queue.findIndex(c => c.instagramLink === clip.instagramLink || c.id === clip.id);
      if (idx >= 0) {
        this.activeJob.queue[idx] = clip;
      } else {
        this.activeJob.queue.push(clip);
      }

      this.historyStore.addOrUpdate(this.activeJob);
      this.broadcastToClients("JOB_CLIP_UPDATE", { jobId, clip, progress, queue: this.activeJob.queue });
    }
  }

  handleJobCompleted(jobId, result) {
    if (this.activeJob && String(this.activeJob.id) === String(jobId)) {
      this.activeJob.status = result.status || JobStatus.COMPLETED;
      this.activeJob.queue = result.queue || this.activeJob.queue;
      this.activeJob.summary = result.summary || this.activeJob.summary;
      this.activeJob.currentStep = "Completed";
      this.activeJob.completedAt = new Date().toISOString();

      this.historyStore.addOrUpdate(this.activeJob);
      this.broadcastToClients("JOB_COMPLETED", { jobId, job: this.activeJob, result });
      this.activeJob = null;
    }
  }

  handleJobFailed(jobId, error, status = JobStatus.FAILED) {
    if (this.activeJob && String(this.activeJob.id) === String(jobId)) {
      this.activeJob.status = status;
      this.activeJob.error = error;
      this.activeJob.currentStep = `Failed: ${error}`;
      this.activeJob.completedAt = new Date().toISOString();

      this.historyStore.addOrUpdate(this.activeJob);
      this.broadcastToClients("JOB_FAILED", { jobId, job: this.activeJob, error, status });
      this.activeJob = null;
    }
  }
}
