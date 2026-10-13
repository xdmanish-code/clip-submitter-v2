import { chromium } from "playwright";

const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
const context = b.contexts()[0];
const p = context.pages()[1];
const s = await context.newCDPSession(p);

await s.send("Runtime.evaluate", {
  expression: `(() => {
    const e = [...document.querySelectorAll("input")]
      .find(x => x.placeholder === "https://...");
    if (!e) return "URL FIELD NOT FOUND";

    e.focus();
    e.scrollIntoView({block: "center", inline: "nearest"});

    return {
      focused: document.activeElement === e,
      value: e.value
    };
  })()`,
  returnByValue: true
});

await s.send("Input.insertText", {
  text: "https://www.instagram.com/reel/DduIF78HRjn/"
});

console.log("URL INSERTED INTO POST LINK FIELD");
