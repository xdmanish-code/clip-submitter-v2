import { chromium } from "playwright";
import { config } from "./config.js";

const CDP_URL = "http://127.0.0.1:9222";

function clean(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").trim();
}

function normalizeUsername(value) {
  return clean(value).replace(/^@/, "").toLowerCase();
}

function isUnclaimed(value) {
  const v = normalizeUsername(value);
  return !v || v === "unclaimed";
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeInstagramUrl(url) {
  if (!url) return "";
  const raw = clean(url).trim();
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return `https://${host}${pathname}`;
  } catch {
    return raw.replace(/^https?:\/\/(www\.)?/, "https://").replace(/\/+$/, "");
  }
}

async function readSubmission(page, row) {
  const cells = row.locator("td");

  const instagramLink = clean(
    await cells.nth(1).locator("a").first().getAttribute("href")
  );

  const editor = clean(await cells.nth(2).innerText())
    .replace(/\s*Copy\s*$/i, "")
    .trim();

  const clipper = clean(await cells.nth(3).innerText())
    .replace(/\s*Copy\s*$/i, "")
    .trim();

  const caption =
    clean(
      await cells
        .nth(4)
        .locator("span[title]")
        .getAttribute("title")
    ) ||
    clean(await cells.nth(4).innerText())
      .replace(/\s*Copy\s*$/i, "")
      .trim();

  if (!instagramLink) {
    throw new Error("Instagram link not found.");
  }

  if (!clipper) {
    throw new Error("Clipper not found.");
  }

  if (!caption) {
    throw new Error("Caption not found.");
  }

  return {
    instagramLink,
    clipper,
    editor,
    caption
  };
}

// ==================================================
// DISCORD EXISTING SUBMISSION CHECK (DUPLICATE SAFETY)
// ==================================================

async function isAlreadySubmittedOnDiscord(discordPage, targetUrl) {
  const normalizedTarget = normalizeInstagramUrl(targetUrl);
  if (!normalizedTarget) return false;

  try {
    // 1. Check visible links in Discord
    const links = await discordPage.locator('a[href*="instagram.com"]').all();
    for (const link of links) {
      const href = await link.getAttribute("href").catch(() => "");
      if (href && normalizeInstagramUrl(href) === normalizedTarget) {
        return true;
      }
    }

    // 2. Check visible text in messages container or body
    const bodyText = await discordPage.locator("body").innerText().catch(() => "");
    if (bodyText.includes(targetUrl) || bodyText.includes(normalizedTarget)) {
      return true;
    }

    // 3. Check for specific post shortcode/ID match (e.g. /p/..., /reel/...)
    const shortcodeMatch = targetUrl.match(
      /instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i
    );
    if (shortcodeMatch && shortcodeMatch[1]) {
      const shortcode = shortcodeMatch[1];
      const regex = new RegExp(
        `instagram\\.com\\/(?:p|reel|reels|tv)\\/${escapeRegex(shortcode)}`,
        "i"
      );
      if (regex.test(bodyText)) {
        return true;
      }
    }
  } catch (err) {
    console.warn("Notice: Discord history check error:", err.message);
  }

  return false;
}

// ==================================================
// PHASE 1: SCAN QUEUE BOUNDARY ON CLEANFRAME
// ==================================================

async function collectQueueWithBoundary(websitePage) {
  console.log("\n==================================================");
  console.log("PHASE 1 — FIND CURRENT QUEUE");
  console.log("==================================================");

  await websitePage.evaluate(() => {
    window.scrollTo({
      top: 0,
      behavior: "instant"
    });
  });

  await websitePage.waitForTimeout(500);

  // Get ALL table rows in their current DOM/UI order (do not pre-filter by Submit)
  const rows = websitePage.locator("tbody tr");
  const totalRowCount = await rows.count();

  console.log(`Found ${totalRowCount} table rows.\n`);
  console.log("Scanning from TOP...\n");

  const queue = [];
  const seenUrls = new Set();

  for (let i = 0; i < totalRowCount; i++) {
    const rowNumber = i + 1;
    const row = rows.nth(i);

    // Inspect THIS row only: determine if it is pending or already submitted
    const submitBtn = row.getByRole("button", {
      name: "Submit",
      exact: true
    });

    const hasPendingSubmit = (await submitBtn.count()) > 0;

    if (!hasPendingSubmit) {
      console.log(
        `ROW ${rowNumber}: already submitted → QUEUE BOUNDARY FOUND`
      );
      console.log("\nSTOP SCANNING.");
      break;
    }

    // Row is pending — read its details
    let item;
    try {
      item = await readSubmission(websitePage, row);
    } catch (err) {
      console.warn(`ROW ${rowNumber}: Error reading row (${err.message}).`);
      continue;
    }

    const normalized = normalizeInstagramUrl(item.instagramLink);
    if (!normalized) {
      console.warn(`ROW ${rowNumber}: Invalid Instagram URL, skipping.`);
      continue;
    }

    if (seenUrls.has(normalized)) {
      console.log(
        `ROW ${rowNumber}: Duplicate link in current queue (${item.instagramLink}). Skipping.`
      );
      continue;
    }

    console.log(`ROW ${rowNumber}: pending → queued`);
    seenUrls.add(normalized);
    queue.push({
      instagramLink: item.instagramLink,
      clipper: item.clipper,
      editor: item.editor,
      caption: item.caption,
      state: "COLLECTED",
      discordId: null,
      errorReason: null
    });
  }

  console.log(`\nCURRENT QUEUE: ${queue.length} clips\n`);
  return { queue, totalRowCount };
}

// ==================================================
// DISCORD ACTIONS
// ==================================================

async function startDiscordSubmit(page) {
  const box = page.getByRole("textbox").last();

  await box.click();
  await box.fill("/submit");
  await page.waitForTimeout(500);

  const command = page.getByText("/submit", {
    exact: true
  }).last();

  if (await command.count()) {
    await command.click();
  } else {
    await box.press("Enter");
  }

  const instagram = page.getByText("Instagram", {
    exact: true
  }).last();

  const deadline = Date.now() + 8000;

  while (Date.now() < deadline) {
    if (await instagram.count()) {
      break;
    }

    await page.waitForTimeout(300);
  }

  if (!(await instagram.count())) {
    throw new Error(
      "Instagram option did not appear within 8 seconds."
    );
  }

  await instagram.click();
  await page.waitForTimeout(300);
  await box.press("Enter");
  await page.waitForTimeout(900);

  console.log("Discord /submit Instagram opened.");
}

async function getDiscordPicker(page, index, label) {
  const deadline = Date.now() + 8000;

  while (Date.now() < deadline) {
    const picker = page
      .locator('input[role="combobox"]')
      .nth(index);

    if (await picker.count()) {
      return picker;
    }

    await page.waitForTimeout(300);
  }

  throw new Error(
    `${label} picker not found within 8 seconds.`
  );
}

async function selectDiscordMember(page, label, username) {
  const target = normalizeUsername(username);

  const pickerIndex =
    label.toLowerCase().includes("clipper")
      ? 0
      : 1;

  const picker = await getDiscordPicker(
    page,
    pickerIndex,
    label
  );

  await picker.click();

  for (
    let length = target.length;
    length >= 1;
    length--
  ) {
    const query = target.slice(0, length);

    await picker.fill("");

    for (const character of query) {
      await picker.press(character);
      await page.waitForTimeout(180);
    }

    await page.waitForTimeout(500);

    const options = page.locator(
      '[role="option"]:visible'
    );

    const count = await options.count();

    for (let i = 0; i < count; i++) {
      const option = options.nth(i);

      const text = clean(
        await option.innerText().catch(() => "")
      );

      if (
        normalizeUsername(text).includes(target) ||
        new RegExp(
          `(^|\\s)${escapeRegex(target)}(\\s|$)`,
          "i"
        ).test(text)
      ) {
        console.log(
          `${label} found: ${text.replace(/\n/g, " / ")}`
        );

        await option.click();

        return;
      }
    }
  }

  throw new Error(
    `Could not find Discord ${label}: ${username}`
  );
}

async function fillCaption(page, caption) {
  const textarea = page.locator("textarea").first();

  if (!(await textarea.count())) {
    throw new Error(
      "Discord Caption field not found."
    );
  }

  await textarea.fill(caption);
  console.log("Caption filled.");
}

async function fillPostLink(page, url, context) {
  const session =
    await context.newCDPSession(page);

  const result = await session.send(
    "Runtime.evaluate",
    {
      expression: `(() => {
        const e = [...document.querySelectorAll("input")]
          .find(x => x.placeholder === "https://...");

        if (!e) return "URL FIELD NOT FOUND";

        e.focus();

        e.scrollIntoView({
          block: "center",
          inline: "nearest"
        });

        return {
          focused: document.activeElement === e,
          value: e.value
        };
      })()`,

      returnByValue: true
    }
  );

  if (
    result.result.value ===
    "URL FIELD NOT FOUND"
  ) {
    throw new Error(
      "Discord Post Link field not found."
    );
  }

  await session.send(
    "Input.insertText",
    {
      text: url
    }
  );

  const verify = await session.send(
    "Runtime.evaluate",
    {
      expression: `(() => {
        const e = [...document.querySelectorAll("input")]
          .find(x => x.placeholder === "https://...");

        return e
          ? e.value
          : "URL FIELD NOT FOUND";
      })()`,

      returnByValue: true
    }
  );

  const actual = verify.result?.value;

  if (actual !== url) {
    throw new Error(
      `Post Link verification failed. Expected ${url}, got ${actual}`
    );
  }

  console.log(
    "Post Link verified:",
    actual
  );
}

async function resetDiscordForm(page) {
  try {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(200);
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);

    const cancelBtn = page.getByRole("button", { name: "Cancel", exact: true });
    if (await cancelBtn.count().catch(() => 0)) {
      await cancelBtn.first().click().catch(() => {});
      await page.waitForTimeout(300);
    }

    await page.goto(config.discordUrl, {
      waitUntil: "domcontentloaded"
    });
    await page.waitForTimeout(900);
  } catch (err) {
    console.warn("Warning during Discord form reset:", err.message);
  }
}

async function submitDiscordForm(page, instagramLink, submittedOrAttemptedLinks) {
  const submit = page
    .getByRole("button", {
      name: "Submit",
      exact: true
    })
    .last();

  const count = await page
    .getByRole("button", {
      name: "Submit",
      exact: true
    })
    .count();

  if (!count) {
    throw new Error(
      "Discord Submit button not found."
    );
  }

  await submit.scrollIntoViewIfNeeded();

  // CRITICAL DUPLICATE PROTECTION:
  // Immediately before clicking Discord's final Submit button, add URL to protection Set
  submittedOrAttemptedLinks.add(instagramLink);
  submittedOrAttemptedLinks.add(normalizeInstagramUrl(instagramLink));

  console.log("Discord Submit button ready. Instagram URL added to duplicate protection Set.");
  console.log("Clicking Discord Submit...");

  await submit.click();
  console.log("Discord Submit clicked.");

  const deadline = Date.now() + 6500;
  let submissionId = null;
  let captchaDetected = false;

  while (Date.now() < deadline) {
    await page.waitForTimeout(500);

    const body = await page.locator("body").innerText().catch(() => "");
    const iframes = await page
      .locator(
        'iframe[src*="hcaptcha"], iframe[src*="recaptcha"], iframe[title*="captcha"], iframe[title*="recaptcha"]'
      )
      .count()
      .catch(() => 0);

    if (
      /captcha|verify you are human|are you human|verification required/i.test(body) ||
      iframes > 0
    ) {
      captchaDetected = true;
      console.log("CAPTCHA / verification challenge detected on Discord!");
      break;
    }

    const match = body.match(/Submission saved as #(\d+)/i);
    if (match) {
      submissionId = match[1];
      break;
    }
  }

  if (captchaDetected) {
    console.log("STATUS: CAPTCHA_OR_UNCERTAIN");
    return {
      success: false,
      status: "CAPTCHA_OR_UNCERTAIN"
    };
  }

  if (submissionId) {
    console.log(`Discord submission confirmed: #${submissionId}`);
    return {
      success: true,
      submissionId,
      status: "SUBMITTED_SUCCESS"
    };
  }

  console.log("DISCORD SUBMIT CLICKED");
  console.log("SUCCESS VERIFICATION NOT FOUND");
  console.log("STATUS: UNCERTAIN");
  console.log("LINK WILL NOT BE RETRIED");

  return {
    success: false,
    status: "CAPTCHA_OR_UNCERTAIN"
  };
}

// ==================================================
// PHASE 3: CLEANFRAME SUBMISSION
// ==================================================

async function submitWebsite(page, instagramLink) {
  const rows = page.locator("tbody tr").filter({
    has: page.getByRole("button", {
      name: "Submit",
      exact: true
    })
  });

  const count = await rows.count();
  const normalizedTarget = normalizeInstagramUrl(instagramLink);

  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);

    const link = clean(
      await row
        .locator("td")
        .nth(1)
        .locator("a")
        .first()
        .getAttribute("href")
        .catch(() => "")
    );

    if (
      link === instagramLink ||
      normalizeInstagramUrl(link) === normalizedTarget
    ) {
      const submit = row
        .getByRole("button", {
          name: "Submit",
          exact: true
        })
        .first();

      await submit.scrollIntoViewIfNeeded();
      await submit.click();

      console.log(`Cleanframe Submit clicked for ${instagramLink}`);
      return true;
    }
  }

  console.warn(
    `Could not find matching pending Cleanframe row for ${instagramLink}`
  );
  return false;
}

// ==================================================
// SUMMARY & REPORTING
// ==================================================

function printSummary(queue, totalRowCount) {
  const totalQueue = queue.length;
  const alreadySubmitted = queue.filter(
    c => c.state === "ALREADY_SUBMITTED"
  ).length;
  const submittedSuccess = queue.filter(
    c => c.state === "SUBMITTED_SUCCESS" || c.state === "WEBSITE_SUBMITTED"
  ).length;
  const websiteSubmitted = queue.filter(
    c => c.state === "WEBSITE_SUBMITTED"
  ).length;
  const clipperNotFound = queue.filter(
    c => c.state === "CLIPPER_NOT_FOUND"
  ).length;
  const editorNotFound = queue.filter(
    c => c.state === "EDITOR_NOT_FOUND"
  ).length;
  const captchaOrUncertain = queue.filter(
    c => c.state === "CAPTCHA_OR_UNCERTAIN"
  ).length;

  console.log("\n================================");
  console.log("RUN COMPLETE");
  console.log("================================");
  if (typeof totalRowCount === "number") {
    console.log(`TOTAL TABLE ROWS: ${totalRowCount}`);
  }
  console.log(`CURRENT QUEUE: ${totalQueue}`);
  console.log(`ALREADY SUBMITTED: ${alreadySubmitted}`);
  console.log(`SUBMITTED SUCCESSFULLY: ${submittedSuccess}`);
  console.log(`WEBSITE SUBMITTED: ${websiteSubmitted}`);
  console.log(`CLIPPER NOT FOUND: ${clipperNotFound}`);
  console.log(`EDITOR NOT FOUND: ${editorNotFound}`);
  console.log(`CAPTCHA / UNCERTAIN: ${captchaOrUncertain}`);
  console.log("================================\n");

  const skippedOrUncertain = queue.filter(
    c => c.state !== "WEBSITE_SUBMITTED" && c.state !== "SUBMITTED_SUCCESS"
  );

  if (skippedOrUncertain.length > 0) {
    console.log("================================");
    console.log("SKIPPED / UNCERTAIN CLIPS:");
    console.log("================================");
    for (const clip of skippedOrUncertain) {
      let details = "";
      if (clip.state === "CLIPPER_NOT_FOUND") details = ` (Clipper: ${clip.clipper})`;
      else if (clip.state === "EDITOR_NOT_FOUND") details = ` (Editor: ${clip.editor})`;
      else if (clip.errorReason) details = ` (${clip.errorReason})`;
      console.log(`- [${clip.state}] ${clip.instagramLink}${details}`);
    }
    console.log("================================\n");
  }
}

// ==================================================
// MAIN WORKFLOW
// ==================================================

async function main() {
  if (!config.websiteUrl || !config.discordUrl) {
    throw new Error("WEBSITE_URL and DISCORD_URL must be set in .env");
  }

  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];

  if (!context) {
    throw new Error("No browser context found.");
  }

  const pages = context.pages();

  let websitePage = pages.find(p =>
    p.url().includes("cleanframe.manish7773501.workers.dev")
  );

  let discordPage = pages.find(p =>
    p.url().includes(
      "discord.com/channels/1499411476945965168/1501086713030901901"
    )
  );

  if (!websitePage) {
    websitePage = await context.newPage();
    await websitePage.goto(config.websiteUrl, {
      waitUntil: "domcontentloaded"
    });
  }

  if (!discordPage) {
    discordPage = await context.newPage();
    await discordPage.goto(config.discordUrl, {
      waitUntil: "domcontentloaded"
    });
  }

  // Ensure Discord page is loaded
  await discordPage.goto(config.discordUrl, {
    waitUntil: "domcontentloaded"
  });
  await discordPage.waitForTimeout(900);

  // Navigate Cleanframe to ensure fresh state and open All Clips
  await websitePage.goto(config.websiteUrl, {
    waitUntil: "domcontentloaded"
  });
  await websitePage.waitForTimeout(700);

  const allClips = websitePage
    .getByText("All Clips", { exact: true })
    .first();

  if (!(await allClips.count())) {
    throw new Error('Could not find "All Clips".');
  }

  await allClips.click();
  await websitePage.waitForTimeout(700);
  console.log("All Clips opened on Cleanframe.");

  // ==================================================
  // PHASE 1: FIND CURRENT QUEUE (STOP AT FIRST SUBMITTED ROW)
  // ==================================================
  const { queue, totalRowCount } = await collectQueueWithBoundary(websitePage);

  if (queue.length === 0) {
    console.log("No pending clips in current queue.");
    printSummary(queue, totalRowCount);
    return;
  }

  // Duplicate protection set across the entire execution
  const submittedOrAttemptedLinks = new Set();

  // ==================================================
  // PHASE 2: PROCESS CURRENT QUEUE IN DISCORD
  // ==================================================
  console.log("==================================================");
  console.log("PHASE 2 — PROCESS CURRENT QUEUE IN DISCORD");
  console.log("==================================================");

  for (let i = 0; i < queue.length; i++) {
    const clip = queue[i];
    const itemNum = i + 1;
    const normalizedUrl = normalizeInstagramUrl(clip.instagramLink);

    console.log(`\n--------------------------------------------------`);
    console.log(`PROCESSING CLIP ${itemNum} of ${queue.length}`);
    console.log(`Instagram: ${clip.instagramLink}`);
    console.log(`Clipper:   ${clip.clipper}`);
    console.log(`Editor:    ${clip.editor || "(empty)"}`);
    console.log(`--------------------------------------------------`);

    // 1. In-memory duplicate protection check in this run
    if (
      submittedOrAttemptedLinks.has(clip.instagramLink) ||
      submittedOrAttemptedLinks.has(normalizedUrl)
    ) {
      console.log(
        `DUPLICATE PROTECTION: ${clip.instagramLink} was already attempted/submitted. Skipping.`
      );
      clip.state = "ALREADY_SUBMITTED";
      continue;
    }

    // 2. Check Discord visible recent-submission history
    const alreadyInDiscord = await isAlreadySubmittedOnDiscord(
      discordPage,
      clip.instagramLink
    );

    if (alreadyInDiscord) {
      console.log(
        `DISCORD HISTORY CHECK: Exact URL already found in recent submissions. Marking ALREADY_SUBMITTED.`
      );
      clip.state = "ALREADY_SUBMITTED";
      submittedOrAttemptedLinks.add(clip.instagramLink);
      submittedOrAttemptedLinks.add(normalizedUrl);
      continue;
    }

    // 3. Perform Discord submission
    try {
      await startDiscordSubmit(discordPage);

      // Clipper search
      try {
        await selectDiscordMember(discordPage, "Clipper", clip.clipper);
      } catch (err) {
        console.log(`CLIPPER SEARCH FAILED: ${clip.clipper}`);
        console.log(`Reason: ${err.message}`);
        clip.state = "CLIPPER_NOT_FOUND";
        clip.errorReason = err.message;
        await resetDiscordForm(discordPage);
        continue;
      }

      // Editor handling
      if (isUnclaimed(clip.editor)) {
        console.log("Editor empty/unclaimed — leaving Editor untouched.");
      } else {
        try {
          await selectDiscordMember(discordPage, "Editor", clip.editor);
        } catch (err) {
          console.log(`EDITOR SEARCH FAILED: ${clip.editor}`);
          console.log(`Reason: ${err.message}`);
          clip.state = "EDITOR_NOT_FOUND";
          clip.errorReason = err.message;
          await resetDiscordForm(discordPage);
          continue;
        }
      }

      // Caption
      await fillCaption(discordPage, clip.caption);

      // Post Link
      await fillPostLink(discordPage, clip.instagramLink, context);

      // Discord Final Submit
      const submitResult = await submitDiscordForm(
        discordPage,
        clip.instagramLink,
        submittedOrAttemptedLinks
      );

      clip.state = submitResult.status;
      if (submitResult.success) {
        clip.discordId = submitResult.submissionId;
        console.log(
          `COMPLETED DISCORD SUBMISSION #${itemNum} — Discord #${submitResult.submissionId}`
        );
      } else {
        await resetDiscordForm(discordPage);
      }

      await discordPage.waitForTimeout(1000);
    } catch (err) {
      console.log(`UNEXPECTED ERROR during Discord processing for ${clip.instagramLink}:`);
      console.log(`Reason: ${err.message}`);
      if (clip.state === "COLLECTED") {
        clip.state = "CAPTCHA_OR_UNCERTAIN";
        clip.errorReason = err.message;
      }
      await resetDiscordForm(discordPage);
    }
  }

  // ==================================================
  // PHASE 3: UPDATE CLEANFRAME
  // ==================================================
  console.log("\n==================================================");
  console.log("PHASE 3 — UPDATE CLEANFRAME");
  console.log("==================================================");

  // Return to Cleanframe
  await websitePage.goto(config.websiteUrl, {
    waitUntil: "domcontentloaded"
  });
  await websitePage.waitForTimeout(700);

  const allClipsBtn = websitePage
    .getByText("All Clips", { exact: true })
    .first();

  if (await allClipsBtn.count()) {
    await allClipsBtn.click();
    await websitePage.waitForTimeout(700);
  }

  for (const clip of queue) {
    if (
      clip.state === "SUBMITTED_SUCCESS" ||
      clip.state === "ALREADY_SUBMITTED"
    ) {
      console.log(
        `Updating Cleanframe for verified clip: ${clip.instagramLink} (Discord State: ${clip.state})`
      );
      try {
        const submitted = await submitWebsite(
          websitePage,
          clip.instagramLink
        );
        if (submitted) {
          clip.state = "WEBSITE_SUBMITTED";
          await websitePage.waitForTimeout(800);
        }
      } catch (err) {
        console.warn(
          `Failed to submit on Cleanframe for ${clip.instagramLink}: ${err.message}`
        );
      }
    } else {
      console.log(
        `Skipping Cleanframe update for ${clip.instagramLink} (State: ${clip.state})`
      );
    }
  }

  // Print final summary
  printSummary(queue, totalRowCount);
}

main().catch(error => {
  console.error("\nV1 STOPPED SAFELY:");
  console.error(error);
  process.exit(1);
});