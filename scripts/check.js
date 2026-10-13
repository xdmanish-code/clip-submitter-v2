#!/usr/bin/env node

/**
 * Clip Submitter V2 — System Health & Pre-flight Diagnostics Checklist
 * Performs a non-destructive check of environment, ports, permissions,
 * dependencies, and browser availability without running any submissions.
 */

import fs from "fs";
import path from "path";
import os from "os";
import net from "net";
import http from "http";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { discoverBrowsers } from "../agent/browser-discovery.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

// Load environment config
const envPath = path.join(ROOT_DIR, ".env");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

console.log("\n=======================================================");
console.log(" CLIP SUBMITTER V2 — SYSTEM PRE-FLIGHT CHECKLIST");
console.log("=======================================================\n");

let criticalFailures = 0;
let warnings = 0;

function pass(msg) {
  console.log(`  [PASS] ${msg}`);
}

function warn(msg) {
  warnings++;
  console.log(`  [WARN] ${msg}`);
}

function fail(msg) {
  criticalFailures++;
  console.log(`  [FAIL] ${msg}`);
}

function info(msg) {
  console.log(`  [INFO] ${msg}`);
}

// Helper: Check if a local TCP port is in use
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

// Helper: Probe HTTP endpoint
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

// 1. RUNTIME & SYSTEM
console.log("1. Runtime & Environment:");
const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
if (nodeMajor >= 18) {
  pass(`Node.js version: ${process.version} (>= 18.0.0 required)`);
} else {
  fail(`Node.js version: ${process.version} is unsupported. Please install Node.js >= 18.`);
}

const osPlatform = process.platform;
const osName = osPlatform === "win32" ? "Windows" : osPlatform === "darwin" ? "macOS" : "Linux";
pass(`Operating System: ${osName} (${process.arch})`);

// 2. PROJECT DEPENDENCIES
console.log("\n2. Project Dependencies:");
const requiredDependencies = ["express", "playwright", "ws", "cors", "dotenv"];
let missingDeps = [];
for (const dep of requiredDependencies) {
  if (!fs.existsSync(path.join(ROOT_DIR, "node_modules", dep))) {
    missingDeps.push(dep);
  }
}
if (missingDeps.length === 0) {
  pass(`All required packages installed in node_modules`);
} else {
  fail(`Missing packages: ${missingDeps.join(", ")}. Run 'npm install'.`);
}

// 3. STORAGE & DATA PERMISSIONS
console.log("\n3. Data & Storage Structure:");
const dataDir = path.join(ROOT_DIR, "data");
const screenshotsDir = path.join(ROOT_DIR, "data", "screenshots");

try {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
  
  // Test write permission
  const testFile = path.join(dataDir, ".perm-test.tmp");
  fs.writeFileSync(testFile, "ok", "utf8");
  fs.unlinkSync(testFile);
  pass(`Directory data/ is writable`);
} catch (err) {
  fail(`Data directory permission error: ${err.message}`);
}

const workflowsPath = path.join(dataDir, "workflows.json");
if (fs.existsSync(workflowsPath)) {
  try {
    const raw = fs.readFileSync(workflowsPath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      pass(`Workflow storage valid (${parsed.length} workflow(s) found)`);
    } else {
      warn(`workflows.json exists but does not contain an array`);
    }
  } catch (err) {
    warn(`workflows.json contains invalid JSON: ${err.message}`);
  }
} else {
  info(`workflows.json not yet created (will initialize on first save)`);
}

// 4. CONFIGURATION
console.log("\n4. Configuration (.env):");
if (fs.existsSync(envPath)) {
  pass(`.env configuration file found`);
  const dryRun = process.env.DRY_RUN;
  if (dryRun === "false") {
    warn(`DRY_RUN is set to 'false' (live submissions enabled)`);
  } else {
    pass(`DRY_RUN is enabled (safe testing mode active)`);
  }
} else {
  warn(`.env file missing. Run 'npm run setup' to create from template.`);
}

// 5. NETWORK PORTS
console.log("\n5. Network Ports:");
const targetPort = Number(process.env.PORT || 4000);
const portInUse = await checkPortInUse(targetPort);

if (!portInUse) {
  pass(`Dashboard & Backend port ${targetPort} is available`);
} else {
  // Check if it's our own instance already running
  const probe = await probeHttp(`http://127.0.0.1:${targetPort}/api/agent/status`);
  if (probe.ok) {
    info(`Port ${targetPort} is currently occupied by an active Clip Submitter V2 instance`);
  } else {
    warn(`Port ${targetPort} is in use by another process. Set PORT in .env if needed.`);
  }
}

// 6. BROWSER READINESS
console.log("\n6. Browser Readiness:");
try {
  const browsers = await discoverBrowsers();
  const available = browsers.filter(b => b.available);

  if (available.length > 0) {
    pass(`Detected ${available.length} installed browser(s):`);
    for (const b of available) {
      console.log(`         - ${b.name}: ${b.executablePath}`);
    }
  } else {
    warn(`No standard Chrome, Edge, or Brave installations detected in common paths.`);
  }
} catch (err) {
  warn(`Browser detection failed: ${err.message}`);
}

// Check remote debugging port (9222)
const debugPortInUse = await checkPortInUse(9222);
if (debugPortInUse) {
  const cdpProbe = await probeHttp(`http://127.0.0.1:9222/json/version`);
  if (cdpProbe.ok) {
    pass(`Browser running with remote debugging on port 9222 (ready for instant connection)`);
  } else {
    info(`Port 9222 is occupied (CDP probe returned status: ${cdpProbe.statusCode || "unknown"})`);
  }
} else {
  info(`Remote debugging port 9222 is not currently open.`);
  console.log(`         (Start your browser with --remote-debugging-port=9222 or use dedicated profile mode)`);
}

// SUMMARY
console.log("\n=======================================================");
if (criticalFailures === 0 && warnings === 0) {
  console.log(" ALL SYSTEM CHECKS PASSED — READY FOR LAUNCH!");
  console.log("=======================================================");
  console.log("\nYou can start the application with:");
  console.log("  npm start\n");
  process.exit(0);
} else if (criticalFailures === 0) {
  console.log(` CHECKS PASSED WITH ${warnings} WARNING(S)`);
  console.log("=======================================================");
  console.log("\nYou can still start the application with:");
  console.log("  npm start\n");
  process.exit(0);
} else {
  console.error(` FAILED: ${criticalFailures} CRITICAL ERROR(S) DETECTED`);
  console.log("=======================================================");
  console.log("\nPlease resolve the issues above before starting.\n");
  process.exit(1);
}
