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

  const caption =
    clean(
      await cells
        .nth(4)
        .locator("span[title]")
        .getAttribute("title")
        .catch(() => "")
    ) ||
    clean(await cells.nth(4).innerText().catch(() => ""))
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
 * Clicks GrozyFrame's existing Submit button for a specific reel.
 * 
 * Verifies:
 * - Row match by normalized Instagram URL
 * - Does NOT click if already showing 'Submitted ✓' (green check)
 * - Clicks the existing 'Submit' button for the exact matched row only
 * - Does NOT modify captions, creators, accounts, or other fields
 * - Waits and verifies that status transitioned to 'Submitted ✓'
 * 
 * @param {import('playwright').Page} websitePage
 * @param {string} instagramLink
 * @param {Function} log
 * @returns {Promise<{success: boolean, status: string, message: string}>}
 */
export async function clickGrozyFrameSubmitButton(websitePage, instagramLink, log = console.log) {
  if (!websitePage) {
    throw new Error("GrozyFrame websitePage is required");
  }

  const normalizedTarget = normalizeInstagramUrl(instagramLink);
  if (!normalizedTarget) {
    return {
      success: false,
      status: "INVALID_URL",
      message: `Invalid or missing Instagram link: ${instagramLink}`
    };
  }

  await websitePage.bringToFront().catch(() => {});

  const rows = websitePage.locator("tbody tr");
  const rowCount = await rows.count();

  let matchedRowIndex = -1;
  let matchedRow = null;

  for (let i = 0; i < rowCount; i++) {
    const row = rows.nth(i);
    const cells = row.locator("td");
    let link = "";
    const linkA1 = cells.nth(1).locator("a").first();
    if ((await linkA1.count()) > 0) {
      link = clean(await linkA1.getAttribute("href").catch(() => ""));
    }
    if (!link) {
      const linkA0 = cells.nth(0).locator("a").first();
      if ((await linkA0.count()) > 0) {
        link = clean(await linkA0.getAttribute("href").catch(() => ""));
      }
    }
    if (!link) {
      const text0 = await cells.nth(0).innerText().catch(() => "");
      const match = text0.match(/https?:\/\/[^\s]+/);
      if (match) link = clean(match[0]);
    }

    if (link === instagramLink || (link && normalizeInstagramUrl(link) === normalizedTarget)) {
      matchedRowIndex = i;
      matchedRow = row;
      break;
    }
  }

  if (!matchedRow) {
    log(`[GrozyFrame] No matching row found for ${instagramLink}`);
    return {
      success: false,
      status: "ROW_NOT_FOUND",
      message: `Reel URL not found in GrozyFrame table: ${instagramLink}`
    };
  }

  log(`[GrozyFrame] Matched row ${matchedRowIndex} for ${instagramLink}`);

  // Inspect column 5 (SUBMIT MARK)
  const submitCell = matchedRow.locator("td").nth(5);
  const submitButton = submitCell.locator("button").first();

  const buttonExists = await submitButton.isVisible({ timeout: 1500 }).catch(() => false);
  if (!buttonExists) {
    log(`[GrozyFrame] Row ${matchedRowIndex} does not have a button in Submit Mark column`);
    return {
      success: false,
      status: "BUTTON_NOT_FOUND",
      message: `Submit Mark button not found for row ${matchedRowIndex}`
    };
  }

  const currentButtonText = (await submitButton.innerText().catch(() => "")).trim();
  const currentTitle = (await submitButton.getAttribute("title").catch(() => "")).trim();

  // If already submitted (green check / "Submitted ✓" / title "Click to mark NOT SUBMITTED")
  if (await isRowSubmitted(matchedRow)) {
    log(`[GrozyFrame] Row ${matchedRowIndex} is already Submitted (${currentButtonText}) - skipping click`);
    return {
      success: true,
      status: "ALREADY_SUBMITTED",
      message: `Reel already marked as Submitted: ${currentButtonText}`
    };
  }

  // Verify this is the pending "Submit" button
  if (!currentButtonText.includes("Submit")) {
    log(`[GrozyFrame] Row ${matchedRowIndex} button text unexpected: "${currentButtonText}" - skipping`);
    return {
      success: false,
      status: "UNEXPECTED_BUTTON_STATE",
      message: `Unexpected button text "${currentButtonText}" for row ${matchedRowIndex}`
    };
  }

  log(`[GrozyFrame] Clicking existing Submit button for row ${matchedRowIndex}...`);
  await submitButton.scrollIntoViewIfNeeded().catch(() => {});
  await submitButton.click();

  // Wait and verify the button transitions to "Submitted ✓"
  let transitioned = false;
  let finalStatusText = "";

  for (let attempt = 0; attempt < 15; attempt++) {
    await websitePage.waitForTimeout(300);
    const updatedText = (await submitButton.innerText().catch(() => "")).trim();
    const updatedTitle = (await submitButton.getAttribute("title").catch(() => "")).trim();
    if (
      updatedText.includes("Submitted") ||
      updatedText.includes("✓") ||
      /not submitted/i.test(updatedTitle)
    ) {
      transitioned = true;
      finalStatusText = updatedText;
      break;
    }
  }

  if (transitioned) {
    log(`[GrozyFrame] Verification successful: row ${matchedRowIndex} marked as "${finalStatusText}"`);
    return {
      success: true,
      status: "SUBMITTED",
      message: `Submit button clicked and verified: ${finalStatusText}`
    };
  } else {
    const lingeringText = (await submitButton.innerText().catch(() => "")).trim();
    log(`[GrozyFrame] Warning: row ${matchedRowIndex} button clicked, but did not transition within timeout (current: "${lingeringText}")`);
    return {
      success: false,
      status: "TRANSITION_TIMEOUT",
      message: `Button clicked, but state remained "${lingeringText}"`
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

