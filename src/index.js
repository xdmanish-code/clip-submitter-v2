import { chromium } from "playwright";
import { config } from "./config.js";
import { executeDualJob } from "../automation/dual/engine.js";

const CDP_URL = "http://127.0.0.1:9222";

async function main() {
  if (!config.websiteUrl || !config.discordUrl) {
    throw new Error("WEBSITE_URL and DISCORD_URL must be set in .env");
  }

  console.log("Connecting to Chrome over CDP at", CDP_URL, "...");
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];

  if (!context) {
    throw new Error("No browser context found. Make sure Chrome is open with remote debugging port 9222.");
  }

  console.log("Browser connected. Starting CLI Dual Automation Workflow...");

  const result = await executeDualJob({
    context,
    websiteUrl: config.websiteUrl,
    discordUrl: config.discordUrl,
    onStep: (step, detail) => {
      console.log(`[STEP] ${step} - ${detail || ""}`);
    },
    onLog: (msg) => {
      console.log(msg);
    },
    onClipUpdate: (clip, progress) => {
      console.log(`[PROGRESS] Clip ${progress.current}/${progress.total}: ${clip.instagramLink} -> ${clip.state}`);
    }
  });

  console.log("\n================================");
  console.log("RUN COMPLETE (CLI MODE)");
  console.log("================================");
  console.log(`TOTAL QUEUE: ${result.summary.total}`);
  console.log(`SUCCESS:     ${result.summary.success}`);
  console.log(`ALREADY:     ${result.summary.already}`);
  console.log(`FAILED:      ${result.summary.failed}`);
  console.log("================================\n");
}

main().catch(error => {
  console.error("\nV1/V2 STOPPED SAFELY:");
  console.error(error);
  process.exit(1);
});