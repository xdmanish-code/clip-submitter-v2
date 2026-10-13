import path from "path";
import fs from "fs";
import { clean } from "../../shared/utils.js";

function getScreenshotPath(filename) {
  const dir = path.join(process.cwd(), "data", "screenshots");
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // ignore
    }
  }
  return path.join(dir, filename);
}

/**
 * Types the first two characters of the Creator (e.g. /n3 for n3on),
 * waits for Discord autocomplete to open, finds the exact option for Kick Clipping Bot,
 * clicks it, and verifies the command form with links argument is active.
 */
export async function selectCreatorSlashCommand(page, commandName, creatorName, log = console.log, meta = {}) {
  const targetCommand = commandName.toLowerCase().replace(/^\//, "").trim();
  const twoChars = targetCommand.slice(0, 2);
  const tag = `[Kick][Job ${meta.jobId || "N/A"}][Agent ${meta.agentId || "local"}]`;

  // Ensure Discord tab is in the foreground with window & keyboard focus
  log(`${tag} Bringing Discord tab to front...`);
  await page.bringToFront();
  await page.waitForTimeout(300);

  // 1. COMPOSER_READY
  const chatBox = page.getByRole("textbox").last();
  if (!(await chatBox.count())) {
    throw new Error("Discord chat input box not found. Ensure the Kick channel is loaded and you are logged in.");
  }

  await chatBox.click();
  await page.waitForTimeout(100);

  // Clear any previous unfinished draft
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(100);
  log(`${tag} State: COMPOSER_READY`);

  // 2. PREFIX_TYPED
  const typedPrefix = `/${twoChars}`;
  log(`${tag} State: PREFIX_TYPED (${typedPrefix} for "${creatorName}")`);
  await chatBox.click();
  await page.keyboard.type(typedPrefix, { delay: 40 });
  await page.waitForTimeout(400);

  // 3. AUTOCOMPLETE_VISIBLE
  const autocompleteContainer = page.locator('[role="listbox"], [id*="autocomplete"], div[class*="autocomplete"]');
  const popupDeadline = Date.now() + 5000;
  let isOpened = false;

  while (Date.now() < popupDeadline) {
    if ((await autocompleteContainer.count()) > 0 && (await autocompleteContainer.first().isVisible().catch(() => false))) {
      isOpened = true;
      break;
    }
    await page.waitForTimeout(100);
  }

  if (!isOpened) {
    const err = new Error("AUTOCOMPLETE_DID_NOT_OPEN: Discord autocomplete dropdown did not open after typing prefix.");
    err.code = "AUTOCOMPLETE_DID_NOT_OPEN";
    throw err;
  }

  log(`${tag} State: AUTOCOMPLETE_VISIBLE`);

  // 4. Locate the visible command option whose heading exactly matches /targetCommand
  const searchDeadline = Date.now() + 6000;
  let exactOption = null;

  while (Date.now() < searchDeadline) {
    const options = page.locator('[role="option"], [id^="autocomplete-"]');
    const count = await options.count().catch(() => 0);

    for (let i = 0; i < count; i++) {
      const opt = options.nth(i);
      const isVis = await opt.isVisible().catch(() => false);
      if (!isVis) continue;

      const text = (await opt.innerText().catch(() => "")).trim();
      const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
      const firstLine = (lines[0] || "").toLowerCase().replace(/^\//, "");

      if (firstLine === targetCommand) {
        // 4. Verify that the option belongs to Kick Clipping Bot (or contains bounty/clipping info)
        const hasKickBot = text.includes("Kick Clipping Bot") || text.includes("Clipping Bot") || text.includes("bounty");
        if (text.includes("Bot") && !hasKickBot) {
          log(`[Kick] Option /${firstLine} found but belongs to another bot. Continuing search...`);
          continue;
        }
        exactOption = opt;
        break;
      }
    }

    if (exactOption) break;
    await page.waitForTimeout(200);
  }

  if (!exactOption) {
    log(`${tag} ERROR: Exact command /${targetCommand} was not found in autocomplete.`);
    const notFoundErr = new Error(`EXACT_COMMAND_NOT_FOUND: Command /${targetCommand} not found in autocomplete.`);
    notFoundErr.code = "EXACT_COMMAND_NOT_FOUND";
    throw notFoundErr;
  }

  log(`${tag} Exact command found: /${targetCommand}`);

  // Record option diagnostics
  const optionDiagnostics = await exactOption.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return {
      id: el.id,
      role: el.getAttribute("role"),
      ariaSelected: el.getAttribute("aria-selected"),
      className: el.className,
      boundingBox: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
    };
  }).catch(() => null);

  if (optionDiagnostics) {
    log(`${tag} Option diagnostics: ID=${optionDiagnostics.id}, aria-selected=${optionDiagnostics.ariaSelected}, Box=(${optionDiagnostics.boundingBox.x}, ${optionDiagnostics.boundingBox.y}, ${optionDiagnostics.boundingBox.width}x${optionDiagnostics.boundingBox.height})`);
  }

  // Screenshot BEFORE selection
  const beforeScreenshotPath = getScreenshotPath("kick_before_selection.png");
  await page.screenshot({ path: beforeScreenshotPath }).catch(() => {});
  log(`${tag} Screenshot before selection: ${beforeScreenshotPath}`);

  // 4. EXACT_COMMAND_HIGHLIGHTED & COMMAND_SELECTED
  const currentlyHighlighted = await page.evaluate(() => {
    const sel = document.querySelector('[role="option"][aria-selected="true"]');
    if (!sel) return null;
    const lines = (sel.innerText || "").trim().split("\n").map(l => l.trim().toLowerCase());
    return (lines[0] || "").replace(/^\//, "");
  });

  if (currentlyHighlighted === targetCommand) {
    log(`${tag} State: EXACT_COMMAND_HIGHLIGHTED (/${targetCommand})`);
    log(`${tag} Pressing Enter ONCE to select command...`);
    await page.keyboard.press("Enter");
  } else {
    log(`${tag} Currently highlighted: /${currentlyHighlighted || "none"}. Navigating with arrow keys to /${targetCommand}...`);
    let matched = false;
    for (let step = 0; step < 10; step++) {
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(150);
      const cur = await page.evaluate(() => {
        const sel = document.querySelector('[role="option"][aria-selected="true"]');
        if (!sel) return null;
        const lines = (sel.innerText || "").trim().split("\n").map(l => l.trim().toLowerCase());
        return (lines[0] || "").replace(/^\//, "");
      });
      if (cur === targetCommand) {
        log(`${tag} State: EXACT_COMMAND_HIGHLIGHTED (/${targetCommand})`);
        log(`${tag} Pressing Enter ONCE to select command...`);
        await page.keyboard.press("Enter");
        matched = true;
        break;
      }
    }
    if (!matched) {
      log(`${tag} Fallback: clicking exact option directly.`);
      await exactOption.click({ timeout: 2000 }).catch(() => {});
    }
  }

  log(`${tag} Waiting for command form and menu closure...`);

  // 5. COMMAND_SELECTED & LINKS_READY
  const formDeadline = Date.now() + 6000;
  let formConfirmed = false;
  let linksVisible = false;

  while (Date.now() < formDeadline) {
    const stateCheck = await page.evaluate((target) => {
      const appCmd = document.querySelector('[class*="applicationCommand"]');
      const optionPill = document.querySelector('[class*="optionPill"]');
      const editor = document.querySelector('[role="textbox"][contenteditable="true"]');
      const text = editor ? (editor.innerText || "") : "";
      const hasForm = !!appCmd || !!optionPill;
      const isTarget = text.toLowerCase().includes('/' + target) || text.toLowerCase().includes(target);
      const hasLinks = text.toLowerCase().includes('links') || (optionPill && (optionPill.textContent || "").toLowerCase().includes('links'));
      
      const popup = document.querySelector('[role="listbox"], div[class*="autocomplete"]');
      const isMenuClosed = !popup || popup.offsetHeight === 0;

      return { hasForm, isTarget, hasLinks, isMenuClosed, text };
    }, targetCommand);

    if (stateCheck.hasForm && stateCheck.isTarget && stateCheck.isMenuClosed) {
      formConfirmed = true;
      linksVisible = stateCheck.hasLinks;
      break;
    }

    // Additional fallback if still open after 1 second: try Tab
    if (Date.now() > formDeadline - 4500 && !formConfirmed) {
      const isStillOpen = await page.evaluate(() => {
        const popup = document.querySelector('[role="listbox"], div[class*="autocomplete"]');
        return !!popup && popup.offsetHeight > 0;
      });
      if (isStillOpen) {
        log(`${tag} Autocomplete still visible, sending Tab fallback...`);
        await page.keyboard.press("Tab");
        await page.waitForTimeout(300);
      }
    }

    await page.waitForTimeout(200);
  }

  // Screenshot AFTER selection
  const afterScreenshotPath = getScreenshotPath("kick_after_selection.png");
  await page.screenshot({ path: afterScreenshotPath }).catch(() => {});
  log(`${tag} Screenshot after selection: ${afterScreenshotPath}`);

  if (!formConfirmed) {
    log(`${tag} ERROR: Exact command was found but could not be selected.`);
    const selErr = new Error(`COMMAND_SELECTION_FAILED: Exact command was found but could not be selected.`);
    selErr.code = "COMMAND_SELECTION_FAILED";
    throw selErr;
  }

  log(`${tag} State: COMMAND_SELECTED (/${targetCommand})`);

  if (!linksVisible) {
    log(`${tag} ERROR: links argument missing from command form.`);
    const linksErr = new Error(`LINKS_ARGUMENT_MISSING: Command form opened but links argument was not found.`);
    linksErr.code = "LINKS_ARGUMENT_MISSING";
    throw linksErr;
  }

  log(`${tag} State: LINKS_READY`);
  return true;
}

