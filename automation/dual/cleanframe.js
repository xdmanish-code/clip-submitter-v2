import { clean, normalizeInstagramUrl } from "../../shared/utils.js";
import { ClipState } from "../../shared/states.js";

/**
 * Extracts submission metadata from a Cleanframe table row.
 */
/**
 * Extracts submission metadata from a Cleanframe table row.
 */
export async function readSubmission(page, row) {
  const cells = row.locator("td");

  let instagramLink = "";
  const linkA1 = cells.nth(1).locator("a").first();
  if ((await linkA1.count()) > 0) {
    instagramLink = clean(await linkA1.getAttribute("href").catch(() => ""));
  }

  // Fallback to Column 0 (Clip Name & Source Link) if Column 1 does not contain <a> tag
  if (!instagramLink) {
    const linkA0 = cells.nth(0).locator("a").first();
    if ((await linkA0.count()) > 0) {
      instagramLink = clean(await linkA0.getAttribute("href").catch(() => ""));
    }
  }

  // Fallback regex in Column 0 text
  if (!instagramLink) {
    const text0 = await cells.nth(0).innerText().catch(() => "");
    const match = text0.match(/https?:\/\/[^\s]+/);
    if (match) {
      instagramLink = clean(match[0]);
    }
  }

  const editor = clean(await cells.nth(2).innerText().catch(() => ""))
    .replace(/\s*Copy\s*$/i, "")
    .trim();

  const clipper = clean(await cells.nth(3).innerText().catch(() => ""))
    .replace(/\s*Copy\s*$/i, "")
    .trim();

  let caption = "";
  try {
    const loc = cells.nth(4).locator("span[title]");
    const targetSpan = typeof loc.first === "function" ? loc.first() : loc;
    if (typeof targetSpan.getAttribute === "function") {
      caption = clean(await targetSpan.getAttribute("title", { timeout: 1500 }).catch(() => ""));
    }
  } catch {}

  if (!caption) {
    caption = clean(await cells.nth(4).innerText().catch(() => ""))
      .replace(/\s*Copy\s*$/i, "")
      .trim();
  }

  const publishedOnAccount = clean(await cells.nth(6).innerText().catch(() => ""))
    .replace(/\s*Copy\s*$/i, "")
    .trim();

  const publishStatus = clean(await cells.nth(7).innerText().catch(() => ""))
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
    caption,
    publishedOnAccount,
    publishStatus
  };
}

/**
 * Navigates Cleanframe page to 'All Clips' view.
 */
export async function navigateToAllClips(websitePage, websiteUrl, log = console.log) {
  log("Navigating to Cleanframe dashboard...");
  await websitePage.goto(websiteUrl, {
    waitUntil: "domcontentloaded"
  });
  await websitePage.waitForTimeout(700);

  const allClips = websitePage
    .getByText("All Clips", { exact: true })
    .first();

  if (!(await allClips.count())) {
    throw new Error('Could not find "All Clips" on Cleanframe.');
  }

  await allClips.click();
  await websitePage.waitForTimeout(700);
  log("All Clips view opened on Cleanframe.");
}

/**
 * Evaluates whether a row's Submit Mark column indicates the clip is already Submitted.
 * Distinguishes the green "Submitted ✓" status from the pending "Submit" button.
 * Does NOT use publish status (Column 7) as a substitute for submission status.
 *
 * @param {import('playwright').Locator} row
 * @returns {Promise<boolean>}
 */
export async function isRowSubmitted(row) {
  const submitCell = row.locator("td").nth(5);
  const text = (await submitCell.innerText().catch(() => "")).trim();
  const btn = submitCell.locator("button").first();
  const title = (await btn.getAttribute("title").catch(() => "")) || "";
  const hasGreenCheck = (await submitCell.locator("svg.lucide-circle-check, svg.lucide-check").count()) > 0;

  return (
    text.includes("Submitted") ||
    text.includes("✓") ||
    hasGreenCheck ||
    /not submitted/i.test(title)
  );
}

/**
 * Scans Cleanframe table top-down until the first Submitted row is found.
 * Stop-at-first-submitted contract:
 * 1. Begin scanning from the very top row (Row 1).
 * 2. Inspect each row sequentially in its original order.
 * 3. If a clip is already marked Submitted, IMMEDIATELY stop scanning.
 * 4. Load only eligible pending clips encountered before that stopping point.
 */
export async function collectQueueWithBoundary(websitePage, log = console.log) {
  log("Phase 1: Scanning Cleanframe queue from top...");

  await websitePage.evaluate(() => {
    window.scrollTo({
      top: 0,
      behavior: "instant"
    });
  });

  await websitePage.waitForTimeout(500);

  const rows = websitePage.locator("tbody tr");
  const totalRowCount = await rows.count();

  log(`Found ${totalRowCount} total table rows. Scanning from top with stop-at-first-submitted boundary...`);

  const queue = [];
  const seenUrls = new Set();

  for (let i = 0; i < totalRowCount; i++) {
    const rowNumber = i + 1;
    const row = rows.nth(i);

    // Inspect THIS row's Submit Mark column (Column 5)
    const alreadySubmitted = await isRowSubmitted(row);

    if (alreadySubmitted) {
      log(`Row ${rowNumber}: Already marked Submitted (Submit Mark column) → Queue boundary reached. Immediately stopped scanning.`);
      break;
    }

    // Row is not submitted — read submission details
    let item;
    try {
      item = await readSubmission(websitePage, row);
    } catch (err) {
      log(`Row ${rowNumber}: Error reading details (${err.message}). Skipping.`);
      continue;
    }

    const normalized = normalizeInstagramUrl(item.instagramLink);
    if (!normalized) {
      log(`Row ${rowNumber}: Invalid Instagram URL (${item.instagramLink}). Skipping.`);
      continue;
    }

    if (seenUrls.has(normalized)) {
      log(`Row ${rowNumber}: Duplicate URL in current queue (${item.instagramLink}). Skipping.`);
      continue;
    }

    seenUrls.add(normalized);
    queue.push({
      id: `clip-${i + 1}-${Date.now()}`,
      index: queue.length + 1,
      instagramLink: item.instagramLink,
      clipper: item.clipper,
      editor: item.editor,
      caption: item.caption,
      publishedOnAccount: item.publishedOnAccount || "",
      publishStatus: item.publishStatus || "",
      discordProfileId: null,
      discordProfileName: null,
      state: ClipState.COLLECTED,
      discordId: null,
      errorReason: null
    });

    log(`Row ${rowNumber}: Pending clip queued (${item.instagramLink})`);
  }

  log(`Queue collection complete. Total pending clips: ${queue.length}`);
  return { queue, totalRowCount };
}

/**
 * Evaluates whether a Cleanframe table row has visually transitioned to a green completed state.
 * Checks CSS classes, computed background colors, and checkmark icons.
 *
 * @param {import('playwright').Locator} row
 * @returns {Promise<boolean>}
 */
export async function isRowVisuallyGreen(row) {
  if (!row) return false;
  try {
    // 1. Check direct class names on row or child elements
    const hasGreenClass = await row.evaluate((el) => {
      const classStr = ((el.className || "") + " " + Array.from(el.children).map(c => c.className || "").join(" ")).toLowerCase();
      return /bg-green|green|emerald|bg-emerald|row-submitted|success|is-submitted/.test(classStr);
    }).catch(() => false);

    if (hasGreenClass) return true;

    // 2. Check computed background color on row or its td cells
    const isGreenBg = await row.evaluate((el) => {
      const checkBg = (target) => {
        if (!target) return false;
        const bg = (window.getComputedStyle(target).backgroundColor || "").toLowerCase();
        // Match rgb(r, g, b) or rgba(r, g, b, a)
        const match = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (match) {
          const r = parseInt(match[1], 10);
          const g = parseInt(match[2], 10);
          const b = parseInt(match[3], 10);
          // Green channel is dominant and distinctly green
          if (g > 90 && g > r * 1.15 && g > b * 1.15) return true;
        }
        return false;
      };

      if (checkBg(el)) return true;
      for (let i = 0; i < el.children.length; i++) {
        if (checkBg(el.children[i])) return true;
      }
      return false;
    }).catch(() => false);

    if (isGreenBg) return true;

    // 3. Check presence of green checkmark icon in Submit Mark column
    const submitCell = row.locator("td").nth(5);
    const greenIcons = await submitCell.locator("svg.lucide-circle-check, svg.lucide-check, .text-green, .text-emerald, .text-success").count().catch(() => 0);
    return greenIcons > 0;
  } catch {
    return false;
  }
}

/**
 * Clicks GrozyFrame's existing Submit button for a specific reel.
 * 
 * Verifies:
 * - Row match by stable identifier (index + sourceId) and normalized Instagram URL
 * - Does NOT click if already showing 'Submitted ✓' (green check)
 * - Clicks the existing 'Submit' button for the exact matched row only
 * - Does NOT modify captions, creators, accounts, or other fields
 * - Waits and verifies that status transitioned to 'Submitted ✓'
 * - Verifies visual green row state where available
 * - Recovers via safe re-read and single retry on ambiguous states
 * 
 * @param {import('playwright').Page} websitePage
 * @param {string|object} target
 * @param {Function} log
 * @returns {Promise<{success: boolean, status: string, message: string, greenRowConfirmed: boolean, alreadySubmitted?: boolean}>}
 */
export async function clickGrozyFrameSubmitButton(websitePage, target, log = console.log) {
  if (!websitePage) {
    throw new Error("Cleanframe websitePage is required");
  }

  const instagramLink = typeof target === "string" ? target : target?.instagramLink;
  const sourceId = typeof target === "object" ? target?.sourceId : null;
  const originalRowIndex = typeof target === "object" ? target?.originalRowIndex : -1;

  const normalizedTarget = normalizeInstagramUrl(instagramLink);
  if (!normalizedTarget) {
    return {
      success: false,
      status: "INVALID_URL",
      message: `Invalid or missing Instagram link: ${instagramLink}`,
      greenRowConfirmed: false
    };
  }

  await websitePage.bringToFront().catch(() => {});

  const rows = websitePage.locator("tbody tr");
  const rowCount = await rows.count();

  let matchedRowIndex = -1;
  let matchedRow = null;

  // Fast path: if originalRowIndex is within bounds, test it first
  if (originalRowIndex >= 0 && originalRowIndex < rowCount) {
    const candidateRow = rows.nth(originalRowIndex);
    const cells = candidateRow.locator("td");
    const linkA1 = cells.nth(1).locator("a").first();
    let candLink = "";
    if ((await linkA1.count().catch(() => 0)) > 0) {
      candLink = clean(await linkA1.getAttribute("href").catch(() => ""));
    }
    if (candLink === instagramLink || (candLink && normalizeInstagramUrl(candLink) === normalizedTarget)) {
      matchedRowIndex = originalRowIndex;
      matchedRow = candidateRow;
    }
  }

  // Full scan if not found in fast path
  if (!matchedRow) {
    for (let i = 0; i < rowCount; i++) {
      const row = rows.nth(i);
      const cells = row.locator("td");
      let link = "";
      const linkA1 = cells.nth(1).locator("a").first();
      if ((await linkA1.count().catch(() => 0)) > 0) {
        link = clean(await linkA1.getAttribute("href").catch(() => ""));
      }
      if (!link) {
        const linkA0 = cells.nth(0).locator("a").first();
        if ((await linkA0.count().catch(() => 0)) > 0) {
          link = clean(await linkA0.getAttribute("href").catch(() => ""));
        }
      }
      if (!link) {
        const text0 = await cells.nth(0).innerText().catch(() => "");
        const match = text0.match(/https?:\/\/[^\s]+/);
        if (match) link = clean(match[0]);
      }

      if (link === instagramLink || (link && normalizeInstagramUrl(link) === normalizedTarget)) {
        // Disambiguate if sourceId provided
        if (sourceId) {
          const col0Text = clean(await cells.nth(0).innerText().catch(() => "")).trim();
          if (col0Text && sourceId && !col0Text.includes(sourceId) && !sourceId.includes(col0Text)) {
            continue;
          }
        }
        matchedRowIndex = i;
        matchedRow = row;
        break;
      }
    }
  }

  if (!matchedRow) {
    log(`[Cleanframe] No matching row found for ${instagramLink}`);
    return {
      success: false,
      status: "ROW_NOT_FOUND",
      message: `Reel URL not found in Cleanframe table: ${instagramLink}`,
      greenRowConfirmed: false
    };
  }

  log(`[Cleanframe] Matched row #${matchedRowIndex + 1} for ${instagramLink}`);

  // Inspect column 5 (SUBMIT MARK)
  const submitCell = matchedRow.locator("td").nth(5);
  const submitButton = submitCell.locator("button").first();

  const buttonExists = await submitButton.isVisible({ timeout: 1500 }).catch(() => false);
  if (!buttonExists) {
    // Check if cell already shows submitted indicator without a button
    if (await isRowSubmitted(matchedRow)) {
      const isGreen = await isRowVisuallyGreen(matchedRow);
      log(`[Cleanframe] Row #${matchedRowIndex + 1} is already Submitted (no button active) - Green row: ${isGreen}`);
      return {
        success: true,
        alreadySubmitted: true,
        status: "ALREADY_SUBMITTED",
        message: "Row already marked as Submitted",
        greenRowConfirmed: isGreen
      };
    }
    log(`[Cleanframe] Row #${matchedRowIndex + 1} does not have a button in Submit Mark column`);
    return {
      success: false,
      status: "BUTTON_NOT_FOUND",
      message: `Submit Mark button not found for row #${matchedRowIndex + 1}`,
      greenRowConfirmed: false
    };
  }

  const currentButtonText = (await submitButton.innerText().catch(() => "")).trim();

  // If already submitted (green check / "Submitted ✓" / title "Click to mark NOT SUBMITTED")
  if (await isRowSubmitted(matchedRow)) {
    const isGreen = await isRowVisuallyGreen(matchedRow);
    log(`[Cleanframe] Row #${matchedRowIndex + 1} is already Submitted (${currentButtonText}) - Green row: ${isGreen} - skipping click`);
    return {
      success: true,
      alreadySubmitted: true,
      status: "ALREADY_SUBMITTED",
      message: `Reel already marked as Submitted (${currentButtonText})`,
      greenRowConfirmed: isGreen
    };
  }

  // Verify this is the pending "Submit" button
  if (!currentButtonText.includes("Submit")) {
    log(`[Cleanframe] Row #${matchedRowIndex + 1} button text unexpected: "${currentButtonText}" - skipping`);
    return {
      success: false,
      status: "UNEXPECTED_BUTTON_STATE",
      message: `Unexpected button text "${currentButtonText}" for row #${matchedRowIndex + 1}`,
      greenRowConfirmed: false
    };
  }

  log(`[Cleanframe] Clicking Submit button for row #${matchedRowIndex + 1}...`);
  await submitButton.scrollIntoViewIfNeeded().catch(() => {});
  await submitButton.click();

  // Wait and verify the button transitions to "Submitted ✓" / green state
  let transitioned = false;
  let finalStatusText = "";

  for (let attempt = 0; attempt < 20; attempt++) {
    await websitePage.waitForTimeout(300);
    if (await isRowSubmitted(matchedRow)) {
      transitioned = true;
      finalStatusText = (await submitButton.innerText().catch(() => "")).trim();
      break;
    }
  }

  // Recovery Re-read check if transition not immediately observed
  if (!transitioned) {
    log(`[Cleanframe] Transition not detected immediately for row #${matchedRowIndex + 1}. Performing recovery re-read...`);
    await websitePage.waitForTimeout(500);
    if (await isRowSubmitted(matchedRow)) {
      transitioned = true;
      finalStatusText = (await submitButton.innerText().catch(() => "")).trim();
    } else {
      // Safe retry once if button is still present and clickable
      const buttonStillClickable = await submitButton.isVisible({ timeout: 500 }).catch(() => false);
      const lingeringText = (await submitButton.innerText().catch(() => "")).trim();
      if (buttonStillClickable && lingeringText.includes("Submit") && !lingeringText.includes("✓")) {
        log(`[Cleanframe] Re-attempting safe click on Submit button for row #${matchedRowIndex + 1}...`);
        await submitButton.click().catch(() => {});
        for (let retryAttempt = 0; retryAttempt < 10; retryAttempt++) {
          await websitePage.waitForTimeout(300);
          if (await isRowSubmitted(matchedRow)) {
            transitioned = true;
            finalStatusText = (await submitButton.innerText().catch(() => "")).trim();
            break;
          }
        }
      }
    }
  }

  const greenRowConfirmed = await isRowVisuallyGreen(matchedRow);

  if (transitioned) {
    log(`[Cleanframe] Verification successful: row #${matchedRowIndex + 1} marked as "${finalStatusText}" (Green row: ${greenRowConfirmed})`);
    return {
      success: true,
      status: "COMPLETED",
      message: `Submit button clicked and verified: ${finalStatusText}`,
      greenRowConfirmed
    };
  } else {
    const lingeringText = (await submitButton.innerText().catch(() => "")).trim();
    log(`[Cleanframe] Warning: row #${matchedRowIndex + 1} button clicked, but state remained "${lingeringText}" (requires attention)`);
    return {
      success: false,
      status: "UNKNOWN",
      message: `Button clicked, but state could not be verified within timeout (lingering: "${lingeringText}")`,
      greenRowConfirmed: false
    };
  }
}

/**
 * Updates Cleanframe by finding the matching row and clicking its Submit button.
 * Backwards compatibility wrapper around clickGrozyFrameSubmitButton.
 */
export async function submitWebsite(websitePage, instagramLink, log = console.log) {
  const result = await clickGrozyFrameSubmitButton(websitePage, instagramLink, log);
  return result.success;
}

