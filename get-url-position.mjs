import { chromium } from "playwright";

const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
const pages = b.contexts()[0].pages();
const p = pages[1];

const s = await b.contexts()[0].newCDPSession(p);

const result = await s.send("Runtime.evaluate", {
  expression: `(() => {
    const e = [...document.querySelectorAll("input")]
      .find(x => x.placeholder === "https://...");
    if (!e) return null;

    const r = e.getBoundingClientRect();

    return {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      width: r.width,
      height: r.height
    };
  })()`,
  returnByValue: true
});

console.log("URL FIELD:", result.result.value);
