import { clean, normalizeInstagramUrl } from "../../shared/utils.js";
import { ClipState } from "../../shared/states.js";
import { selectCreatorSlashCommand } from "./command-selector.js";
import { verifyKickBotResponse } from "./kick-result-verifier.js";

const DEFAULT_KICK_DISCORD_URL = process.env.KICK_DISCORD_URL || "";

/**
 * Ensures the Discord Kick channel tab is open and ready.
 */
export async function setupKickDiscordPage(context, channelUrl = DEFAULT_KICK_DISCORD_URL, log = console.log) {
  const targetUrl = channelUrl || DEFAULT_KICK_DISCORD_URL;
  const pages = context.pages();

  let discordPage = pages.find(p => {
    try {
      const url = p.url();
      return url.includes("discord.com/channels");
    } catch {
      return false;
    }
  });

  if (!discordPage) {
    log("Opening new tab for Kick Discord channel...");
    discordPage = await context.newPage();
  }

  const currentUrl = discordPage.url() || "";
  if (currentUrl.includes("1387565734254870654")) {
    log("[Kick] Discord tab already at Kick channel. Reusing immediately.");
  } else {
    log(`Navigating to Kick Discord channel: ${targetUrl}...`);
    await discordPage.goto(targetUrl, { waitUntil: "domcontentloaded" });
    await discordPage.waitForTimeout(1000);
  }

  // Check if we reached the channel
  const textBox = discordPage.getByRole("textbox").last();
  if (!(await textBox.count())) {
    await discordPage.waitForTimeout(1500);
  }

  return discordPage;
}

/**
 * Checks if the clip URL has already appeared in recent Discord channel history.
 */
export async function isAlreadySubmittedOnKickDiscord(discordPage, clipUrl, log = console.log) {
  if (!clipUrl) return false;
  try {
    const bodyText = await discordPage.locator("body").innerText().catch(() => "");
    if (bodyText.includes(clipUrl)) {
      log(`Kick Discord check: Found exact clip URL in chat history.`);
      return true;
    }

    const norm = normalizeInstagramUrl(clipUrl);
    if (norm && bodyText.includes(norm)) {
      log(`Kick Discord check: Found normalized URL in chat history.`);
      return true;
    }
  } catch (err) {
    log(`Notice: Discord history check error: ${err.message}`);
  }
  return false;
}

/**
 * Locates, focuses, and injects the Reel URL into the slash command's `links` option.
 */
export async function fillKickLinksField(page, context, clipUrl, log = console.log) {
  log("[Kick] Filling links argument");

  // Since the links argument is already selected in the active command form (selectedPill__1464f),
  // insert the URL directly into the active field via CDP Input.insertText
  const session = await context.newCDPSession(page);
  await session.send("Input.insertText", { text: clipUrl });
  await page.waitForTimeout(300);

  // 1. Verify that the `links` argument visibly contains the URL
  const verification = await page.evaluate((url) => {
    const editor = document.querySelector('[role="textbox"][contenteditable="true"]') || document.querySelector('[data-slate-editor="true"]');
    if (!editor) return { valid: false };

    const bodyText = document.body.innerText || "";
    const hasRequiredError = bodyText.includes("links — This option is required") || bodyText.includes("Specify a value");

    const optionPill = editor.querySelector('[class*="optionPillValue"], [class*="optionPill"]');
    const pillText = optionPill ? (optionPill.textContent || "") : "";
    const editorText = editor.textContent || "";

    const containsUrl = pillText.includes(url) || (editorText.includes(url) && !hasRequiredError);
    return {
      valid: containsUrl && !hasRequiredError,
      hasRequiredError,
      pillText
    };
  }, clipUrl);

  if (!verification.valid) {
    // Targeted recovery: click the option pill value element directly and re-insert
    const optionPill = page.locator('[class*="optionPillValue"], [class*="optionPill"]').first();
    if (await optionPill.count()) {
      await optionPill.click();
      await page.waitForTimeout(150);
      await session.send("Input.insertText", { text: clipUrl });
      await page.waitForTimeout(300);
    }
  }

  // Final check before proceeding
  const finalCheck = await page.evaluate((url) => {
    const editor = document.querySelector('[role="textbox"][contenteditable="true"]') || document.querySelector('[data-slate-editor="true"]');
    const bodyText = document.body.innerText || "";
    const hasRequiredError = bodyText.includes("links — This option is required") || bodyText.includes("Specify a value");
    const editorText = editor ? (editor.textContent || "") : "";
    return !hasRequiredError && editorText.includes(url);
  }, clipUrl);

  if (!finalCheck) {
    log("[Kick] ERROR: links field is empty.");
    throw new Error("links field is empty — refusing to submit.");
  }

  log("[Kick] URL verified");
  return true;
}

/**
 * Resets the Discord chat composer on error or completion.
 */
export async function resetDiscordComposer(page, log = console.log) {
  try {
    log("[Kick] Resetting Discord composer...");
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(200);
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(200);

    const box = page.getByRole("textbox").last();
    if (await box.count()) {
      await box.fill("").catch(() => {});
    }
  } catch (err) {
    log(`[Kick] Warning resetting composer: ${err.message}`);
  }
}

/**
 * Executes a single Kick clip submission:
 * Select /<creator> -> Fill links [clipUrl] -> Press Enter -> Wait 10s -> Verify Bot Response.
 */
export async function submitKickClip(discordPage, context, clipItem, submittedOrAttemptedSet, log = console.log, meta = {}) {
  const { creator, command, clipUrl } = clipItem;
  const targetCommand = command || creator.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const tag = `[Kick][Job ${meta.jobId || "N/A"}][Agent ${meta.agentId || "local"}]`;

  // 1. Select the dynamic creator slash command
  await selectCreatorSlashCommand(discordPage, targetCommand, creator, log, meta);

  // 2. Locate and fill the `links` parameter with the clip URL
  log(`${tag} Filling links argument with: ${clipUrl}`);
  await fillKickLinksField(discordPage, context, clipUrl, log);
  log(`${tag} State: URL_VERIFIED`);

  // 3. Add to in-flight duplicate protection set immediately before pressing Enter
  submittedOrAttemptedSet.add(clipUrl);
  const normalized = normalizeInstagramUrl(clipUrl);
  if (normalized) submittedOrAttemptedSet.add(normalized);

  // 4. Submit command to Discord
  log(`${tag} State: SUBMITTED (Pressing Enter)`);
  const submissionTimestamp = Date.now();
  await discordPage.keyboard.press("Enter");

  // 5. Wait 10 seconds for Kick bot response
  log(`${tag} Waiting 10 seconds for Kick bot response...`);
  await discordPage.waitForTimeout(10000);

  // 6. Verify the Kick bot response
  const verification = await verifyKickBotResponse(
    discordPage,
    clipUrl,
    submissionTimestamp,
    5000,
    log
  );

  log(`${tag} State: RESULT_CHECKED (${verification.status}: ${verification.message})`);

  if (!verification.success) {
    await resetDiscordComposer(discordPage, log);
  }

  return verification;
}
