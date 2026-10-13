import { chromium } from "playwright";

const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
const context = b.contexts()[0];
const p = context.pages()[1];
const s = await context.newCDPSession(p);

const result = await s.send("Runtime.evaluate", {
  expression: `(() => {
    const e = [...document.querySelectorAll("input")]
      .find(x => x.placeholder === "https://...");
    return e ? e.value : "URL FIELD NOT FOUND";
  })()`,
  returnByValue: true
});

console.log("POST LINK VALUE:", result.result.value);
