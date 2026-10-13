import WebSocket from "ws";
import os from "os";
import { discoverBrowsers, validateCustomPath } from "./browser-discovery.js";
import { BrowserManager } from "./browser-manager.js";
import { JobRunner } from "./job-runner.js";
import { RecorderEngine } from "../automation/recorder/recorder-engine.js";
import "dotenv/config";

const BACKEND_WS_URL = process.env.BACKEND_WS_URL || "ws://127.0.0.1:4000/agent-ws";
const AGENT_ID = process.env.AGENT_ID || `agent-${os.hostname()}-${process.pid}`;
const AGENT_TOKEN = process.env.AGENT_TOKEN || "local-agent-secret";

const BUILD_VERSION = "v2.3.0-TEACH-MODE-RECORDER";

console.log("==================================================");
console.log(" CLIP SUBMITTER V2 — LOCAL DESKTOP AGENT");
console.log(` Build Version:  ${BUILD_VERSION}`);
console.log("==================================================");
console.log(`Agent ID:       ${AGENT_ID}`);
console.log(`Host / OS:      ${os.hostname()} (${process.platform})`);
console.log(`Backend Server: ${BACKEND_WS_URL}`);
console.log(`[Kick Modules] Loaded from:`);
console.log(`  - Command Selector: ${new URL('../automation/kick/command-selector.js', import.meta.url).pathname}`);
console.log(`  - Discord Kick:     ${new URL('../automation/kick/discord-kick.js', import.meta.url).pathname}`);
console.log(`[Recorder Engine] Loaded: ${new URL('../automation/recorder/recorder-engine.js', import.meta.url).pathname}`);
console.log("==================================================\n");

process.on("uncaughtException", (err) => {
  console.error("[Agent Process] Uncaught Exception:", err.message);
});

process.on("unhandledRejection", (reason) => {
  console.error("[Agent Process] Unhandled Rejection:", reason);
});

const browserManager = new BrowserManager();
const jobRunner = new JobRunner(browserManager);
const recorderEngine = new RecorderEngine(browserManager);

// Wire recorder events to backend WebSocket
recorderEngine.on("recording_started", (ev) => send("RECORDING_STARTED", ev));
recorderEngine.on("recording_paused", (ev) => send("RECORDING_PAUSED", ev));
recorderEngine.on("recording_resumed", (ev) => send("RECORDING_RESUMED", ev));
recorderEngine.on("recorded_step", (ev) => send("RECORDED_STEP", ev));
recorderEngine.on("recording_stopped", (ev) => send("RECORDING_STOPPED", ev));
recorderEngine.on("recording_error", (ev) => send("RECORDING_ERROR", ev));

let ws = null;
let reconnectTimer = null;
let heartbeatTimer = null;

async function send(type, payload = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, payload, timestamp: new Date().toISOString() }));
  }
}

async function connectToBackend() {
  if (reconnectTimer) clearTimeout(reconnectTimer);

  console.log(`Connecting to backend at ${BACKEND_WS_URL}...`);
  ws = new WebSocket(BACKEND_WS_URL, {
    headers: {
      "x-agent-token": AGENT_TOKEN,
      "x-agent-id": AGENT_ID
    }
  });

  ws.on("open", async () => {
    console.log("Connected to Clip Submitter Web Backend!");

    const detectedBrowsers = await discoverBrowsers();

    await send("AGENT_HANDSHAKE", {
      agentId: AGENT_ID,
      hostname: os.hostname(),
      platform: process.platform,
      browsers: detectedBrowsers,
      status: "IDLE"
    });

    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      send("HEARTBEAT", {
        status: jobRunner.currentJob ? "BUSY" : "IDLE",
        currentJobId: jobRunner.currentJob?.id || null
      });
    }, 5000);
  });

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      await handleBackendMessage(msg);
    } catch (err) {
      console.error("Error handling backend message:", err.message);
    }
  });

  ws.on("close", (code, reason) => {
    console.warn(`Disconnected from backend (${code}: ${reason || "No reason"}). Reconnecting in 3s...`);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    reconnectTimer = setTimeout(connectToBackend, 3000);
  });

  ws.on("error", (err) => {
    console.warn(`WebSocket error: ${err.message}`);
  });
}

async function handleBackendMessage(message) {
  const { type, payload = {}, correlationId } = message;

  switch (type) {
    case "GET_BROWSERS": {
      const browsers = await discoverBrowsers();
      send("BROWSERS_LIST", { correlationId, browsers });
      break;
    }

    case "TEST_BROWSER": {
      const testResult = await browserManager.testConnection(payload.browserConfig || {});
      send("TEST_BROWSER_RESULT", { correlationId, ...testResult });
      break;
    }

    case "LOAD_QUEUE_PREVIEW": {
      const { submissionType, browserConfig, websiteUrl } = payload;
      try {
        const result = await jobRunner.loadQueuePreview({
          submissionType,
          browserConfig,
          websiteUrl,
          emitLog: (msg) => {
            send("JOB_LOG", { correlationId, message: msg });
          },
          emitStep: (step, detail) => {
            send("JOB_STEP", { correlationId, step, detail });
          }
        });
        send("QUEUE_PREVIEW_RESULT", {
          correlationId,
          success: true,
          queue: result.queue,
          totalRowCount: result.totalRowCount
        });
      } catch (err) {
        send("QUEUE_PREVIEW_RESULT", {
          correlationId,
          success: false,
          error: err.message
        });
      }
      break;
    }

    case "START_JOB": {
      const job = payload.job || {};
      const reels = payload.reels || payload.queueOverride || job.queue || job.reels || job.queueOverride || [];
      job.queue = reels;
      job.queueOverride = reels;
      job.reels = reels;
      console.log(`\n[Agent] START_JOB received: ID #${job.id}, Type: ${job.submissionType}, Reels: ${reels.length}`);
      if (job.submissionType === "kick") {
        console.log(`[Agent] Kick job received reels: ${reels.length}`);
      }
      send("START_JOB_ACK", { correlationId, success: true });
      runJobSafely(job);
      break;
    }

    case "CANCEL_JOB": {
      const cancelled = jobRunner.cancelCurrentJob();
      if (jobRunner.batchRunner && jobRunner.batchRunner.isJobActive()) {
        jobRunner.batchRunner.cancel();
      }
      send("JOB_CANCELLED_ACK", {
        jobId: payload.jobId,
        cancelled: true
      });
      break;
    }

    case "PAUSE_BATCH_JOB": {
      const paused = jobRunner.batchRunner ? jobRunner.batchRunner.pause() : false;
      send("PAUSE_BATCH_JOB_ACK", { correlationId, success: paused });
      break;
    }

    case "RESUME_BATCH_JOB": {
      const resumed = jobRunner.batchRunner ? jobRunner.batchRunner.resume() : false;
      send("RESUME_BATCH_JOB_ACK", { correlationId, success: resumed });
      break;
    }

    // ==========================================
    // RECORDER RPC HANDLERS
    // ==========================================

    case "START_RECORDING": {
      try {
        console.log("[Agent] START_RECORDING request received.");
        const session = await recorderEngine.startRecording({
          browserConfig: payload.browserConfig,
          permittedDomains: payload.permittedDomains
        });
        send("START_RECORDING_ACK", { correlationId, success: true, ...session });
      } catch (err) {
        console.error("[Agent] Error starting recording:", err.message);
        send("START_RECORDING_ACK", { correlationId, success: false, error: err.message });
      }
      break;
    }

    case "PAUSE_RECORDING": {
      try {
        const res = await recorderEngine.pauseRecording();
        send("PAUSE_RECORDING_ACK", { correlationId, success: true, ...res });
      } catch (err) {
        send("PAUSE_RECORDING_ACK", { correlationId, success: false, error: err.message });
      }
      break;
    }

    case "RESUME_RECORDING": {
      try {
        const res = await recorderEngine.resumeRecording();
        send("RESUME_RECORDING_ACK", { correlationId, success: true, ...res });
      } catch (err) {
        send("RESUME_RECORDING_ACK", { correlationId, success: false, error: err.message });
      }
      break;
    }

    case "STOP_RECORDING": {
      try {
        console.log("[Agent] STOP_RECORDING request received.");
        const res = await recorderEngine.stopRecording();
        send("STOP_RECORDING_ACK", { correlationId, success: true, ...res });
      } catch (err) {
        console.error("[Agent] Error stopping recording:", err.message);
        send("STOP_RECORDING_ACK", { correlationId, success: false, error: err.message });
      }
      break;
    }

    case "ADD_RECORDER_WAIT": {
      try {
        const step = recorderEngine.addWaitStep(payload.durationMs, payload.comment);
        send("ADD_RECORDER_WAIT_ACK", { correlationId, success: true, step });
      } catch (err) {
        send("ADD_RECORDER_WAIT_ACK", { correlationId, success: false, error: err.message });
      }
      break;
    }

    case "ADD_RECORDER_COMMENT": {
      try {
        const step = recorderEngine.addCommentStep(payload.text);
        send("ADD_RECORDER_COMMENT_ACK", { correlationId, success: true, step });
      } catch (err) {
        send("ADD_RECORDER_COMMENT_ACK", { correlationId, success: false, error: err.message });
      }
      break;
    }

    default:
      console.log("Unknown backend message type:", type);
  }
}

async function runJobSafely(job) {
  const jobId = job.id;
  try {
    await jobRunner.runJob(job, {
      onStatusUpdate: (status) => {
        send("JOB_STATUS_UPDATE", { jobId, status });
      },
      onStep: (step, detail) => {
        send("JOB_STEP", { jobId, step, detail });
      },
      onLog: (msg) => {
        console.log(msg);
        send("JOB_LOG", { jobId, message: msg });
      },
      onClipUpdate: (clip, progress) => {
        send("JOB_CLIP_UPDATE", { jobId, clip, progress });
      },
      onComplete: (result) => {
        send("JOB_COMPLETED", { jobId, result });
      },
      onError: (err, status) => {
        send("JOB_FAILED", { jobId, error: err.message, status });
      }
    });
  } catch (err) {
    console.error(`Job #${jobId} failed:`, err.message);
  }
}

// Start agent
connectToBackend();
