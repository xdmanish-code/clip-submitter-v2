import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

import { JobManager } from "./job-manager.js";
import { preflightValidateWorkflow } from "./workflow-store.js";
import { SubmissionTypeMetadata } from "../../shared/submission-types.js";
import { JobStatus, ClipState } from "../../shared/states.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 4000);
const AGENT_TOKEN = process.env.AGENT_TOKEN || "local-agent-secret";
const KICK_DISCORD_URL = process.env.KICK_DISCORD_URL || "";

const app = express();
const server = createServer(app);

app.use(cors());
app.use(express.json({ limit: "50mb" }));

const jobManager = new JobManager();

// Serve static frontend assets
const frontendDir = path.join(__dirname, "../frontend");
app.use(express.static(frontendDir));

// ==========================================
// REST API ROUTES
// ==========================================

// Get system & agent status
app.get("/api/agent/status", (req, res) => {
  res.json(jobManager.getAgentStatus());
});

// Get submission types
app.get("/api/submission-types", (req, res) => {
  res.json(SubmissionTypeMetadata);
});

// Get environment defaults for URLs
app.get("/api/config/defaults", (req, res) => {
  res.json({
    websiteUrl: process.env.WEBSITE_URL || "",
    discordUrl: process.env.DISCORD_URL || "",
    kickDiscordUrl: KICK_DISCORD_URL,
    dryRun: String(process.env.DRY_RUN ?? "true").toLowerCase() !== "false"
  });
});

// Test browser connection via Agent
app.post("/api/browser/test", async (req, res) => {
  try {
    const { browserConfig } = req.body;
    const result = await jobManager.testBrowser(browserConfig || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Preview pending queue from Cleanframe via Agent
app.post("/api/queue/preview", async (req, res) => {
  try {
    const { submissionType, browserConfig, websiteUrl } = req.body;
    const result = await jobManager.previewQueue({
      submissionType,
      browserConfig,
      websiteUrl: websiteUrl || process.env.WEBSITE_URL
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// DISCORD PROFILES & ACCOUNT ROUTING ROUTES
// ==========================================

// Get all Discord profiles
app.get("/api/discord-profiles", (req, res) => {
  res.json(jobManager.profileStore.getAllProfiles());
});

// Create new Discord profile
app.post("/api/discord-profiles", (req, res) => {
  try {
    const profile = jobManager.profileStore.createProfile(req.body);
    jobManager.broadcastToClients("DISCORD_PROFILES_UPDATED", {
      profiles: jobManager.profileStore.getAllProfiles()
    });
    res.json({ success: true, profile });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Update an existing Discord profile
app.put("/api/discord-profiles/:id", (req, res) => {
  try {
    const profile = jobManager.profileStore.updateProfile(req.params.id, req.body);
    jobManager.broadcastToClients("DISCORD_PROFILES_UPDATED", {
      profiles: jobManager.profileStore.getAllProfiles()
    });
    res.json({ success: true, profile });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Delete a Discord profile
app.delete("/api/discord-profiles/:id", (req, res) => {
  try {
    jobManager.profileStore.deleteProfile(req.params.id);
    jobManager.broadcastToClients("DISCORD_PROFILES_UPDATED", {
      profiles: jobManager.profileStore.getAllProfiles()
    });
    jobManager.broadcastToClients("ACCOUNT_MAPPINGS_UPDATED", {
      mappings: jobManager.profileStore.getAllMappings()
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Test connection and authentication of a Discord profile
app.post("/api/discord-profiles/:id/test", async (req, res) => {
  try {
    const { discordUrl } = req.body;
    const result = await jobManager.testDiscordProfile(req.params.id, discordUrl || process.env.DISCORD_URL);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Launch interactive browser window for manual sign-in
app.post("/api/discord-profiles/:id/launch", async (req, res) => {
  try {
    const { discordUrl } = req.body;
    const result = await jobManager.launchDiscordProfile(req.params.id, discordUrl || process.env.DISCORD_URL);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get all account-to-profile mappings
app.get("/api/account-mappings", (req, res) => {
  res.json(jobManager.profileStore.getAllMappings());
});

// Set / update account mapping
app.post("/api/account-mappings", (req, res) => {
  try {
    const { account, profileId } = req.body;
    const mapping = jobManager.profileStore.setMapping(account, profileId);
    jobManager.broadcastToClients("ACCOUNT_MAPPINGS_UPDATED", {
      mappings: jobManager.profileStore.getAllMappings()
    });
    res.json({ success: true, mapping });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Delete account mapping
app.delete("/api/account-mappings/:account", (req, res) => {
  try {
    const deleted = jobManager.profileStore.deleteMapping(req.params.account);
    jobManager.broadcastToClients("ACCOUNT_MAPPINGS_UPDATED", {
      mappings: jobManager.profileStore.getAllMappings()
    });
    res.json({ success: true, deleted });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Validate routing and return preflight summary for a loaded queue
app.post("/api/account-mappings/preflight", (req, res) => {
  try {
    const { queue } = req.body;
    const summary = jobManager.profileStore.validateQueueRouting(queue || []);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Discover accounts from loaded queue
app.post("/api/account-mappings/discover", (req, res) => {
  try {
    const { queue } = req.body;
    const discovered = new Set();
    for (const item of (queue || [])) {
      if (item.publishedOnAccount) {
        const cleanAcc = String(item.publishedOnAccount).trim();
        if (cleanAcc && cleanAcc.toLowerCase() !== "not published" && cleanAcc !== "-") {
          discovered.add(cleanAcc.startsWith("@") ? cleanAcc.toLowerCase() : "@" + cleanAcc.toLowerCase());
        }
      }
    }
    res.json({ accounts: Array.from(discovered) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start a new job (Dual or Kick)
app.post("/api/jobs/start", async (req, res) => {
  try {
    const {
      submissionType,
      browserConfig,
      websiteUrl,
      discordUrl,
      queueOverride,
      reels
    } = req.body;

    const reelsData = reels || queueOverride || [];
    console.log(`\n[Backend] Received ${String(submissionType).toUpperCase()} job request with ${reelsData.length} reel(s).`);
    if (submissionType === "kick") {
      console.log(`[Backend] Received Kick reels: ${reelsData.length}`);
      reelsData.forEach((r, idx) => {
        console.log(`[Backend] Reel #${idx + 1}: URL=${r.url || r.clipUrl || r.instagramLink} | Creator=${r.creator}`);
      });
    }

    const job = await jobManager.startJob({
      submissionType,
      browserConfig,
      websiteUrl: websiteUrl || process.env.WEBSITE_URL,
      discordUrl: discordUrl || (submissionType === "kick" ? KICK_DISCORD_URL : process.env.DISCORD_URL),
      queueOverride: reelsData,
      reels: reelsData
    });

    res.json({ success: true, job });
  } catch (err) {
    console.error("[Backend] Error starting job:", err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Cancel an active job
app.post("/api/jobs/:id/cancel", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await jobManager.cancelJob(id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Get active or past job
app.get("/api/jobs/:id", (req, res) => {
  const { id } = req.params;
  if (jobManager.activeJob && String(jobManager.activeJob.id) === String(id)) {
    return res.json(jobManager.activeJob);
  }
  const job = jobManager.historyStore.getById(id);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  res.json(job);
});

// Get submission history
app.get("/api/history", (req, res) => {
  res.json(jobManager.historyStore.getAll());
});

// ==========================================
// WORKFLOW REST API ROUTES
// ==========================================

// List workflows
app.get("/api/workflows", (req, res) => {
  const workspaceId = req.query.workspaceId || "default";
  res.json({
    success: true,
    workflows: jobManager.workflowStore.listWorkflows(workspaceId)
  });
});

// Create workflow
app.post("/api/workflows", (req, res) => {
  try {
    const workspaceId = req.body.workspaceId || req.query.workspaceId || "default";
    const workflow = jobManager.workflowStore.createWorkflow(req.body, workspaceId);
    res.status(201).json({ success: true, workflow });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Get workflow by ID
app.get("/api/workflows/:id", (req, res) => {
  const workspaceId = req.query.workspaceId || "default";
  const workflow = jobManager.workflowStore.getWorkflow(req.params.id, workspaceId);
  if (!workflow) {
    return res.status(404).json({ success: false, error: `Workflow #${req.params.id} not found.` });
  }
  res.json({ success: true, workflow });
});

// Update workflow
app.put("/api/workflows/:id", (req, res) => {
  try {
    const workspaceId = req.body.workspaceId || req.query.workspaceId || "default";
    const workflow = jobManager.workflowStore.updateWorkflow(req.params.id, req.body, workspaceId);
    res.json({ success: true, workflow });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Publish workflow
app.post("/api/workflows/:id/publish", (req, res) => {
  try {
    const workspaceId = req.body?.workspaceId || req.query.workspaceId || "default";
    const workflow = jobManager.workflowStore.publishWorkflow(req.params.id, workspaceId);
    res.json({ success: true, workflow });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Validate arbitrary workflow payload preflight
app.post("/api/workflows/validate", (req, res) => {
  try {
    const availableVariables = req.body.availableVariables;
    const result = preflightValidateWorkflow(req.body.workflow || req.body, availableVariables);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Validate saved workflow by ID preflight
app.post("/api/workflows/:id/validate", (req, res) => {
  try {
    const workspaceId = req.query.workspaceId || "default";
    const workflow = jobManager.workflowStore.getWorkflow(req.params.id, workspaceId);
    if (!workflow) {
      return res.status(404).json({ success: false, error: `Workflow #${req.params.id} not found.` });
    }
    const availableVariables = req.body.availableVariables;
    const result = preflightValidateWorkflow(workflow, availableVariables);
    res.json({ success: true, workflowId: workflow.id, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Single-item safe test execution
app.post("/api/workflows/test-execute", async (req, res) => {
  try {
    const { workflow, clipData, browserConfig } = req.body;
    if (!workflow) {
      return res.status(400).json({ success: false, error: "Workflow definition is required." });
    }

    // Pre-flight check before execution
    const preflight = preflightValidateWorkflow(workflow);
    if (!preflight.valid) {
      return res.status(400).json({
        success: false,
        error: `Pre-flight validation failed: ${preflight.errors.join("; ")}`
      });
    }

    const job = await jobManager.startWorkflowTestJob({
      workflow,
      clipData,
      browserConfig
    });

    res.json({ success: true, job });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ==========================================
// BATCH WORKFLOW QUEUE REST API ROUTES
// ==========================================

// List batch jobs
app.get("/api/workflows/batch/jobs", (req, res) => {
  res.json({
    success: true,
    jobs: jobManager.batchStore.listJobs()
  });
});

// Get specific batch job
app.get("/api/workflows/batch/jobs/:id", (req, res) => {
  const job = jobManager.batchStore.getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ success: false, error: `Batch job #${req.params.id} not found.` });
  }
  res.json({ success: true, job });
});

// Start batch execution
app.post("/api/workflows/batch/start", async (req, res) => {
  try {
    const { workflowId, workflow, items, browserConfig, settings } = req.body;
    
    // Resolve workflow definition
    const targetWorkflow = workflow || jobManager.workflowStore.getWorkflow(workflowId);
    if (!targetWorkflow) {
      return res.status(400).json({ success: false, error: "Valid workflow definition or workflowId is required." });
    }

    // Pre-flight validate entire workflow
    const preflight = preflightValidateWorkflow(targetWorkflow);
    if (!preflight.valid) {
      return res.status(400).json({
        success: false,
        error: `Workflow pre-flight validation failed: ${preflight.errors.join("; ")}`
      });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: "Items array is required and must not be empty." });
    }

    const result = await jobManager.startBatchWorkflowJob({
      workflowId: targetWorkflow.id || workflowId || "custom_batch",
      workflow: targetWorkflow,
      items,
      browserConfig,
      settings
    });

    res.status(201).json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Pause batch execution
app.post("/api/workflows/batch/jobs/:id/pause", async (req, res) => {
  try {
    const result = await jobManager.pauseBatchJob(req.params.id);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Resume batch execution
app.post("/api/workflows/batch/jobs/:id/resume", async (req, res) => {
  try {
    const result = await jobManager.resumeBatchJob(req.params.id);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Delete draft workflow
app.delete("/api/workflows/:id", (req, res) => {
  try {
    const workspaceId = req.query.workspaceId || "default";
    const result = jobManager.workflowStore.deleteDraftWorkflow(req.params.id, workspaceId);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ==========================================
// RECORDER REST API ROUTES
// ==========================================

// Get recorder status
app.get("/api/recorder/status", (req, res) => {
  res.json({
    success: true,
    recording: jobManager.getRecordingStatus()
  });
});

// Start recording
app.post("/api/recorder/start", async (req, res) => {
  try {
    const { browserConfig, permittedDomains } = req.body || {};
    const result = await jobManager.startRecording({ browserConfig, permittedDomains });
    res.json({ success: true, session: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Pause recording
app.post("/api/recorder/pause", async (req, res) => {
  try {
    const result = await jobManager.pauseRecording();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Resume recording
app.post("/api/recorder/resume", async (req, res) => {
  try {
    const result = await jobManager.resumeRecording();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Stop recording
app.post("/api/recorder/stop", async (req, res) => {
  try {
    const result = await jobManager.stopRecording();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Add wait step
app.post("/api/recorder/wait", async (req, res) => {
  try {
    const { durationMs, comment } = req.body || {};
    const result = await jobManager.addRecorderWait({ durationMs, comment });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Add comment step
app.post("/api/recorder/comment", async (req, res) => {
  try {
    const { text } = req.body || {};
    const result = await jobManager.addRecorderComment({ text });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Fallback to index.html for SPA routes
app.use((req, res) => {
  res.sendFile(path.join(frontendDir, "index.html"));
});

// ==========================================
// WEBSOCKET SERVERS
// ==========================================

const wssAgent = new WebSocketServer({ noServer: true });
const wssClient = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);

  if (pathname === "/agent-ws") {
    wssAgent.handleUpgrade(request, socket, head, (ws) => {
      wssAgent.emit("connection", ws, request);
    });
  } else if (pathname === "/client-ws") {
    wssClient.handleUpgrade(request, socket, head, (ws) => {
      wssClient.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Handle Agent Connection
wssAgent.on("connection", (ws, req) => {
  const agentToken = req.headers["x-agent-token"];
  if (AGENT_TOKEN && agentToken !== AGENT_TOKEN) {
    console.warn("[Backend] Agent unauthorized connection attempt.");
    ws.close(4001, "Unauthorized");
    return;
  }

  console.log("[Backend] Local Agent connected via WebSocket.");

  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      const { type, payload = {} } = data;

      switch (type) {
        case "AGENT_HANDSHAKE":
          jobManager.setAgentSocket(ws, payload);
          break;

        case "HEARTBEAT":
          jobManager.updateHeartbeat(payload);
          break;

        case "BROWSERS_LIST":
        case "TEST_BROWSER_RESULT":
        case "QUEUE_PREVIEW_RESULT":
        case "JOB_CANCELLED_ACK":
        case "START_JOB_ACK":
        case "START_RECORDING_ACK":
        case "PAUSE_RECORDING_ACK":
        case "RESUME_RECORDING_ACK":
        case "STOP_RECORDING_ACK":
        case "ADD_RECORDER_WAIT_ACK":
        case "ADD_RECORDER_COMMENT_ACK":
          jobManager.handleAgentResponse(type, payload);
          break;

        case "RECORDING_STARTED":
        case "RECORDING_PAUSED":
        case "RECORDING_RESUMED":
        case "RECORDED_STEP":
        case "RECORDING_STOPPED":
        case "RECORDING_ERROR":
          jobManager.handleRecorderEvent(type, payload);
          break;

        case "JOB_STATUS_UPDATE":
          jobManager.handleJobStatusUpdate(payload.jobId, payload.status);
          break;

        case "JOB_STEP":
          jobManager.handleJobStep(payload.jobId, payload.step, payload.detail);
          break;

        case "JOB_LOG":
          jobManager.handleJobLog(payload.jobId, payload.message);
          break;

        case "JOB_CLIP_UPDATE":
          jobManager.handleJobClipUpdate(payload.jobId, payload.clip, payload.progress);
          break;

        case "JOB_COMPLETED":
          jobManager.handleJobCompleted(payload.jobId, payload.result);
          break;

        case "JOB_FAILED":
          jobManager.handleJobFailed(payload.jobId, payload.error, payload.status);
          break;

        default:
          console.log("[Backend] Unknown message from agent:", type);
      }
    } catch (err) {
      console.error("[Backend] Error processing agent message:", err.message);
    }
  });

  ws.on("close", () => {
    console.log("[Backend] Local Agent disconnected.");
    jobManager.clearAgentSocket();
  });

  ws.on("error", (err) => {
    console.warn("[Backend] Agent socket error:", err.message);
  });
});

// Handle Client Dashboard Connections
wssClient.on("connection", (ws) => {
  jobManager.addClientSocket(ws);

  ws.on("close", () => {
    jobManager.removeClientSocket(ws);
  });
});

// Start HTTP + WS Server
if (process.env.NODE_ENV !== "test") {
  server.listen(PORT, () => {
    console.log("==================================================");
    console.log(` CLIP SUBMITTER V2 — WEB DASHBOARD & BACKEND`);
    console.log("==================================================");
    console.log(` Web Dashboard: http://localhost:${PORT}`);
    console.log(` Agent WS:      ws://localhost:${PORT}/agent-ws`);
    console.log(` Client WS:     ws://localhost:${PORT}/client-ws`);
    console.log("==================================================\n");
  });
}

export { app, server, jobManager, wssAgent, wssClient };
