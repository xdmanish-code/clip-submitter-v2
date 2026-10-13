import { chromium } from "playwright";

const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
const p = b.contexts()[0].pages()[1];
const s = await b.newBrowserCDPSession(p);

const r = await s.send("Runtime.evaluate", {
  expression: `(() => {
    const e = [...document.querySelectorAll("input")]
      .find(x => x.placeholder === "https://...");
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2
    };
  })()`,
  returnByValue: true
});

console.log("FIELD:", r.result.value);

if (!r.result.value) {
  throw new Error("Post Link field not found");
}

const { x, y } = r.result.value;

await s.send("Input.dispatchMouseEvent", {
  type: "mousePressed",
  x,
  y,
  button: "left",
  clickCount: 1
});

await s.send("Input.dispatchMouseEvent", {
  type: "mouseReleased",
  x,
  y,
  button: "left",
  clickCount: 1
});

await s.send("Input.insertText", {
  text: "https://www.instagram.com/reel/DduIF78HRjn/"
});

console.log("URL SENT THROUGH BROWSER INPUT");
