import { isUnclaimed, normalizeInstagramUrl } from "../../shared/utils.js";
import {
  JobStatus,
  ClipState,
  DiscordResult,
  CleanframeMarkResult,
  OverallReelResult
} from "../../shared/states.js";
import {
  navigateToAllClips,
  collectQueueWithBoundary,
  clickGrozyFrameSubmitButton,
  submitWebsite,
  isRowVisuallyGreen
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
  profileRouter = null,
  browserManager = null,
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
  const profileDiscordPages = new Map();
  profileDiscordPages.set("default", discordPage);

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

    // 0. Account-to-Profile Routing Resolution
    let activeDiscordPage = discordPage;
    let targetProfile = null;

    if (profileRouter) {
      const routing = profileRouter.resolveProfileForAccount(clip.publishedOnAccount);
      if (!routing.resolved) {
        if (routing.reason === "ACCOUNT_NOT_PUBLISHED") {
          onLog(`Routing check: Row #${itemNum} has no published account ('${clip.publishedOnAccount || "Not published"}'). Skipping submission.`);
          clip.state = ClipState.BLOCKED_UNMAPPED;
          clip.discordResult = DiscordResult.SKIPPED;
          clip.cleanframeMark = CleanframeMarkResult.NOT_REQUIRED;
          clip.cleanframeStatusText = "Not clicked (Unpublished account)";
          clip.overallResult = OverallReelResult.SKIPPED;
          clip.errorReason = "Published on Account is missing or Not published";
        } else if (routing.reason === "ACCOUNT_UNMAPPED") {
          onLog(`Routing check: Account "${routing.account}" is unmapped. Blocking row safely without arbitrary fallback.`);
          clip.state = ClipState.BLOCKED_UNMAPPED;
          clip.discordResult = DiscordResult.SKIPPED;
          clip.cleanframeMark = CleanframeMarkResult.NOT_REQUIRED;
          clip.cleanframeStatusText = "Not clicked (Unmapped account)";
          clip.overallResult = OverallReelResult.SKIPPED;
          clip.errorReason = `No Discord profile mapped for account ${routing.account}`;
        } else {
          onLog(`Routing check: Assigned profile for "${routing.account}" is missing or invalid. Blocking row.`);
          clip.state = ClipState.BLOCKED_DISCONNECTED;
          clip.discordResult = DiscordResult.SKIPPED;
          clip.cleanframeMark = CleanframeMarkResult.NOT_REQUIRED;
          clip.cleanframeStatusText = "Not clicked (Invalid profile)";
          clip.overallResult = OverallReelResult.SKIPPED;
          clip.errorReason = "Assigned profile missing or invalid";
        }
        onClipUpdate(clip, { current: itemNum, total: queue.length });
        continue;
      }

      targetProfile = routing.profile;
      clip.discordProfileId = targetProfile.id;
      clip.discordProfileName = targetProfile.name;

      if (targetProfile.status === "CONNECTION_FAILED" || targetProfile.status === "NOT_CONNECTED") {
        onLog(`Routing check: Profile "${targetProfile.name}" is not connected (${targetProfile.status}). Safely blocking clip.`);
        clip.state = ClipState.BLOCKED_DISCONNECTED;
        clip.discordResult = DiscordResult.SKIPPED;
        clip.cleanframeMark = CleanframeMarkResult.NOT_REQUIRED;
        clip.cleanframeStatusText = "Not clicked (Disconnected profile)";
        clip.overallResult = OverallReelResult.SKIPPED;
        clip.errorReason = `Assigned profile "${targetProfile.name}" is not connected`;
        onClipUpdate(clip, { current: itemNum, total: queue.length });
        continue;
      }

      onLog(`Routing: Row #${itemNum} (${clip.publishedOnAccount || "default"}) routed to profile: "${targetProfile.name}" (${targetProfile.id})`);

      // Obtain Discord page for this profile
      if (browserManager && browserManager.getProfileContext) {
        if (profileDiscordPages.has(targetProfile.id)) {
          activeDiscordPage = profileDiscordPages.get(targetProfile.id);
        } else {
          onStep("Switching Discord Profile", `Connecting session for ${targetProfile.name}`);
          const pCtx = await browserManager.getProfileContext(targetProfile);
          const pPages = pCtx.pages();
          let pPage = pPages.find(p => {
            try { return p.url().includes("discord.com/channels"); } catch { return false; }
          });
          if (!pPage) {
            pPage = await pCtx.newPage();
            await pPage.goto(discordUrl, { waitUntil: "domcontentloaded" });
            await pPage.waitForTimeout(900);
          }
          profileDiscordPages.set(targetProfile.id, pPage);
          activeDiscordPage = pPage;
        }
      }
    }

    // 1. In-memory duplicate protection check
    if (
      submittedOrAttemptedLinks.has(clip.instagramLink) ||
      submittedOrAttemptedLinks.has(normalizedUrl)
    ) {
      onLog(`Duplicate protection: ${clip.instagramLink} already in-flight/submitted. Skipping.`);
      clip.state = ClipState.ALREADY_SUBMITTED;
      clip.discordResult = DiscordResult.SKIPPED;
      clip.cleanframeMark = CleanframeMarkResult.NOT_REQUIRED;
      clip.cleanframeStatusText = "Not required (Duplicate in batch)";
      clip.overallResult = OverallReelResult.SKIPPED;
      onClipUpdate(clip, { current: itemNum, total: queue.length });
      continue;
    }

    // 2. Discord chat history check
    onStep("Checking Discord history", `Checking URL ${clip.instagramLink}`);
    const alreadyInDiscord = await isAlreadySubmittedOnDiscord(activeDiscordPage, clip.instagramLink, onLog);

    if (alreadyInDiscord) {
      onLog(`Discord history check: Post already exists. Marking ALREADY_SUBMITTED.`);
      clip.state = ClipState.ALREADY_SUBMITTED;
      clip.discordResult = DiscordResult.SKIPPED;
      clip.cleanframeMark = CleanframeMarkResult.NOT_REQUIRED;
      clip.cleanframeStatusText = "Not required (Found in Discord history)";
      clip.overallResult = OverallReelResult.SKIPPED;
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
      onStep("Opening /submit", `Triggering /submit Instagram command (${clip.discordProfileName || "default"})`);
      await startDiscordSubmit(activeDiscordPage, onLog);

      if (isCancelled()) {
        await resetDiscordForm(activeDiscordPage, discordUrl, onLog);
        break;
      }

      // Clipper combobox
      onStep("Selecting clipper", `Searching clipper ${clip.clipper}`);
      try {
        await selectDiscordMember(activeDiscordPage, "Clipper", clip.clipper, onLog);
      } catch (err) {
        onLog(`Clipper search failed for "${clip.clipper}": ${err.message}`);
        clip.state = ClipState.CLIPPER_NOT_FOUND;
        clip.discordResult = DiscordResult.FAILED;
        clip.cleanframeMark = CleanframeMarkResult.NOT_REQUIRED;
        clip.cleanframeStatusText = "Not clicked";
        clip.overallResult = OverallReelResult.FAILED;
        clip.errorReason = err.message;
        await resetDiscordForm(activeDiscordPage, discordUrl, onLog);
        onClipUpdate(clip, { current: itemNum, total: queue.length });
        continue;
      }

      // Editor combobox
      if (isUnclaimed(clip.editor)) {
        onLog(`Editor unclaimed or empty — skipping editor selection.`);
      } else {
        onStep("Selecting editor", `Searching editor ${clip.editor}`);
        try {
          await selectDiscordMember(activeDiscordPage, "Editor", clip.editor, onLog);
        } catch (err) {
          onLog(`Editor search failed for "${clip.editor}": ${err.message}`);
          clip.state = ClipState.EDITOR_NOT_FOUND;
          clip.discordResult = DiscordResult.FAILED;
          clip.cleanframeMark = CleanframeMarkResult.NOT_REQUIRED;
          clip.cleanframeStatusText = "Not clicked";
          clip.overallResult = OverallReelResult.FAILED;
          clip.errorReason = err.message;
          await resetDiscordForm(activeDiscordPage, discordUrl, onLog);
          onClipUpdate(clip, { current: itemNum, total: queue.length });
          continue;
        }
      }

      // Caption
      onStep("Filling caption", "Setting Discord caption");
      await fillCaption(activeDiscordPage, clip.caption, onLog);

      // Post Link via CDP
      onStep("Filling Instagram URL", "Injecting verified link via CDP");
      const pageContext = (activeDiscordPage.context && typeof activeDiscordPage.context === "function")
        ? activeDiscordPage.context()
        : context;
      await fillPostLink(activeDiscordPage, clip.instagramLink, pageContext, onLog);

      if (isCancelled()) {
        await resetDiscordForm(activeDiscordPage, discordUrl, onLog);
        break;
      }

      // Final Discord Submit
      onStep("Submitting to Discord", `Clicking submit button (${clip.discordProfileName || "default"})`);
      const submitResult = await submitDiscordForm(
        activeDiscordPage,
        clip.instagramLink,
        submittedOrAttemptedLinks,
        onLog
      );

      clip.state = submitResult.status;
      if (submitResult.success) {
        clip.discordId = submitResult.submissionId;
        clip.discordResult = DiscordResult.SUCCESS;
        clip.cleanframeMark = CleanframeMarkResult.PENDING;
        clip.overallResult = OverallReelResult.NEEDS_ATTENTION; // pending Cleanframe sync
        onLog(`Discord submission confirmed: #${submitResult.submissionId} (Profile: ${clip.discordProfileName || "default"})`);
      } else {
        clip.discordResult = DiscordResult.FAILED;
        clip.cleanframeMark = CleanframeMarkResult.NOT_REQUIRED;
        clip.cleanframeStatusText = "Not clicked";
        clip.overallResult = OverallReelResult.FAILED;
        clip.errorReason = submitResult.error || "Discord submission failed";
        await resetDiscordForm(activeDiscordPage, discordUrl, onLog);
      }

      onClipUpdate(clip, { current: itemNum, total: queue.length });
      await activeDiscordPage.waitForTimeout(1000);
    } catch (err) {
      onLog(`Unexpected error during Discord processing for ${clip.instagramLink}: ${err.message}`);
      if (clip.state === ClipState.COLLECTED || !clip.discordResult) {
        clip.state = ClipState.CAPTCHA_OR_UNCERTAIN;
        clip.discordResult = DiscordResult.UNKNOWN;
        clip.cleanframeMark = CleanframeMarkResult.NOT_REQUIRED;
        clip.cleanframeStatusText = "Not clicked";
        clip.overallResult = OverallReelResult.NEEDS_ATTENTION;
        clip.errorReason = err.message;
        clip.manualAction = `Discord outcome uncertain: ${err.message}. Verify on Discord manually.`;
      }
      await resetDiscordForm(activeDiscordPage, discordUrl, onLog);
      onClipUpdate(clip, { current: itemNum, total: queue.length });
    }
  }

  // =========================================================================
  // Phase 3: Final Cleanframe Submit-Mark Synchronization & Reconciliation
  // =========================================================================
  onStep("Returning to Cleanframe", "Re-opening All Clips table for final submit-mark synchronization");
  onLog("\n=======================================================");
  onLog("Phase 3: Cleanframe Submit-Mark Reconciliation");
  onLog("=======================================================");

  let cleanframeReachable = true;
  try {
    await navigateToAllClips(websitePage, websiteUrl, onLog);
  } catch (err) {
    cleanframeReachable = false;
    onLog(`CRITICAL: Unable to return to Cleanframe All Clips table (${err.message}). Session may have expired.`);
  }

  if (!cleanframeReachable) {
    for (const clip of queue) {
      if (clip.discordResult === DiscordResult.SUCCESS) {
        clip.cleanframeMark = CleanframeMarkResult.UNKNOWN;
        clip.cleanframeStatusText = "Cleanframe unreachable / session expired";
        clip.overallResult = OverallReelResult.NEEDS_ATTENTION;
        clip.manualAction = "Open Cleanframe manually and click Submit button for this confirmed reel";
      }
    }
  } else {
    for (let i = 0; i < queue.length; i++) {
      const clip = queue[i];
      const itemNum = i + 1;

      if (clip.discordResult === DiscordResult.SUCCESS) {
        onStep("Syncing Cleanframe Submit", `Reel ${itemNum}/${queue.length}: Clicking Submit on Cleanframe`);
        onLog(`\nReconciling Cleanframe for Reel #${itemNum}: ${clip.instagramLink} (Discord ID: #${clip.discordId})`);

        try {
          const res = await clickGrozyFrameSubmitButton(websitePage, clip, onLog);

          if (res.success) {
            clip.cleanframeMark = CleanframeMarkResult.COMPLETED;
            clip.cleanframeAlreadyMarked = Boolean(res.alreadySubmitted);
            clip.greenRowConfirmed = Boolean(res.greenRowConfirmed);
            clip.cleanframeStatusText = res.greenRowConfirmed ? "Green row confirmed" : (res.alreadySubmitted ? "Already complete" : "Completed");
            clip.overallResult = OverallReelResult.COMPLETE;
            clip.state = ClipState.WEBSITE_SUBMITTED;
            clip.manualAction = null;
            onLog(`✓ Cleanframe Submit confirmed for Reel #${itemNum}: ${clip.cleanframeStatusText}`);
          } else if (res.status === "UNKNOWN") {
            clip.cleanframeMark = CleanframeMarkResult.UNKNOWN;
            clip.cleanframeStatusText = "Could not verify";
            clip.overallResult = OverallReelResult.NEEDS_ATTENTION;
            clip.manualAction = "Check Cleanframe row manually; click Submit if not yet green";
            onLog(`⚠ Cleanframe Submit ambiguous for Reel #${itemNum}: ${res.message}`);
          } else {
            clip.cleanframeMark = CleanframeMarkResult.FAILED;
            clip.cleanframeStatusText = res.message || "Failed";
            clip.overallResult = OverallReelResult.FAILED;
            clip.manualAction = "Locate row on Cleanframe and click Submit manually";
            onLog(`✕ Cleanframe Submit failed for Reel #${itemNum}: ${res.message}`);
          }
        } catch (err) {
          clip.cleanframeMark = CleanframeMarkResult.FAILED;
          clip.cleanframeStatusText = err.message;
          clip.overallResult = OverallReelResult.FAILED;
          clip.manualAction = `Error clicking Cleanframe Submit: ${err.message}`;
          onLog(`✕ Exception syncing Cleanframe for Reel #${itemNum}: ${err.message}`);
        }
      } else if (clip.discordResult === DiscordResult.SKIPPED && clip.state === ClipState.ALREADY_SUBMITTED) {
        // Reconcile row state on Cleanframe for previously submitted items
        try {
          const res = await clickGrozyFrameSubmitButton(websitePage, clip, () => {});
          if (res.alreadySubmitted || res.success) {
            clip.cleanframeMark = CleanframeMarkResult.COMPLETED;
            clip.cleanframeAlreadyMarked = true;
            clip.greenRowConfirmed = Boolean(res.greenRowConfirmed);
            clip.cleanframeStatusText = "Already complete";
          } else {
            clip.cleanframeMark = CleanframeMarkResult.NOT_REQUIRED;
            clip.cleanframeStatusText = "Not required (Skipped on Discord)";
          }
        } catch {
          clip.cleanframeMark = CleanframeMarkResult.NOT_REQUIRED;
          clip.cleanframeStatusText = "Not required (Skipped on Discord)";
        }
        clip.overallResult = OverallReelResult.SKIPPED;
      } else {
        // For any reel that was NOT successfully submitted to Discord, NEVER CLICK SUBMIT!
        clip.cleanframeMark = CleanframeMarkResult.NOT_REQUIRED;
        clip.cleanframeStatusText = "Not clicked";
        if (clip.discordResult === DiscordResult.UNKNOWN) {
          clip.overallResult = OverallReelResult.NEEDS_ATTENTION;
          clip.manualAction = "Discord submission outcome was uncertain. Reconcile on Discord and Cleanframe manually.";
        } else if (clip.discordResult === DiscordResult.SKIPPED) {
          clip.overallResult = OverallReelResult.SKIPPED;
        } else {
          clip.overallResult = OverallReelResult.FAILED;
          clip.manualAction = clip.errorReason || "Discord submission failed. Cleanframe Submit skipped.";
        }
        onLog(`Reel #${itemNum}: Discord submission was not successful (${clip.discordResult}) → Cleanframe Submit skipped.`);
      }

      onClipUpdate(clip, { current: itemNum, total: queue.length });
    }
  }

  const summary = generateSummary(queue, totalRowCount);

  // Determine final status
  let finalStatus = JobStatus.COMPLETED;
  if (!summary.allReconciled || summary.needsAttention > 0) {
    finalStatus = summary.fullyCompleted > 0 ? JobStatus.COMPLETED_WITH_WARNINGS : JobStatus.FAILED;
    onStep(
      finalStatus === JobStatus.COMPLETED_WITH_WARNINGS ? "Completed with warnings" : "Failed",
      `${summary.fullyCompleted}/${queue.length} completed, ${summary.needsAttention} need attention`
    );
  } else if (summary.overallFailed > 0) {
    finalStatus = summary.fullyCompleted > 0 ? JobStatus.COMPLETED_WITH_WARNINGS : JobStatus.FAILED;
    onStep("Completed with failures", `${summary.fullyCompleted}/${queue.length} completed, ${summary.overallFailed} failed`);
  } else {
    onStep("Completed", `All ${queue.length} reels fully reconciled`);
  }

  onLog("\n=======================================================");
  onLog("DUAL SUBMISSION RECONCILIATION SUMMARY");
  onLog("=======================================================");
  onLog(`Total Eligible Reels:       ${summary.totalEligible}`);
  onLog(`Discord Submissions Success: ${summary.discordSuccess}`);
  onLog(`Discord Submissions Failed:  ${summary.discordFailed}`);
  onLog(`Discord Submissions Skipped: ${summary.discordSkipped}`);
  onLog(`Cleanframe Marks Completed:  ${summary.cleanframeCompleted} (Already complete: ${summary.cleanframeAlreadyComplete})`);
  onLog(`Cleanframe Marks Failed:     ${summary.cleanframeFailed}`);
  onLog(`Cleanframe Marks Uncertain:  ${summary.cleanframeUnknown}`);
  onLog(`Fully Reconciled (Complete): ${summary.fullyCompleted}`);
  onLog(`Needs Manual Attention:     ${summary.needsAttention}`);
  onLog("=======================================================\n");

  return {
    queue,
    totalRowCount,
    status: finalStatus,
    summary
  };
}

export function generateSummary(queue = [], totalRowCount = 0) {
  const total = queue.length;
  const totalEligible = total;

  const discordSuccess = queue.filter(c => c.discordResult === DiscordResult.SUCCESS).length;
  const discordFailed = queue.filter(c => c.discordResult === DiscordResult.FAILED).length;
  const discordUnknown = queue.filter(c => c.discordResult === DiscordResult.UNKNOWN).length;
  const discordSkipped = queue.filter(c => c.discordResult === DiscordResult.SKIPPED).length;

  const cleanframeCompleted = queue.filter(c => c.cleanframeMark === CleanframeMarkResult.COMPLETED).length;
  const cleanframeAlreadyComplete = queue.filter(c => c.cleanframeAlreadyMarked).length;
  const cleanframeFailed = queue.filter(c => c.cleanframeMark === CleanframeMarkResult.FAILED).length;
  const cleanframeUnknown = queue.filter(c => c.cleanframeMark === CleanframeMarkResult.UNKNOWN).length;
  const cleanframeNotRequired = queue.filter(c => c.cleanframeMark === CleanframeMarkResult.NOT_REQUIRED).length;

  const fullyCompleted = queue.filter(c => c.overallResult === OverallReelResult.COMPLETE).length;
  const needsAttention = queue.filter(c => c.overallResult === OverallReelResult.NEEDS_ATTENTION).length;
  const skipped = queue.filter(c => c.overallResult === OverallReelResult.SKIPPED).length;
  const overallFailed = queue.filter(c => c.overallResult === OverallReelResult.FAILED).length;

  // All reconciled if no confirmed Discord submissions remain unverified on Cleanframe
  const pendingCleanframe = queue.filter(c => c.discordResult === DiscordResult.SUCCESS && c.cleanframeMark !== CleanframeMarkResult.COMPLETED).length;
  const allReconciled = pendingCleanframe === 0 && discordUnknown === 0;

  // Per-reel report table items
  const reelsReport = queue.map((c, idx) => ({
    index: idx + 1,
    id: c.id,
    reel: c.instagramLink,
    sourceId: c.sourceId || `Row #${idx + 1}`,
    publishedAccount: c.publishedOnAccount || "--",
    discordProfile: c.discordProfileName || "default",
    discordResult: c.discordResult || "UNKNOWN",
    discordId: c.discordId || null,
    cleanframeMark: c.cleanframeMark || "UNKNOWN",
    cleanframeStatusText: c.cleanframeStatusText || "--",
    greenRowConfirmed: Boolean(c.greenRowConfirmed),
    overallResult: c.overallResult || "NEEDS_ATTENTION",
    manualAction: c.manualAction || null
  }));

  // Collect any required manual actions
  const manualActions = queue
    .filter(c => c.manualAction)
    .map(c => `Row #${c.index || (queue.indexOf(c) + 1)} (${c.instagramLink}): ${c.manualAction}`);

  return {
    total,
    totalEligible,
    totalRowCount,
    // Discord metrics
    discordSuccess,
    discordFailed,
    discordUnknown,
    discordSkipped,
    // Cleanframe metrics
    cleanframeCompleted,
    cleanframeAlreadyComplete,
    cleanframeFailed,
    cleanframeUnknown,
    cleanframeNotRequired,
    // Overall outcomes
    fullyCompleted,
    needsAttention,
    skipped,
    overallFailed,
    allReconciled,
    reelsReport,
    manualActions,
    // Backwards-compatible fields
    success: fullyCompleted,
    already: cleanframeAlreadyComplete || discordSkipped,
    blocked: queue.filter(c => c.state === ClipState.BLOCKED_UNMAPPED || c.state === ClipState.BLOCKED_DISCONNECTED).length,
    failed: overallFailed + cleanframeFailed
  };
}
