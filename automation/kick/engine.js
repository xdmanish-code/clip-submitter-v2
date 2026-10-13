import { ClipState, JobStatus } from "../../shared/states.js";
import { normalizeInstagramUrl } from "../../shared/utils.js";
import {
  setupKickDiscordPage,
  isAlreadySubmittedOnKickDiscord,
  submitKickClip,
  resetDiscordComposer
} from "./discord-kick.js";

export const KICK_DISCORD_URL = process.env.KICK_DISCORD_URL || "";

export function normalizeCreatorCommand(creator) {
  if (!creator) return "";
  return String(creator)
    .replace(/^@/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
}

export async function executeKickJob({
  context,
  submissionType = "kick",
  discordUrl = KICK_DISCORD_URL,
  queueOverride = null,
  reels = null,
  jobId = null,
  agentId = null,
  onStep = () => {},
  onLog = console.log,
  onClipUpdate = () => {},
  isCancelled = () => false
}) {
  // 1. Explicit Routing Guard
  if (String(submissionType).toLowerCase() === "dual") {
    throw new Error("INVALID ROUTING: Dual job attempted to execute Kick automation.");
  }

  let rawQueue = reels || queueOverride || [];

  if (rawQueue.length === 0) {
    onLog("[Kick] ERROR: No reels selected or loaded in Kick queue.");
    throw new Error("No reels selected or loaded in Kick queue.");
  }

  onLog("[Kick] Starting Kick job");
  onLog(`[Kick] Selected reels: ${rawQueue.length}`);

  // 2. Validate Discord Channel URL (Kick channel)
  const targetDiscordUrl = discordUrl || process.env.KICK_DISCORD_URL || KICK_DISCORD_URL;
  if (!targetDiscordUrl) {
    onLog("[Kick] ERROR: No Kick Discord channel URL provided.");
    throw new Error("No Kick Discord channel URL configured.");
  }

  // 3. Normalize queue items
  const queue = rawQueue.map((c, i) => {
    const clipUrl = c.url || c.clipUrl || c.instagramLink || "";
    const creator = c.creator || c.clipper || null;
    const command = c.command || (creator ? normalizeCreatorCommand(creator) : null);
    return {
      ...c,
      index: i + 1,
      clipUrl,
      creator,
      command,
      state: c.state || ClipState.PENDING
    };
  });

  // 4. Pre-flight validation
  const missingCreators = queue.filter(c => !c.creator || !c.command);
  if (missingCreators.length > 0) {
    const msg = `${missingCreators.length} selected reel${missingCreators.length > 1 ? 's are' : ' is'} missing a Creator.`;
    onLog(`[Kick] Pre-flight validation failed: ${msg}`);
    throw new Error(msg);
  }

  const missingUrls = queue.filter(c => !c.clipUrl);
  if (missingUrls.length > 0) {
    const msg = `${missingUrls.length} selected reel${missingUrls.length > 1 ? 's are' : ' is'} missing a Reel URL.`;
    onLog(`[Kick] Pre-flight validation failed: ${msg}`);
    throw new Error(msg);
  }

  // 5. Open Discord ONCE at the start of batch
  onStep("Opening Kick Discord", "Loading Kick clipping #commands channel once");
  onLog("[Kick] Opening Kick Discord channel");
  const kickDiscordPage = await setupKickDiscordPage(context, targetDiscordUrl, onLog);
  onLog("[Kick] Discord ready");

  if (isCancelled()) throw new Error("Job cancelled by user.");

  const submittedOrAttemptedSet = new Set();

  // 6. Process ALL reels in the SAME kickDiscordPage without reloading
  for (let i = 0; i < queue.length; i++) {
    if (isCancelled()) {
      onLog("[Kick] Cancellation requested. Stopping safely before next clip...");
      break;
    }

    const clip = queue[i];
    const itemNum = i + 1;
    const normUrl = normalizeInstagramUrl(clip.clipUrl);

    onLog(`\n[Kick] Reel ${itemNum}/${queue.length}`);
    onLog(`[Kick] Creator: ${clip.creator}`);
    onLog(`[Kick] Command: /${clip.command}`);

    clip.state = ClipState.PROCESSING;
    onClipUpdate(clip, { current: itemNum, total: queue.length });

    // In-memory duplicate check
    if (
      submittedOrAttemptedSet.has(clip.clipUrl) ||
      (normUrl && submittedOrAttemptedSet.has(normUrl))
    ) {
      onLog(`[Kick] Duplicate protection: ${clip.clipUrl} was already attempted in this session. Skipping.`);
      clip.state = ClipState.SKIPPED;
      clip.errorReason = "Duplicate URL in current session";
      onClipUpdate(clip, { current: itemNum, total: queue.length });
      continue;
    }

    // In-chat history check
    const alreadyInDiscord = await isAlreadySubmittedOnKickDiscord(kickDiscordPage, clip.clipUrl, onLog);
    if (alreadyInDiscord) {
      onLog(`[Kick] Discord history check: Exact clip URL found in recent history. Marking SKIPPED.`);
      clip.state = ClipState.SKIPPED;
      clip.errorReason = "Already present in Discord history";
      submittedOrAttemptedSet.add(clip.clipUrl);
      if (normUrl) submittedOrAttemptedSet.add(normUrl);
      onClipUpdate(clip, { current: itemNum, total: queue.length });
      continue;
    }

    if (isCancelled()) break;

    // Execute slash command submission on the same page
    try {
      onStep("Submitting Kick clip", `/${clip.command} links [${clip.clipUrl}]`);
      const result = await submitKickClip(kickDiscordPage, context, clip, submittedOrAttemptedSet, onLog, { jobId, agentId });

      clip.state = result.status;
      clip.discordMessage = result.message;

      if (!result.success) {
        clip.errorReason = result.message;
      }

      onClipUpdate(clip, { current: itemNum, total: queue.length });
      onLog(`[Kick] Reel ${itemNum} complete`);
    } catch (err) {
      const isCmdNotFound = err.code === "COMMAND_NOT_FOUND" || err.code === "EXACT_COMMAND_NOT_FOUND" || err.message.includes("COMMAND_NOT_FOUND") || err.message.includes("EXACT_COMMAND_NOT_FOUND");
      clip.state = isCmdNotFound ? "COMMAND_NOT_FOUND" : ClipState.FAILED;
      clip.errorReason = err.message;
      onLog(`[Kick] Reel ${itemNum} result: ${clip.state} (${err.message})`);
      await resetDiscordComposer(kickDiscordPage, onLog);
      onClipUpdate(clip, { current: itemNum, total: queue.length });
    }
  }

  onStep("Completed", "All Kick clips processed");
  onLog("\n[Kick] Submission batch completed.");

  const summary = generateKickSummary(queue);
  return {
    queue,
    summary
  };
}

export function generateKickSummary(queue) {
  const total = queue.length;
  const success = queue.filter(c => c.state === ClipState.SUCCESS).length;
  const failed = queue.filter(c => c.state === ClipState.FAILED).length;
  const uncertain = queue.filter(c => c.state === ClipState.UNCERTAIN).length;
  const skipped = queue.filter(c => c.state === ClipState.SKIPPED).length;

  return {
    total,
    success,
    failed,
    uncertain,
    skipped
  };
}
