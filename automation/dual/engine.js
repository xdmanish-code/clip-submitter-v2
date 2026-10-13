import { isUnclaimed, normalizeInstagramUrl } from "../../shared/utils.js";
import { JobStatus, ClipState } from "../../shared/states.js";
import {
  navigateToAllClips,
  collectQueueWithBoundary,
  submitWebsite
} from "./cleanframe.js";
import {
  isAlreadySubmittedOnDiscord,
  startDiscordSubmit,
  selectDiscordMember,
  fillCaption,
  fillPostLink,
  submitDiscordForm,
  resetDiscordForm
} from "./discord.js";

/**
 * Ensures pages for Cleanframe and Discord exist in the given browser context.
 */
export async function setupPages(context, websiteUrl, discordUrl, log = console.log) {
  const pages = context.pages();

  let websitePage = pages.find(p => {
    try {
      const url = p.url();
      return url.includes(new URL(websiteUrl).hostname) || url.includes("cleanframe");
    } catch {
      return false;
    }
  });

  let discordPage = pages.find(p => {
    try {
      const url = p.url();
      return url.includes("discord.com/channels");
    } catch {
      return false;
    }
  });

  if (!websitePage) {
    log("Opening new tab for Cleanframe...");
    websitePage = await context.newPage();
  }

  if (!discordPage) {
    log("Opening new tab for Discord...");
    discordPage = await context.newPage();
  }

  return { websitePage, discordPage };
}

/**
 * Scans and previews the pending queue from Cleanframe without running submissions.
 */
export async function previewDualQueue({ context, websiteUrl, onStep = () => {}, onLog = console.log }) {
  onStep("Opening Cleanframe", "Navigating to dashboard");
  const pages = context.pages();
  let websitePage = pages.find(p => {
    try {
      return p.url().includes("cleanframe") || p.url().includes(new URL(websiteUrl).hostname);
    } catch {
      return false;
    }
  }) || (await context.newPage());

  await navigateToAllClips(websitePage, websiteUrl, onLog);
  onStep("Collecting queue", "Scanning pending rows");
  const result = await collectQueueWithBoundary(websitePage, onLog);
  return result;
}

/**
 * Runs the full Dual submission workflow.
 */
export async function executeDualJob({
  context,
  submissionType = "dual",
  websiteUrl,
  discordUrl,
  queueOverride = null,
  onStep = () => {},
  onLog = console.log,
  onClipUpdate = () => {},
  isCancelled = () => false
}) {
  if (String(submissionType).toLowerCase() === "kick") {
    throw new Error("INVALID ROUTING: Kick job attempted to execute Dual automation.");
  }

  onStep("Connecting to browser", "Preparing browser tabs");
  onLog("Initializing Cleanframe and Discord automation session...");

  const { websitePage, discordPage } = await setupPages(context, websiteUrl, discordUrl, onLog);

  if (isCancelled()) throw new Error("Job cancelled by user.");

  // 1. Prepare Discord page
  onStep("Opening Discord", "Loading Discord channel");
  await discordPage.goto(discordUrl, { waitUntil: "domcontentloaded" });
  await discordPage.waitForTimeout(900);

  if (isCancelled()) throw new Error("Job cancelled by user.");

  // 2. Prepare Cleanframe & scan queue if not provided
  let queue = queueOverride;
  let totalRowCount = 0;

  if (!queue || queue.length === 0) {
    onStep("Opening Cleanframe", "Navigating to All Clips");
    await navigateToAllClips(websitePage, websiteUrl, onLog);

    if (isCancelled()) throw new Error("Job cancelled by user.");

    onStep("Collecting queue", "Scanning pending clips");
    const scanResult = await collectQueueWithBoundary(websitePage, onLog);
    queue = scanResult.queue;
    totalRowCount = scanResult.totalRowCount;
  }

  if (queue.length === 0) {
    onLog("No pending clips found in queue.");
    return {
      queue: [],
      totalRowCount,
      summary: generateSummary([])
    };
  }

  onLog(`Starting Phase 2: Processing ${queue.length} clips on Discord...`);
  const submittedOrAttemptedLinks = new Set();

  // Phase 2: Process Discord submissions
  for (let i = 0; i < queue.length; i++) {
    if (isCancelled()) {
      onLog("Cancellation requested. Stopping safely before next clip...");
      break;
    }

    const clip = queue[i];
    const itemNum = i + 1;
    const normalizedUrl = normalizeInstagramUrl(clip.instagramLink);

    onLog(`\n--- Clip ${itemNum}/${queue.length}: ${clip.instagramLink} ---`);
    onClipUpdate(clip, { current: itemNum, total: queue.length });

    // 1. In-memory duplicate protection check
    if (
      submittedOrAttemptedLinks.has(clip.instagramLink) ||
      submittedOrAttemptedLinks.has(normalizedUrl)
    ) {
      onLog(`Duplicate protection: ${clip.instagramLink} already in-flight/submitted. Skipping.`);
      clip.state = ClipState.ALREADY_SUBMITTED;
      onClipUpdate(clip, { current: itemNum, total: queue.length });
      continue;
    }

    // 2. Discord chat history check
    onStep("Checking Discord history", `Checking URL ${clip.instagramLink}`);
    const alreadyInDiscord = await isAlreadySubmittedOnDiscord(discordPage, clip.instagramLink, onLog);

    if (alreadyInDiscord) {
      onLog(`Discord history check: Post already exists. Marking ALREADY_SUBMITTED.`);
      clip.state = ClipState.ALREADY_SUBMITTED;
      submittedOrAttemptedLinks.add(clip.instagramLink);
      submittedOrAttemptedLinks.add(normalizedUrl);
      onClipUpdate(clip, { current: itemNum, total: queue.length });
      continue;
    }

    if (isCancelled()) {
      onLog("Job cancelled prior to form submission.");
      break;
    }

    // 3. Perform Discord /submit
    try {
      onStep("Opening /submit", "Triggering /submit Instagram command");
      await startDiscordSubmit(discordPage, onLog);

      if (isCancelled()) {
        await resetDiscordForm(discordPage, discordUrl, onLog);
        break;
      }

      // Clipper combobox
      onStep("Selecting clipper", `Searching clipper ${clip.clipper}`);
      try {
        await selectDiscordMember(discordPage, "Clipper", clip.clipper, onLog);
      } catch (err) {
        onLog(`Clipper search failed for "${clip.clipper}": ${err.message}`);
        clip.state = ClipState.CLIPPER_NOT_FOUND;
        clip.errorReason = err.message;
        await resetDiscordForm(discordPage, discordUrl, onLog);
        onClipUpdate(clip, { current: itemNum, total: queue.length });
        continue;
      }

      // Editor combobox
      if (isUnclaimed(clip.editor)) {
        onLog(`Editor unclaimed or empty — skipping editor selection.`);
      } else {
        onStep("Selecting editor", `Searching editor ${clip.editor}`);
        try {
          await selectDiscordMember(discordPage, "Editor", clip.editor, onLog);
        } catch (err) {
          onLog(`Editor search failed for "${clip.editor}": ${err.message}`);
          clip.state = ClipState.EDITOR_NOT_FOUND;
          clip.errorReason = err.message;
          await resetDiscordForm(discordPage, discordUrl, onLog);
          onClipUpdate(clip, { current: itemNum, total: queue.length });
          continue;
        }
      }

      // Caption
      onStep("Filling caption", "Setting Discord caption");
      await fillCaption(discordPage, clip.caption, onLog);

      // Post Link via CDP
      onStep("Filling Instagram URL", "Injecting verified link via CDP");
      await fillPostLink(discordPage, clip.instagramLink, context, onLog);

      if (isCancelled()) {
        await resetDiscordForm(discordPage, discordUrl, onLog);
        break;
      }

      // Final Discord Submit
      onStep("Submitting to Discord", "Clicking submit button");
      const submitResult = await submitDiscordForm(
        discordPage,
        clip.instagramLink,
        submittedOrAttemptedLinks,
        onLog
      );

      clip.state = submitResult.status;
      if (submitResult.success) {
        clip.discordId = submitResult.submissionId;
        onLog(`Discord submission confirmed: #${submitResult.submissionId}`);
      } else {
        await resetDiscordForm(discordPage, discordUrl, onLog);
      }

      onClipUpdate(clip, { current: itemNum, total: queue.length });
      await discordPage.waitForTimeout(1000);
    } catch (err) {
      onLog(`Unexpected error during Discord processing for ${clip.instagramLink}: ${err.message}`);
      if (clip.state === ClipState.COLLECTED) {
        clip.state = ClipState.CAPTCHA_OR_UNCERTAIN;
        clip.errorReason = err.message;
      }
      await resetDiscordForm(discordPage, discordUrl, onLog);
      onClipUpdate(clip, { current: itemNum, total: queue.length });
    }
  }

  // Phase 3: Update Cleanframe for confirmed items
  onStep("Updating Cleanframe", "Syncing verified submissions back to dashboard");
  onLog("\nStarting Phase 3: Updating Cleanframe for confirmed items...");

  try {
    await navigateToAllClips(websitePage, websiteUrl, onLog);
  } catch (err) {
    onLog(`Warning re-opening Cleanframe: ${err.message}`);
  }

  for (let i = 0; i < queue.length; i++) {
    const clip = queue[i];

    if (
      clip.state === ClipState.SUBMITTED_SUCCESS ||
      clip.state === ClipState.ALREADY_SUBMITTED
    ) {
      onLog(`Syncing status for: ${clip.instagramLink} (Discord State: ${clip.state})`);
      try {
        const submitted = await submitWebsite(websitePage, clip.instagramLink, onLog);
        if (submitted) {
          clip.state = ClipState.WEBSITE_SUBMITTED;
          onClipUpdate(clip, { current: i + 1, total: queue.length });
          await websitePage.waitForTimeout(800);
        }
      } catch (err) {
        onLog(`Failed to click Cleanframe Submit for ${clip.instagramLink}: ${err.message}`);
      }
    } else {
      onLog(`Skipping Cleanframe update for ${clip.instagramLink} (State: ${clip.state})`);
    }
  }

  onStep("Completed", "All clips processed");
  onLog("\nDual job execution finished.");

  const summary = generateSummary(queue, totalRowCount);
  return {
    queue,
    totalRowCount,
    summary
  };
}

export function generateSummary(queue, totalRowCount = 0) {
  const total = queue.length;
  const success = queue.filter(c => c.state === ClipState.WEBSITE_SUBMITTED || c.state === ClipState.SUBMITTED_SUCCESS).length;
  const already = queue.filter(c => c.state === ClipState.ALREADY_SUBMITTED).length;
  const failed = queue.filter(c =>
    c.state === ClipState.CLIPPER_NOT_FOUND ||
    c.state === ClipState.EDITOR_NOT_FOUND ||
    c.state === ClipState.CAPTCHA_OR_UNCERTAIN
  ).length;

  return {
    total,
    success,
    already,
    failed,
    totalRowCount
  };
}
