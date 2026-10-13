import { chromium } from "playwright";

const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
const context = b.contexts()[0];
const p = context.pages()[1];

const s = await context.newCDPSession(p);

const x = 768.0000457763672;
const y = 436.0000190734863;

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

console.log("URL TYPED");
