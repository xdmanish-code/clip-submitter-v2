#!/usr/bin/env node

/**
 * Clip Submitter V2 — Guided Environment Setup
 * Validates dependencies, creates default directories & environment config,
 * detects installed browsers, and prepares the system for initial startup.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { discoverBrowsers } from "../agent/browser-discovery.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

console.log("\n=======================================================");
console.log(" CLIP SUBMITTER V2 — SYSTEM SETUP & INITIALIZATION");
console.log("=======================================================\n");

let hasWarnings = false;

// 1. Verify Node.js version (>= 18.0.0)
const nodeMajorVersion = parseInt(process.versions.node.split(".")[0], 10);
if (nodeMajorVersion < 18) {
  console.error(`[ERROR] Node.js version ${process.version} detected. Node.js >= 18.0.0 is required.`);
  process.exit(1);
} else {
  console.log(`[PASS] Node.js ${process.version} (supported: >= 18.0.0)`);
}

// 2. Check essential dependencies in node_modules
const requiredPackages = ["express", "playwright", "ws", "cors", "dotenv"];
let missingPkgs = [];
for (const pkg of requiredPackages) {
  const pkgPath = path.join(ROOT_DIR, "node_modules", pkg);
  if (!fs.existsSync(pkgPath)) {
    missingPkgs.push(pkg);
  }
}

if (missingPkgs.length > 0) {
  console.warn(`[WARN] Missing dependencies in node_modules: ${missingPkgs.join(", ")}`);
  console.warn("       Please run: npm install");
  hasWarnings = true;
} else {
  console.log(`[PASS] Core dependencies installed`);
}

// 3. Ensure required directories exist
const requiredDirs = [
  path.join(ROOT_DIR, "data"),
  path.join(ROOT_DIR, "data", "screenshots")
];

for (const dir of requiredDirs) {
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`[PASS] Created directory: ${path.relative(ROOT_DIR, dir)}/`);
    } catch (err) {
      console.error(`[ERROR] Failed to create directory ${dir}: ${err.message}`);
      hasWarnings = true;
    }
  } else {
    console.log(`[PASS] Verified directory: ${path.relative(ROOT_DIR, dir)}/`);
  }
}

// 4. Initialize .env file if missing
const envFile = path.join(ROOT_DIR, ".env");
const envExampleFile = path.join(ROOT_DIR, ".env.example");

if (!fs.existsSync(envFile)) {
  if (fs.existsSync(envExampleFile)) {
    try {
      fs.copyFileSync(envExampleFile, envFile);
      console.log("[PASS] Created default .env from .env.example");
      console.log("       Please inspect .env to review or customize your configuration.");
    } catch (err) {
      console.error(`[ERROR] Failed to create .env: ${err.message}`);
      hasWarnings = true;
    }
  } else {
    console.warn("[WARN] .env.example was not found. Please create a .env file manually.");
    hasWarnings = true;
  }
} else {
  console.log("[PASS] .env file already exists (preserved)");
}

// 5. Ensure starter data files exist
const workflowsFile = path.join(ROOT_DIR, "data", "workflows.json");
if (!fs.existsSync(workflowsFile)) {
  try {
    fs.writeFileSync(workflowsFile, JSON.stringify([], null, 2), "utf8");
    console.log("[PASS] Initialized data/workflows.json");
  } catch (err) {
    console.warn(`[WARN] Could not initialize workflows.json: ${err.message}`);
  }
} else {
  console.log("[PASS] Verified data/workflows.json exists");
}

const profilesFile = path.join(ROOT_DIR, "data", "discord_profiles.json");
if (!fs.existsSync(profilesFile)) {
  try {
    const defaultProfiles = [
      {
        id: "prof_default",
        name: "Discord Profile 1",
        mode: "dedicated",
        port: 9222,
        profileDir: null,
        status: "NOT_CONNECTED",
        statusMessage: "Profile initialized. Click Test or Open Browser to authenticate.",
        lastTestedAt: null,
        createdAt: new Date().toISOString()
      }
    ];
    fs.writeFileSync(profilesFile, JSON.stringify(defaultProfiles, null, 2), "utf8");
    console.log("[PASS] Initialized data/discord_profiles.json");
  } catch (err) {
    console.warn(`[WARN] Could not initialize discord_profiles.json: ${err.message}`);
  }
} else {
  console.log("[PASS] Verified data/discord_profiles.json exists");
}

const mappingsFile = path.join(ROOT_DIR, "data", "account_mappings.json");
if (!fs.existsSync(mappingsFile)) {
  try {
    fs.writeFileSync(mappingsFile, JSON.stringify({}, null, 2), "utf8");
    console.log("[PASS] Initialized data/account_mappings.json");
  } catch (err) {
    console.warn(`[WARN] Could not initialize account_mappings.json: ${err.message}`);
  }
} else {
  console.log("[PASS] Verified data/account_mappings.json exists");
}

// 6. Discover installed browsers
console.log("\nDetecting installed desktop browsers...");
try {
  const browsers = await discoverBrowsers();
  const available = browsers.filter(b => b.available);

  if (available.length > 0) {
    console.log(`[PASS] Found ${available.length} compatible browser(s):`);
    for (const b of available) {
      console.log(`       - ${b.name}: ${b.executablePath}`);
    }
  } else {
    console.warn("[WARN] No standard Chrome, Edge, or Brave installations found in default locations.");
    console.warn("       You can specify CHROME_PATH in .env or run Playwright bundled browsers.");
    hasWarnings = true;
  }
} catch (err) {
  console.warn(`[WARN] Browser discovery check encountered an issue: ${err.message}`);
}

// 7. Summary and next steps
console.log("\n=======================================================");
if (hasWarnings) {
  console.log(" SETUP COMPLETED WITH WARNINGS");
  console.log(" Review the warnings above, then verify with: npm run check");
} else {
  console.log(" SETUP COMPLETED SUCCESSFULLY!");
}
console.log("=======================================================");
console.log("\nNext Steps:");
console.log(" 1. Run pre-flight health check:");
console.log("    npm run check\n");
console.log(" 2. Start the unified application (Backend + Local Agent):");
console.log("    npm start\n");
console.log(" 3. Open your browser to the local dashboard:");
console.log("    http://localhost:4000\n");
