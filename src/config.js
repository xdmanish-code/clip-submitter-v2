import "dotenv/config";

export const config = {
  websiteUrl: process.env.WEBSITE_URL,
  discordUrl: process.env.DISCORD_URL,

  dryRun: String(process.env.DRY_RUN ?? "true").toLowerCase() !== "false",
  uiTimeout: Number(process.env.UI_TIMEOUT_MS ?? 12000),
  searchDelay: Number(process.env.SEARCH_DELAY_MS ?? 900),

  website: {
    pendingRow: [
      'tr:has-text("Submit")',
      '[data-submission-row]',
      '[data-testid="submission-row"]'
    ],

    instagramLink: [
      '[data-field="instagram-link"]',
      '[data-testid="instagram-link"]',
      'a[href*="instagram.com"]'
    ],

    clipper: [
      '[data-field="clipper"]',
      '[data-testid="clipper"]'
    ],

    editor: [
      '[data-field="editor"]',
      '[data-testid="editor"]'
    ],

    caption: [
      '[data-field="caption"]',
      '[data-testid="caption"]'
    ],

    submitButton: [
      'button:has-text("Submit")',
      '[data-testid="submit-button"]'
    ]
  }
};
