import { clean } from "../../shared/utils.js";
import { ClipState } from "../../shared/states.js";

/**
 * Waits for and inspects Discord messages/bot responses following a Kick clip submission.
 * Returns: { success: boolean, status: ClipState, message: string }
 */
export async function verifyKickBotResponse(page, submittedUrl, submissionTimestamp, timeoutMs = 9000, log = console.log) {
  log(`Waiting up to ${timeoutMs / 1000}s for Kick bot confirmation...`);
  const deadline = Date.now() + timeoutMs;

  const successKeywords = [
    "saved",
    "submitted",
    "success",
    "accepted",
    "clip logged",
    "recorded",
    "submission #",
    "clip has been added",
    "received",
    "done"
  ];

  const failureKeywords = [
    "invalid link",
    "invalid url",
    "already submitted",
    "duplicate clip",
    "already exists",
    "error",
    "unknown command",
    "permission denied",
    "cannot submit",
    "failed to process",
    "not a valid"
  ];

  let detectedResult = null;

  while (Date.now() < deadline) {
    await page.waitForTimeout(600);

    // 1. Check for Discord CAPTCHA / human verification challenge
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const iframes = await page
      .locator('iframe[src*="hcaptcha"], iframe[src*="recaptcha"], iframe[title*="captcha"]')
      .count()
      .catch(() => 0);

    if (
      /captcha|verify you are human|are you human|verification required/i.test(bodyText) ||
      iframes > 0
    ) {
      log("CAPTCHA challenge detected on Discord!");
      return {
        success: false,
        status: ClipState.UNCERTAIN,
        message: "CAPTCHA / verification challenge encountered on Discord."
      };
    }

    // 2. Query recent messages or bot embeds in the channel
    const messageContainers = page.locator('li[id*="chat-messages-"], [class*="messageListItem-"]');
    const msgCount = await messageContainers.count().catch(() => 0);

    // Check recent messages from newest upwards
    const checkCount = Math.min(msgCount, 8);
    for (let i = msgCount - 1; i >= msgCount - checkCount && i >= 0; i--) {
      const msgItem = messageContainers.nth(i);
      const text = clean(await msgItem.innerText().catch(() => "")).toLowerCase();

      // Check failure indicators first
      for (const failKey of failureKeywords) {
        if (text.includes(failKey)) {
          log(`Kick bot failure message detected: "${failKey}"`);
          return {
            success: false,
            status: ClipState.FAILED,
            message: `Bot response: ${text.slice(0, 150)}`
          };
        }
      }

      // Check success indicators
      for (const succKey of successKeywords) {
        if (text.includes(succKey)) {
          log(`Kick bot confirmation detected: "${succKey}"`);
          return {
            success: true,
            status: ClipState.SUCCESS,
            message: `Bot confirmed: ${text.slice(0, 150)}`
          };
        }
      }
    }

    // 3. Check general channel body text for recent success text
    const lowerBody = bodyText.toLowerCase();
    for (const succKey of successKeywords) {
      if (lowerBody.slice(-1500).includes(succKey)) {
        log(`Confirmation text detected in recent channel activity: "${succKey}"`);
        return {
          success: true,
          status: ClipState.SUCCESS,
          message: `Bot confirmed: ${succKey}`
        };
      }
    }
  }

  // If timeout elapsed without clear failure or success:
  log("Timeout waiting for Kick bot response. Marking state as UNCERTAIN.");
  return {
    success: false,
    status: ClipState.UNCERTAIN,
    message: "No conclusive bot response detected within timeout. Marked UNCERTAIN to avoid duplicates."
  };
}
