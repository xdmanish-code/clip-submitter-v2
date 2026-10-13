import { chromium } from "playwright";

const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
const context = b.contexts()[0];
const p = context.pages()[0];

const submit = p.getByRole("button", { name: "Submit", exact: true }).first();

console.log("WEBSITE SUBMIT BUTTONS:", await p.getByRole("button", { name: "Submit", exact: true }).count());

await submit.scrollIntoViewIfNeeded();
await submit.click();

console.log("WEBSITE SUBMIT CLICKED");
