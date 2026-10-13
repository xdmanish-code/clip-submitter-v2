import { chromium } from "playwright";

const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
const context = b.contexts()[0];
const p = context.pages()[1];

await p.waitForTimeout(1500);

const body = await p.locator("body").innerText();

console.log("DISCORD CHECK:");
console.log(
  body.includes("successfully") ||
  body.includes("submitted") ||
  body.includes("Submission") ||
  body.includes("accepted")
    ? "SUCCESS MESSAGE DETECTED"
    : "NO CLEAR SUCCESS MESSAGE DETECTED"
);

console.log("\nLATEST TEXT:\n", body.slice(-2500));
