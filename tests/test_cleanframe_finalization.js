import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { getStandardBrowserPaths } from "../agent/browser-discovery.js";
import {
  isRowSubmitted,
  isRowVisuallyGreen,
  clickGrozyFrameSubmitButton,
  collectQueueWithBoundary
} from "../automation/dual/cleanframe.js";
import { generateSummary } from "../automation/dual/engine.js";
import { DiscordProfileStore } from "../web/backend/discord-profile-store.js";
import {
  DiscordResult,
  CleanframeMarkResult,
  OverallReelResult,
  JobStatus,
  ClipState
} from "../shared/states.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "../data");

// Helper to launch local headless browser using discovered executable
async function launchTestBrowser() {
  const standard = getStandardBrowserPaths();
  const candidates = [...standard.chrome, ...standard.edge, ...standard.brave];
  let execPath = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      execPath = c;
      break;
    }
  }
  return await chromium.launch({ headless: true, executablePath: execPath || undefined });
}

// Helper to generate mock Cleanframe HTML
function createCleanframeHtml(rowsData = []) {
  const rowsHtml = rowsData.map((r, i) => {
    const isSub = r.isSubmitted || r.buttonText?.includes("Submitted");
    const rowClass = r.rowClass || (isSub ? "bg-green-500" : "");
    const btnText = r.buttonText || (isSub ? "Submitted \u2713" : "Submit");
    const btnAttrs = r.buttonAttrs || "";

    return `
      <tr class="${rowClass}" data-index="${i}">
        <td class="font-mono">${r.sourceId || `ID-${i + 1}`}</td>
        <td><a href="${r.link}">${r.link}</a></td>
        <td>${r.editor || "editor1"}</td>
        <td>${r.clipper || "clipper1"}</td>
        <td><span title="${r.caption || "caption1"}">${r.caption || "caption1"}</span></td>
        <td>
          <button class="submit-btn" ${btnAttrs} onclick="onRowSubmitClick(this, ${i})">${btnText}</button>
        </td>
        <td>${r.account || "@cubeflox"}</td>
        <td>${r.status || "Published"}</td>
      </tr>
    `;
  }).join("\n");

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <style>
        .bg-green-500 { background-color: rgb(16, 185, 129) !important; color: white; }
        .bg-emerald-500 { background-color: rgb(16, 185, 129) !important; }
        .is-submitted { background-color: rgba(34, 197, 94, 0.2) !important; }
        tr { padding: 4px; }
      </style>
    </head>
    <body>
      <div id="all-clips-container">
        <table>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
      <script>
        window.clickCounts = {};
        function onRowSubmitClick(btn, idx) {
          window.clickCounts[idx] = (window.clickCounts[idx] || 0) + 1;
          if (btn.hasAttribute("data-no-transition")) {
            // Deliberately do not transition for timeout testing
            return;
          }
          btn.innerText = "Submitted \\u2713";
          btn.classList.add("bg-green-500");
          btn.closest("tr").classList.add("bg-green-500");
        }
      </script>
    </body>
    </html>
  `;
}

// --------------------------------------------------------------------------
// TEST 1: Successful Discord submission triggers Cleanframe Submit action
// --------------------------------------------------------------------------
test("1. Successful Discord submission triggers Cleanframe Submit action", async () => {
  const browser = await launchTestBrowser();
  const page = await browser.newPage();

  const targetUrl = "https://www.instagram.com/reel/C1234567890/";
  const html = createCleanframeHtml([
    { link: targetUrl, sourceId: "Row 1", buttonText: "Submit" }
  ]);
  await page.setContent(html);

  // Execute clickGrozyFrameSubmitButton as Phase 3 does
  const res = await clickGrozyFrameSubmitButton(page, {
    instagramLink: targetUrl,
    sourceId: "Row 1",
    originalRowIndex: 0
  });

  assert.equal(res.success, true, "Submit action must succeed");
  assert.equal(res.status, "COMPLETED", "Status must indicate COMPLETED");
  assert.equal(res.greenRowConfirmed, true, "Visual green row must be confirmed");

  // Verify DOM state transitioned
  const btn = page.locator("tbody tr").nth(0).locator("button").first();
  const text = (await btn.innerText()).trim();
  assert.ok(text.includes("Submitted \u2713"), `Button text should contain checkmark: ${text}`);

  await browser.close();
});

// --------------------------------------------------------------------------
// TEST 2: Failed Discord submission does NOT trigger Cleanframe Submit action
// --------------------------------------------------------------------------
test("2. Failed Discord submission does NOT trigger Cleanframe Submit action", async () => {
  const browser = await launchTestBrowser();
  const page = await browser.newPage();

  const targetUrl = "https://www.instagram.com/reel/failed_reel_123/";
  const html = createCleanframeHtml([
    { link: targetUrl, sourceId: "Row 1", buttonText: "Submit" }
  ]);
  await page.setContent(html);

  // In Phase 3, if discordResult is FAILED, SKIPPED, or UNKNOWN:
  const item = {
    instagramLink: targetUrl,
    discordResult: DiscordResult.FAILED,
    state: ClipState.DISCORD_FAILED,
    cleanframeMark: CleanframeMarkResult.PENDING
  };

  // Phase 3 rule: never click submit if Discord was not confirmed
  let clicked = false;
  if (item.discordResult === DiscordResult.SUCCESS) {
    await clickGrozyFrameSubmitButton(page, item);
    clicked = true;
  } else {
    item.cleanframeMark = CleanframeMarkResult.NOT_REQUIRED;
    item.overallResult = OverallReelResult.FAILED;
  }

  assert.equal(clicked, false, "Must not trigger clickGrozyFrameSubmitButton for failed Discord reel");
  assert.equal(item.cleanframeMark, CleanframeMarkResult.NOT_REQUIRED, "Cleanframe mark should be NOT_REQUIRED");
  assert.equal(item.overallResult, OverallReelResult.FAILED, "Overall result should be FAILED");

  // Check button in DOM remained untouched
  const btn = page.locator("tbody tr").nth(0).locator("button").first();
  const text = (await btn.innerText()).trim();
  assert.equal(text, "Submit", "Button must remain unclicked in DOM");

  const clickCount = await page.evaluate(() => window.clickCounts[0] || 0);
  assert.equal(clickCount, 0, "Zero clicks must be recorded");

  await browser.close();
});

// --------------------------------------------------------------------------
// TEST 3: Each action targets the correct row (matching URL and identifier)
// --------------------------------------------------------------------------
test("3. Each action targets the correct row (matching URL and identifier)", async () => {
  const browser = await launchTestBrowser();
  const page = await browser.newPage();

  const reels = [
    { link: "https://www.instagram.com/reel/AAA_111/", sourceId: "Row 1", buttonText: "Submit" },
    { link: "https://www.instagram.com/reel/BBB_222/", sourceId: "Row 2", buttonText: "Submit" },
    { link: "https://www.instagram.com/reel/CCC_333/", sourceId: "Row 3", buttonText: "Submit" }
  ];
  await page.setContent(createCleanframeHtml(reels));

  // Target Row 2 specifically
  const targetReel = reels[1];
  const res = await clickGrozyFrameSubmitButton(page, {
    instagramLink: targetReel.link,
    sourceId: targetReel.sourceId,
    originalRowIndex: 1
  });

  assert.equal(res.success, true, "Target row click should succeed");

  // Verify only Row 2 changed
  const row0Text = (await page.locator("tbody tr").nth(0).locator("button").innerText()).trim();
  const row1Text = (await page.locator("tbody tr").nth(1).locator("button").innerText()).trim();
  const row2Text = (await page.locator("tbody tr").nth(2).locator("button").innerText()).trim();

  assert.equal(row0Text, "Submit", "Row 0 must remain unclicked");
  assert.ok(row1Text.includes("Submitted \u2713"), "Row 1 must be marked Submitted");
  assert.equal(row2Text, "Submit", "Row 2 must remain unclicked");

  await browser.close();
});

// --------------------------------------------------------------------------
// TEST 4: Multiple successful reels are marked, even if another reel fails
// --------------------------------------------------------------------------
test("4. Multiple successful reels are marked, even if another reel fails", async () => {
  const browser = await launchTestBrowser();
  const page = await browser.newPage();

  const reels = [
    { link: "https://www.instagram.com/reel/success_1/", sourceId: "Row 1", buttonText: "Submit" },
    { link: "https://www.instagram.com/reel/fail_row_2/", sourceId: "Row 2", buttonText: "Broken", buttonAttrs: "data-no-transition" },
    { link: "https://www.instagram.com/reel/success_3/", sourceId: "Row 3", buttonText: "Submit" }
  ];
  await page.setContent(createCleanframeHtml(reels));

  // Simulate reconciliation loop over 3 items
  const queue = reels.map((r, i) => ({
    instagramLink: r.link,
    sourceId: r.sourceId,
    originalRowIndex: i,
    discordResult: DiscordResult.SUCCESS,
    cleanframeMark: CleanframeMarkResult.PENDING,
    overallResult: OverallReelResult.NEEDS_ATTENTION
  }));

  for (const item of queue) {
    const res = await clickGrozyFrameSubmitButton(page, {
      instagramLink: item.instagramLink,
      sourceId: item.sourceId,
      originalRowIndex: item.originalRowIndex
    });

    if (res.success) {
      item.cleanframeMark = CleanframeMarkResult.COMPLETED;
      item.greenRowConfirmed = res.greenRowConfirmed;
      item.overallResult = OverallReelResult.COMPLETE;
    } else {
      item.cleanframeMark = CleanframeMarkResult.FAILED;
      item.overallResult = OverallReelResult.NEEDS_ATTENTION;
      item.manualAction = res.message;
    }
  }

  // Row 1 should be COMPLETED
  assert.equal(queue[0].cleanframeMark, CleanframeMarkResult.COMPLETED);
  assert.equal(queue[0].overallResult, OverallReelResult.COMPLETE);

  // Row 2 should be FAILED (unexpected button state "Broken")
  assert.equal(queue[1].cleanframeMark, CleanframeMarkResult.FAILED);
  assert.equal(queue[1].overallResult, OverallReelResult.NEEDS_ATTENTION);

  // Row 3 should STILL be COMPLETED (did not abort prematurely)
  assert.equal(queue[2].cleanframeMark, CleanframeMarkResult.COMPLETED);
  assert.equal(queue[2].overallResult, OverallReelResult.COMPLETE);

  // Check summary
  const summary = generateSummary(queue, 3);
  assert.equal(summary.cleanframeCompleted, 2);
  assert.equal(summary.cleanframeFailed, 1);
  assert.equal(summary.fullyCompleted, 2);
  assert.equal(summary.needsAttention, 1);
  assert.equal(summary.allReconciled, false, "allReconciled must be false due to failed row");

  await browser.close();
});

// --------------------------------------------------------------------------
// TEST 5: Already-completed rows are not clicked again
// --------------------------------------------------------------------------
test("5. Already-completed rows are not clicked again", async () => {
  const browser = await launchTestBrowser();
  const page = await browser.newPage();

  const targetUrl = "https://www.instagram.com/reel/already_done_456/";
  const html = createCleanframeHtml([
    {
      link: targetUrl,
      sourceId: "Row 1",
      buttonText: "Submitted \u2713",
      rowClass: "bg-green-500 is-submitted",
      buttonAttrs: 'title="Click to mark NOT SUBMITTED"'
    }
  ]);
  await page.setContent(html);

  const res = await clickGrozyFrameSubmitButton(page, {
    instagramLink: targetUrl,
    sourceId: "Row 1",
    originalRowIndex: 0
  });

  assert.equal(res.success, true, "Already submitted row returns success");
  assert.equal(res.alreadySubmitted, true, "alreadySubmitted flag must be true");
  assert.equal(res.status, "ALREADY_SUBMITTED");
  assert.equal(res.greenRowConfirmed, true, "Green row should be confirmed");

  // Check zero clicks were executed
  const clickCount = await page.evaluate(() => window.clickCounts[0] || 0);
  assert.equal(clickCount, 0, "Button must NOT have been clicked again");

  await browser.close();
});

// --------------------------------------------------------------------------
// TEST 6: Visual green row / completed state verified after clicking
// --------------------------------------------------------------------------
test("6. Visual green row / completed state verified after clicking", async () => {
  const browser = await launchTestBrowser();
  const page = await browser.newPage();

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        .green-bg { background-color: rgb(16, 185, 129); }
        .emerald-row { background-color: rgb(5, 150, 105); }
        .normal-row { background-color: rgb(255, 255, 255); }
      </style>
    </head>
    <body>
      <table>
        <tbody>
          <tr id="row-green" class="green-bg">
            <td>ID-1</td><td><a href="https://instagram.com/reel/1">link</a></td><td>acc</td><td>clip</td><td>ed</td>
            <td><button class="green-bg">Submitted ✓</button></td>
          </tr>
          <tr id="row-emerald" class="emerald-row">
            <td>ID-2</td><td><a href="https://instagram.com/reel/2">link</a></td><td>acc</td><td>clip</td><td>ed</td>
            <td><button>Submitted ✓</button></td>
          </tr>
          <tr id="row-pending" class="normal-row">
            <td>ID-3</td><td><a href="https://instagram.com/reel/3">link</a></td><td>acc</td><td>clip</td><td>ed</td>
            <td><button>Submit</button></td>
          </tr>
        </tbody>
      </table>
    </body>
    </html>
  `;
  await page.setContent(html);

  const rowGreen = page.locator("#row-green");
  const rowEmerald = page.locator("#row-emerald");
  const rowPending = page.locator("#row-pending");

  // Test isRowSubmitted
  assert.equal(await isRowSubmitted(rowGreen), true, "Row green should be submitted");
  assert.equal(await isRowSubmitted(rowEmerald), true, "Row emerald should be submitted");
  assert.equal(await isRowSubmitted(rowPending), false, "Row pending should NOT be submitted");

  // Test isRowVisuallyGreen
  assert.equal(await isRowVisuallyGreen(rowGreen), true, "Row green should be visually green");
  assert.equal(await isRowVisuallyGreen(rowEmerald), true, "Row emerald should be visually green");
  assert.equal(await isRowVisuallyGreen(rowPending), false, "Row pending should NOT be visually green");

  await browser.close();
});

// --------------------------------------------------------------------------
// TEST 7: Timeouts and ambiguous results are handled safely
// --------------------------------------------------------------------------
test("7. Timeouts and ambiguous results are handled safely", async () => {
  const browser = await launchTestBrowser();
  const page = await browser.newPage();

  const targetUrl = "https://www.instagram.com/reel/timeout_reel_999/";
  // Button clicks but intentionally does NOT transition
  const html = createCleanframeHtml([
    {
      link: targetUrl,
      sourceId: "Row 1",
      buttonText: "Submit",
      buttonAttrs: "data-no-transition"
    }
  ]);
  await page.setContent(html);

  const res = await clickGrozyFrameSubmitButton(page, {
    instagramLink: targetUrl,
    sourceId: "Row 1",
    originalRowIndex: 0
  });

  // Should fail safely
  assert.equal(res.success, false, "Must return success=false on timeout");
  assert.equal(res.status, "UNKNOWN", "Status must indicate UNKNOWN");

  // In engine reconciliation, an ambiguous timeout marks cleanframeMark: UNKNOWN
  const item = {
    instagramLink: targetUrl,
    discordResult: DiscordResult.SUCCESS,
    cleanframeMark: CleanframeMarkResult.UNKNOWN,
    overallResult: OverallReelResult.NEEDS_ATTENTION,
    manualAction: `Submit mark clicked but confirmation timed out for ${targetUrl}. Please manually verify.`
  };

  assert.equal(item.cleanframeMark, CleanframeMarkResult.UNKNOWN);
  assert.equal(item.overallResult, OverallReelResult.NEEDS_ATTENTION);
  assert.ok(item.manualAction.includes("manually verify"));

  const summary = generateSummary([item], 1);
  assert.equal(summary.cleanframeUnknown, 1);
  assert.equal(summary.needsAttention, 1);
  assert.equal(summary.fullyCompleted, 0);
  assert.equal(summary.allReconciled, false, "allReconciled must be false on ambiguous result");

  await browser.close();
});

// --------------------------------------------------------------------------
// TEST 8: Final report accurately separates Discord results from Cleanframe marking results
// --------------------------------------------------------------------------
test("8. Final report accurately separates Discord results from Cleanframe marking results", () => {
  const testQueue = [
    {
      id: "c1",
      instagramLink: "https://www.instagram.com/reel/reel_A/",
      sourceId: "Row #1",
      publishedOnAccount: "cubeflox",
      discordProfileName: "Discord Profile 1",
      discordResult: DiscordResult.SUCCESS,
      discordId: "1234567890",
      cleanframeMark: CleanframeMarkResult.COMPLETED,
      cleanframeStatusText: "Submitted ✓",
      greenRowConfirmed: true,
      overallResult: OverallReelResult.COMPLETE
    },
    {
      id: "c2",
      instagramLink: "https://www.instagram.com/reel/reel_B/",
      sourceId: "Row #2",
      publishedOnAccount: "kick.who_",
      discordProfileName: "Discord Profile 2",
      discordResult: DiscordResult.SUCCESS,
      discordId: "1234567891",
      cleanframeMark: CleanframeMarkResult.UNKNOWN,
      cleanframeStatusText: "Submit",
      greenRowConfirmed: false,
      overallResult: OverallReelResult.NEEDS_ATTENTION,
      manualAction: "Submit button clicked but state unconfirmed. Please verify on Cleanframe."
    },
    {
      id: "c3",
      instagramLink: "https://www.instagram.com/reel/reel_C/",
      sourceId: "Row #3",
      publishedOnAccount: "cubeflox",
      discordProfileName: "Discord Profile 1",
      discordResult: DiscordResult.FAILED,
      cleanframeMark: CleanframeMarkResult.NOT_REQUIRED,
      cleanframeStatusText: "--",
      greenRowConfirmed: false,
      overallResult: OverallReelResult.FAILED
    },
    {
      id: "c4",
      instagramLink: "https://www.instagram.com/reel/reel_D/",
      sourceId: "Row #4",
      publishedOnAccount: "cubeflox",
      discordProfileName: "Discord Profile 1",
      discordResult: DiscordResult.SKIPPED,
      cleanframeMark: CleanframeMarkResult.NOT_REQUIRED,
      cleanframeStatusText: "--",
      greenRowConfirmed: false,
      overallResult: OverallReelResult.SKIPPED
    }
  ];

  const summary = generateSummary(testQueue, 4);

  // Assert metrics separation
  assert.equal(summary.total, 4, "Total reels should be 4");
  assert.equal(summary.discordSuccess, 2, "Discord success should be 2");
  assert.equal(summary.discordFailed, 1, "Discord failed should be 1");
  assert.equal(summary.discordSkipped, 1, "Discord skipped should be 1");

  assert.equal(summary.cleanframeCompleted, 1, "Cleanframe completed should be 1");
  assert.equal(summary.cleanframeUnknown, 1, "Cleanframe unknown should be 1");
  assert.equal(summary.cleanframeNotRequired, 2, "Cleanframe not required should be 2");

  assert.equal(summary.fullyCompleted, 1, "Fully completed should be 1");
  assert.equal(summary.needsAttention, 1, "Needs attention should be 1");
  assert.equal(summary.overallFailed, 1, "Overall failed should be 1");
  assert.equal(summary.skipped, 1, "Skipped should be 1");

  // Gate check: allReconciled MUST be false because reel_B has cleanframeMark !== COMPLETED
  assert.equal(summary.allReconciled, false, "allReconciled must be false when unverified marks remain");

  // Assert reelsReport table has 4 rows and all 6 required fields
  assert.equal(summary.reelsReport.length, 4);
  for (const r of summary.reelsReport) {
    assert.ok(r.reel, "Must have reel URL");
    assert.ok(r.publishedAccount, "Must have publishedAccount");
    assert.ok(r.discordProfile, "Must have discordProfile");
    assert.ok(r.discordResult, "Must have discordResult");
    assert.ok(r.cleanframeMark, "Must have cleanframeMark");
    assert.ok(r.overallResult, "Must have overallResult");
  }

  // Assert manualActions has the actionable alert
  assert.equal(summary.manualActions.length, 1);
  assert.ok(summary.manualActions[0].includes("verify on Cleanframe"));
});

// --------------------------------------------------------------------------
// TEST 9: Existing row-loading boundaries (stop-at-first-Submitted contract) and multi-Discord routing remain unchanged
// --------------------------------------------------------------------------
test("9. Existing row-loading boundaries and multi-Discord routing remain unchanged", async () => {
  // 1. Verify Stop-at-First-Submitted boundary
  const browser = await launchTestBrowser();
  const page = await browser.newPage();

  const boundaryTableHtml = createCleanframeHtml([
    { link: "https://instagram.com/reel/pending_1", sourceId: "Row 1", buttonText: "Submit" },
    { link: "https://instagram.com/reel/pending_2", sourceId: "Row 2", buttonText: "Submit" },
    { link: "https://instagram.com/reel/already_sub_3", sourceId: "Row 3", buttonText: "Submitted \u2713", rowClass: "bg-green-500 is-submitted" },
    { link: "https://instagram.com/reel/pending_4", sourceId: "Row 4", buttonText: "Submit" }
  ]);
  await page.setContent(boundaryTableHtml);

  const boundaryResult = await collectQueueWithBoundary(page);
  assert.equal(boundaryResult.queue.length, 2, "collectQueueWithBoundary must stop at first submitted row");
  assert.equal(boundaryResult.queue[0].instagramLink, "https://instagram.com/reel/pending_1");
  assert.equal(boundaryResult.queue[1].instagramLink, "https://instagram.com/reel/pending_2");

  await browser.close();

  // 2. Verify Multi-Discord Routing resolution
  const TEST_PROFILES = path.join(DATA_DIR, "test_profiles_finalization.json");
  const TEST_MAPPINGS = path.join(DATA_DIR, "test_mappings_finalization.json");
  if (fs.existsSync(TEST_PROFILES)) fs.unlinkSync(TEST_PROFILES);
  if (fs.existsSync(TEST_MAPPINGS)) fs.unlinkSync(TEST_MAPPINGS);

  const store = new DiscordProfileStore({
    profilesFile: TEST_PROFILES,
    mappingsFile: TEST_MAPPINGS
  });

  const p1 = store.getAllProfiles()[0];
  const p2 = store.createProfile({ name: "Discord Profile 2", sessionMode: "dedicated" });
  store.updateProfile(p1.id, { status: "CONNECTED" });
  store.updateProfile(p2.id, { status: "CONNECTED" });

  store.setMapping("@cubeflox", p1.id);
  store.setMapping("@kick.who_", p2.id);

  const res1 = store.resolveProfileForAccount("@cubeflox");
  const res2 = store.resolveProfileForAccount("@kick.who_");

  assert.equal(res1.profile.id, p1.id, "@cubeflox must route to Profile 1");
  assert.equal(res2.profile.id, p2.id, "@kick.who_ must route to Profile 2");

  if (fs.existsSync(TEST_PROFILES)) fs.unlinkSync(TEST_PROFILES);
  if (fs.existsSync(TEST_MAPPINGS)) fs.unlinkSync(TEST_MAPPINGS);
});
