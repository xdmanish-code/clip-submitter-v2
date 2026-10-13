import { chromium } from "playwright";

const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
const context = b.contexts()[0];
const p = context.pages()[1];

const submit = p.getByRole("button", { name: "Submit", exact: true }).last();

console.log("SUBMIT BUTTONS:", await p.getByRole("button", { name: "Submit", exact: true }).count());

await submit.scrollIntoViewIfNeeded();
await submit.click();

console.log("DISCORD SUBMIT CLICKED");
