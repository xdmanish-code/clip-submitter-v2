import { clean, normalizeUsername, isUnclaimed, escapeRegex, normalizeInstagramUrl } from "../../shared/utils.js";
import { ClipState } from "../../shared/states.js";

/**
 * Checks if the target Instagram URL or shortcode is already visible in recent Discord history.
 */
export async function isAlreadySubmittedOnDiscord(discordPage, targetUrl, log = console.log) {
  const normalizedTarget = normalizeInstagramUrl(targetUrl);
  if (!normalizedTarget) return false;

  try {
    // 1. Check visible links in Discord
    const links = await discordPage.locator('a[href*="instagram.com"]').all();
    for (const link of links) {
      const href = await link.getAttribute("href").catch(() => "");
      if (href && normalizeInstagramUrl(href) === normalizedTarget) {
        log(`Discord history check: Found matching link ${href}`);
        return true;
      }
    }

    // 2. Check visible text in messages container or body
    const bodyText = await discordPage.locator("body").innerText().catch(() => "");
    if (bodyText.includes(targetUrl) || bodyText.includes(normalizedTarget)) {
      log(`Discord history check: Found URL text in chat body.`);
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
        log(`Discord history check: Found shortcode match "${shortcode}" in body text.`);
        return true;
      }
    }
  } catch (err) {
    log(`Notice: Discord history check error: ${err.message}`);
  }

  return false;
}

/**
 * Triggers Discord slash command /submit and selects the Instagram option.
 */
export async function startDiscordSubmit(page, log = console.log) {
  log("Focusing Discord chat and typing /submit...");
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
    throw new Error("Instagram option did not appear within 8 seconds.");
  }

  await instagram.click();
  await page.waitForTimeout(300);
  await box.press("Enter");
  await page.waitForTimeout(900);

  log("Discord /submit Instagram modal opened.");
}

/**
 * Finds Discord user picker combobox by index.
 */
export async function getDiscordPicker(page, index, label) {
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

  throw new Error(`${label} picker not found within 8 seconds.`);
}

/**
 * Searches and selects a Discord member in the combobox with progressive prefix fallback.
 */
export async function selectDiscordMember(page, label, username, log = console.log) {
  const target = normalizeUsername(username);
  const pickerIndex = label.toLowerCase().includes("clipper") ? 0 : 1;

  log(`Searching Discord member for ${label}: "${username}"...`);
  const picker = await getDiscordPicker(page, pickerIndex, label);
  await picker.click();

  for (let length = target.length; length >= 1; length--) {
    const query = target.slice(0, length);
    await picker.fill("");

    for (const character of query) {
      await picker.press(character);
      await page.waitForTimeout(180);
    }

    await page.waitForTimeout(500);

    const options = page.locator('[role="option"]:visible');
    const count = await options.count();

    for (let i = 0; i < count; i++) {
      const option = options.nth(i);
      const text = clean(await option.innerText().catch(() => ""));

      if (
        normalizeUsername(text).includes(target) ||
        new RegExp(`(^|\\s)${escapeRegex(target)}(\\s|$)`, "i").test(text)
      ) {
        log(`${label} found: ${text.replace(/\n/g, " / ")}`);
        await option.click();
        return;
      }
    }
  }

  throw new Error(`Could not find Discord ${label}: ${username}`);
}

/**
 * Fills caption textarea in the Discord submit form.
 */
export async function fillCaption(page, caption, log = console.log) {
  const textarea = page.locator("textarea").first();

  if (!(await textarea.count())) {
    throw new Error("Discord Caption field not found.");
  }

  await textarea.fill(caption);
  log("Discord caption filled.");
}

/**
 * Injects Post Link using CDP session to bypass virtual DOM placeholder limitations.
 */
export async function fillPostLink(page, url, context, log = console.log) {
  log("Injecting Instagram URL via CDP session...");
  const session = await context.newCDPSession(page);

  const result = await session.send("Runtime.evaluate", {
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
  });

  if (result.result.value === "URL FIELD NOT FOUND") {
    throw new Error("Discord Post Link field not found.");
  }

  await session.send("Input.insertText", {
    text: url
  });

  const verify = await session.send("Runtime.evaluate", {
    expression: `(() => {
      const e = [...document.querySelectorAll("input")]
        .find(x => x.placeholder === "https://...");

      return e ? e.value : "URL FIELD NOT FOUND";
    })()`,
    returnByValue: true
  });

  const actual = verify.result?.value;

  if (actual !== url) {
    throw new Error(`Post Link verification failed. Expected ${url}, got ${actual}`);
  }

  log(`Post Link verified: ${actual}`);
}

/**
 * Resets Discord submission form in case of error or skip.
 */
export async function resetDiscordForm(page, discordUrl, log = console.log) {
  try {
    log("Resetting Discord modal form...");
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(200);
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);

    const cancelBtn = page.getByRole("button", { name: "Cancel", exact: true });
    if (await cancelBtn.count().catch(() => 0)) {
      await cancelBtn.first().click().catch(() => {});
      await page.waitForTimeout(300);
    }

    if (discordUrl) {
      await page.goto(discordUrl, {
        waitUntil: "domcontentloaded"
      });
      await page.waitForTimeout(900);
    }
  } catch (err) {
    log(`Warning during Discord form reset: ${err.message}`);
  }
}

/**
 * Submits Discord modal form and awaits bot confirmation message with CAPTCHA detection.
 */
export async function submitDiscordForm(page, instagramLink, submittedOrAttemptedLinks, log = console.log) {
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
    throw new Error("Discord Submit button not found.");
  }

  await submit.scrollIntoViewIfNeeded();

  // CRITICAL DUPLICATE PROTECTION:
  // Immediately before clicking Discord's final Submit button, add URL to protection Set
  submittedOrAttemptedLinks.add(instagramLink);
  submittedOrAttemptedLinks.add(normalizeInstagramUrl(instagramLink));

  log("Discord Submit button ready. Added URL to duplicate protection Set.");
  log("Clicking Discord Submit...");

  await submit.click();

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
      log("CAPTCHA / verification challenge detected on Discord!");
      break;
    }

    const match = body.match(/Submission saved as #(\d+)/i);
    if (match) {
      submissionId = match[1];
      break;
    }
  }

  if (captchaDetected) {
    log("Status: CAPTCHA_OR_UNCERTAIN");
    return {
      success: false,
      status: ClipState.CAPTCHA_OR_UNCERTAIN
    };
  }

  if (submissionId) {
    log(`Discord submission confirmed: #${submissionId}`);
    return {
      success: true,
      submissionId,
      status: ClipState.SUBMITTED_SUCCESS
    };
  }

  log("Discord submit clicked but confirmation (#ID) was not detected.");
  log("Marking as CAPTCHA_OR_UNCERTAIN (will not retry to avoid duplicates).");

  return {
    success: false,
    status: ClipState.CAPTCHA_OR_UNCERTAIN
  };
}
