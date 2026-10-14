#!/usr/bin/env node

/**
 * Clip Submitter V2 — Unified Test Suite Runner
 * Runs all unit, integration, validation, batch, and end-to-end tests sequentially.
 * Produces a clear consolidated summary report.
 */

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

const testSuites = [
  { name: "Stop-at-First Contract & Load Clips", file: "test_load_clips.js", args: [] },
  { name: "Workflow Store & Atomic Persistence", file: "tests/test_workflow_store.js", args: ["--test-force-exit"] },
  { name: "Teach Mode Recorder Engine Lifecycle", file: "tests/test_recorder_engine.js", args: ["--test-force-exit"] },
  { name: "REST & WebSocket API Endpoints", file: "tests/test_api_endpoints.js", args: ["--test-force-exit"] },
  { name: "Pre-Flight Step & Schema Validation", file: "tests/test_preflight_validation.js", args: ["--test-force-exit"] },
  { name: "Safe Workflow Execution Engine", file: "tests/test_workflow_executor.js", args: ["--test-force-exit"] },
  { name: "Batch Execution & Queue Controls", file: "tests/test_batch_execution.js", args: ["--test-force-exit"] },
  { name: "Dashboard Acceptance & Safety Audit", file: "tests/test_audit_acceptance.js", args: ["--test-force-exit"] },
  { name: "Real End-to-End Browser Recorder & UI", file: "tests/test_real_e2e_recorder.js", args: ["--test-force-exit"] },
  { name: "Multi-Discord Profiles & Account Routing", file: "tests/test_multi_discord_routing.js", args: ["--test-force-exit"] },
  { name: "Cleanframe Finalization & Reconciliation", file: "tests/test_cleanframe_finalization.js", args: ["--test-force-exit"] }
];

const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

function runTest(test) {
  return new Promise((resolve) => {
    const filePath = path.join(ROOT_DIR, test.file);
    const start = Date.now();
    const args = [...test.args, filePath];

    const child = spawn(process.execPath, args, {
      cwd: ROOT_DIR,
      env: { ...process.env, NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let output = "";
    child.stdout.on("data", (d) => { output += d.toString(); });
    child.stderr.on("data", (d) => { output += d.toString(); });

    child.on("close", (code) => {
      const duration = Date.now() - start;
      resolve({
        name: test.name,
        file: test.file,
        passed: code === 0,
        code,
        duration,
        output
      });
    });

    child.on("error", (err) => {
      const duration = Date.now() - start;
      resolve({
        name: test.name,
        file: test.file,
        passed: false,
        code: 1,
        duration,
        output: err.message
      });
    });
  });
}

async function main() {
  console.log(`\n${BOLD}======================================================================${RESET}`);
  console.log(`${BOLD} CLIP SUBMITTER V2 — UNIFIED COMPREHENSIVE TEST SUITE${RESET}`);
  console.log(`${BOLD}======================================================================${RESET}\n`);

  const results = [];
  let totalStart = Date.now();

  for (let i = 0; i < testSuites.length; i++) {
    const suite = testSuites[i];
    process.stdout.write(`[${i + 1}/${testSuites.length}] Running: ${suite.name}... `);
    const res = await runTest(suite);
    results.push(res);

    if (res.passed) {
      console.log(`${GREEN}${BOLD}PASS${RESET} (${(res.duration / 1000).toFixed(2)}s)`);
    } else {
      console.log(`${RED}${BOLD}FAIL${RESET} (${(res.duration / 1000).toFixed(2)}s)`);
      console.log(`\n--- FAILURE OUTPUT (${suite.file}) ---`);
      console.log(res.output.trim());
      console.log("------------------------------------\n");
    }
  }

  const totalDuration = ((Date.now() - totalStart) / 1000).toFixed(2);
  const passedCount = results.filter(r => r.passed).length;
  const failedCount = results.filter(r => !r.passed).length;

  console.log(`\n${BOLD}======================================================================${RESET}`);
  console.log(`${BOLD} TEST SUMMARY REPORT${RESET}`);
  console.log(`${BOLD}======================================================================${RESET}`);

  for (const r of results) {
    const status = r.passed ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    const time = `${(r.duration / 1000).toFixed(2)}s`.padStart(8);
    console.log(`  ${status}  |  ${time}  |  ${r.name}`);
  }

  console.log(`${BOLD}======================================================================${RESET}`);
  console.log(` Total Suites: ${testSuites.length}`);
  console.log(` Passed:       ${GREEN}${passedCount}${RESET}`);
  console.log(` Failed:       ${failedCount > 0 ? RED : GREEN}${failedCount}${RESET}`);
  console.log(` Total Time:   ${totalDuration}s`);
  console.log(`${BOLD}======================================================================${RESET}\n`);

  if (failedCount > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(`Fatal error in test runner: ${err.message}`);
  process.exit(1);
});
