#!/usr/bin/env node

/**
 * Clip Submitter V2 — Unified Application Runner
 * Starts both the backend web server and the local agent process together seamlessly.
 * Monitors port availability, multiplexes logs, and handles graceful shutdown.
 */

import { spawn } from "child_process";
import path from "path";
import net from "net";
import http from "http";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

// Load environment variables
const envPath = path.join(ROOT_DIR, ".env");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const PORT = Number(process.env.PORT || 4000);

// ANSI Colors for readable log streaming
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

// Check if port is in use
function checkPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once("listening", () => {
      server.close();
      resolve(false);
    });
    server.listen(port, "127.0.0.1");
  });
}

// Probe HTTP endpoint
function probeHttp(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => resolve({ ok: true, statusCode: res.statusCode, data }));
    });
    req.on("error", () => resolve({ ok: false }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false });
    });
  });
}

// Stream and prefix child process logs
function streamOutput(stream, prefix, color) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop(); // Keep unfinished trailing chunk in buffer
    for (const line of lines) {
      if (line.trim().length > 0) {
        console.log(`${color}${prefix}${RESET} ${line}`);
      }
    }
  });
}

async function main() {
  console.log(`\n${BOLD}=======================================================${RESET}`);
  console.log(`${BOLD} CLIP SUBMITTER V2 — APPLICATION LAUNCHER${RESET}`);
  console.log(`${BOLD}=======================================================${RESET}\n`);

  // 1. Port conflict check
  const portOccupied = await checkPortInUse(PORT);
  if (portOccupied) {
    const probe = await probeHttp(`http://127.0.0.1:${PORT}/api/agent/status`);
    if (probe.ok) {
      console.log(`${YELLOW}[NOTICE] Clip Submitter V2 backend is already running on port ${PORT}!${RESET}`);
      console.log(`         Dashboard URL: ${BOLD}http://localhost:${PORT}${RESET}`);
      console.log(`         To run only the agent: ${BOLD}npm run agent${RESET}\n`);
    } else {
      console.error(`${RED}[ERROR] Port ${PORT} is currently in use by another application.${RESET}`);
      console.error(`        Please free port ${PORT} or configure a different port in .env (e.g. PORT=4001).\n`);
    }
    process.exit(1);
  }

  // 2. Start Backend Server
  console.log(`${CYAN}[Launcher] Starting Web Dashboard & Backend Server...${RESET}`);
  const backendPath = path.join(ROOT_DIR, "web", "backend", "server.js");
  const backendProc = spawn(process.execPath, [backendPath], {
    cwd: ROOT_DIR,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["pipe", "pipe", "pipe"]
  });

  streamOutput(backendProc.stdout, "[Backend]", CYAN);
  streamOutput(backendProc.stderr, "[Backend-Err]", RED);

  // 3. Start Local Agent
  console.log(`${MAGENTA}[Launcher] Starting Local Desktop Agent...${RESET}`);
  const agentPath = path.join(ROOT_DIR, "agent", "agent.js");
  const agentProc = spawn(process.execPath, [agentPath], {
    cwd: ROOT_DIR,
    env: { ...process.env, BACKEND_WS_URL: `ws://127.0.0.1:${PORT}/agent-ws` },
    stdio: ["pipe", "pipe", "pipe"]
  });

  streamOutput(agentProc.stdout, "[Agent]", MAGENTA);
  streamOutput(agentProc.stderr, "[Agent-Err]", RED);

  let bannerPrinted = false;

  const printReadyBanner = () => {
    if (bannerPrinted) return;
    bannerPrinted = true;
    console.log(`\n${GREEN}${BOLD}=======================================================${RESET}`);
    console.log(`${GREEN}${BOLD} CLIP SUBMITTER V2 IS READY!${RESET}`);
    console.log(`${GREEN}${BOLD}=======================================================${RESET}`);
    console.log(`  Web Dashboard: ${BOLD}http://localhost:${PORT}${RESET}`);
    console.log(`  Teach Mode:    Navigate to 'Workflow Builder' tab`);
    console.log(`  Local Agent:   Connected over WebSocket`);
    console.log(`${GREEN}${BOLD}=======================================================${RESET}`);
    console.log(`  Press ${BOLD}Ctrl+C${RESET} to gracefully stop all services.\n`);
  };

  // Wait a brief moment for startup and print banner
  setTimeout(printReadyBanner, 1500);

  // 4. Graceful Shutdown Management
  let isShuttingDown = false;
  const cleanup = (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n${YELLOW}[Launcher] Received ${signal}. Shutting down Clip Submitter V2...${RESET}`);

    const killProc = (proc, name) => {
      if (!proc || proc.killed) return;
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
        } else {
          proc.kill("SIGTERM");
        }
      } catch (err) {
        // ignore
      }
    };

    killProc(backendProc, "Backend");
    killProc(agentProc, "Agent");

    setTimeout(() => {
      console.log(`${GREEN}[Launcher] All processes terminated cleanly.${RESET}\n`);
      process.exit(0);
    }, 800);
  };

  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));

  backendProc.on("exit", (code) => {
    if (!isShuttingDown) {
      console.error(`${RED}[Launcher] Backend process exited unexpectedly with code ${code}.${RESET}`);
      cleanup("CHILD_EXIT");
    }
  });

  agentProc.on("exit", (code) => {
    if (!isShuttingDown) {
      console.warn(`${YELLOW}[Launcher] Agent process exited with code ${code}.${RESET}`);
    }
  });
}

main().catch((err) => {
  console.error(`${RED}[Launcher Fatal Error] ${err.message}${RESET}`);
  process.exit(1);
});
