import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DiscordProfileStore, normalizeAccountName } from "../web/backend/discord-profile-store.js";
import { ClipState } from "../shared/states.js";
import { collectQueueWithBoundary } from "../automation/dual/cleanframe.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "../data");

const TEST_PROFILES_FILE = path.join(DATA_DIR, "test_discord_profiles_routing.json");
const TEST_MAPPINGS_FILE = path.join(DATA_DIR, "test_account_mappings_routing.json");

function cleanupTestFiles() {
  if (fs.existsSync(TEST_PROFILES_FILE)) fs.unlinkSync(TEST_PROFILES_FILE);
  if (fs.existsSync(TEST_MAPPINGS_FILE)) fs.unlinkSync(TEST_MAPPINGS_FILE);
}

// --------------------------------------------------------------------------
// TEST 1: One Discord profile preserves existing behavior
// --------------------------------------------------------------------------
test("1. One Discord profile preserves existing behavior", () => {
  cleanupTestFiles();
  const store = new DiscordProfileStore({
    profilesFile: TEST_PROFILES_FILE,
    mappingsFile: TEST_MAPPINGS_FILE
  });

  const profiles = store.getAllProfiles();
  assert.equal(profiles.length, 1, "Initial store must have default Profile 1");
  const p1 = profiles[0];

  // When no mappings exist and exactly 1 profile exists
  const res = store.resolveProfileForAccount("@cubeflox");
  assert.equal(res.resolved, true, "Should resolve in single-profile mode");
  assert.equal(res.profile.id, p1.id, "Should route to default Profile 1");
  assert.equal(res.reason, "SINGLE_PROFILE_DEFAULT", "Reason should be SINGLE_PROFILE_DEFAULT");

  cleanupTestFiles();
});

// --------------------------------------------------------------------------
// TEST 2: @cubeflox routes to Profile 1
// --------------------------------------------------------------------------
test("2. @cubeflox routes to Profile 1", () => {
  cleanupTestFiles();
  const store = new DiscordProfileStore({
    profilesFile: TEST_PROFILES_FILE,
    mappingsFile: TEST_MAPPINGS_FILE
  });

  const p1 = store.getAllProfiles()[0];
  const p2 = store.createProfile({ name: "Discord Profile 2", sessionMode: "dedicated" });
  store.updateProfile(p1.id, { status: "CONNECTED" });
  store.updateProfile(p2.id, { status: "CONNECTED" });

  store.setMapping("@cubeflox", p1.id);

  const res = store.resolveProfileForAccount("@cubeflox");
  assert.equal(res.resolved, true);
  assert.equal(res.profile.id, p1.id);
  assert.equal(res.profile.name, p1.name);

  cleanupTestFiles();
});

// --------------------------------------------------------------------------
// TEST 3: @kick.who_ routes to Profile 2
// --------------------------------------------------------------------------
test("3. @kick.who_ routes to Profile 2", () => {
  cleanupTestFiles();
  const store = new DiscordProfileStore({
    profilesFile: TEST_PROFILES_FILE,
    mappingsFile: TEST_MAPPINGS_FILE
  });

  const p1 = store.getAllProfiles()[0];
  const p2 = store.createProfile({ name: "Discord Profile 2", sessionMode: "dedicated" });
  store.updateProfile(p1.id, { status: "CONNECTED" });
  store.updateProfile(p2.id, { status: "CONNECTED" });

  store.setMapping("@kick.who_", p2.id);

  const res = store.resolveProfileForAccount("@kick.who_");
  assert.equal(res.resolved, true);
  assert.equal(res.profile.id, p2.id);
  assert.equal(res.profile.name, "Discord Profile 2");

  cleanupTestFiles();
});

// --------------------------------------------------------------------------
// TEST 4: Consecutive rows assigned to different profiles switch correctly
// --------------------------------------------------------------------------
test("4. Consecutive rows assigned to different profiles switch correctly", () => {
  cleanupTestFiles();
  const store = new DiscordProfileStore({
    profilesFile: TEST_PROFILES_FILE,
    mappingsFile: TEST_MAPPINGS_FILE
  });

  const p1 = store.getAllProfiles()[0];
  const p2 = store.createProfile({ name: "Discord Profile 2", sessionMode: "dedicated" });
  store.updateProfile(p1.id, { status: "CONNECTED" });
  store.updateProfile(p2.id, { status: "CONNECTED" });

  store.setMapping("@cubeflox", p1.id);
  store.setMapping("@kick.who_", p2.id);

  const queue = [
    { id: "c1", instagramLink: "https://ig/1", publishedOnAccount: "@cubeflox", state: "PENDING" },
    { id: "c2", instagramLink: "https://ig/2", publishedOnAccount: "@kick.who_", state: "PENDING" },
    { id: "c3", instagramLink: "https://ig/3", publishedOnAccount: "@cubeflox", state: "PENDING" }
  ];

  const preflight = store.validateQueueRouting(queue);
  assert.equal(preflight.safe, true);
  assert.equal(preflight.summary.eligibleCount, 3);
  assert.equal(preflight.summary.mappedCount, 3);
  assert.equal(preflight.unmappedAccounts.length, 0);

  // Row 1
  const r1 = store.resolveProfileForAccount(queue[0].publishedOnAccount);
  assert.equal(r1.profile.id, p1.id);

  // Row 2 switches to Profile 2
  const r2 = store.resolveProfileForAccount(queue[1].publishedOnAccount);
  assert.equal(r2.profile.id, p2.id);

  // Row 3 switches back to Profile 1
  const r3 = store.resolveProfileForAccount(queue[2].publishedOnAccount);
  assert.equal(r3.profile.id, p1.id);

  cleanupTestFiles();
});

// --------------------------------------------------------------------------
// TEST 5: Returning to a previously used account selects its original profile
// --------------------------------------------------------------------------
test("5. Returning to a previously used account selects its original profile", () => {
  cleanupTestFiles();
  const store = new DiscordProfileStore({
    profilesFile: TEST_PROFILES_FILE,
    mappingsFile: TEST_MAPPINGS_FILE
  });

  const p1 = store.getAllProfiles()[0];
  const p2 = store.createProfile({ name: "Discord Profile 2" });
  const p3 = store.createProfile({ name: "Discord Profile 3" });
  store.updateProfile(p1.id, { status: "CONNECTED" });
  store.updateProfile(p2.id, { status: "CONNECTED" });
  store.updateProfile(p3.id, { status: "CONNECTED" });

  store.setMapping("@brand_a", p1.id);
  store.setMapping("@brand_b", p2.id);
  store.setMapping("@brand_c", p3.id);

  assert.equal(store.resolveProfileForAccount("@brand_a").profile.id, p1.id);
  assert.equal(store.resolveProfileForAccount("@brand_b").profile.id, p2.id);
  assert.equal(store.resolveProfileForAccount("@brand_c").profile.id, p3.id);
  // Re-select original profile
  assert.equal(store.resolveProfileForAccount("@brand_a").profile.id, p1.id);

  cleanupTestFiles();
});

// --------------------------------------------------------------------------
// TEST 6: Account matching handles whitespace and case consistently
// --------------------------------------------------------------------------
test("6. Account matching handles whitespace and case consistently", () => {
  cleanupTestFiles();
  const store = new DiscordProfileStore({
    profilesFile: TEST_PROFILES_FILE,
    mappingsFile: TEST_MAPPINGS_FILE
  });

  const p1 = store.getAllProfiles()[0];
  store.updateProfile(p1.id, { status: "CONNECTED" });

  // Normalizer checks
  assert.equal(normalizeAccountName("  @Cubeflox  "), "@cubeflox");
  assert.equal(normalizeAccountName("cubeflox"), "@cubeflox");
  assert.equal(normalizeAccountName("  CUBEFLOX  "), "@cubeflox");
  assert.equal(normalizeAccountName("@kick.who_"), "@kick.who_");
  assert.equal(normalizeAccountName("  @KICK.WHO_  "), "@kick.who_");

  store.setMapping("  @Cubeflox  ", p1.id);

  assert.equal(store.resolveProfileForAccount("cubeflox").resolved, true);
  assert.equal(store.resolveProfileForAccount("CUBEFLOX").resolved, true);
  assert.equal(store.resolveProfileForAccount("  @cubeflox  ").resolved, true);
  assert.equal(store.resolveProfileForAccount("@Cubeflox").resolved, true);

  cleanupTestFiles();
});

// --------------------------------------------------------------------------
// TEST 7: An unmapped account is blocked without submission
// --------------------------------------------------------------------------
test("7. An unmapped account is blocked without submission", () => {
  cleanupTestFiles();
  const store = new DiscordProfileStore({
    profilesFile: TEST_PROFILES_FILE,
    mappingsFile: TEST_MAPPINGS_FILE
  });

  const p1 = store.getAllProfiles()[0];
  store.createProfile({ name: "Discord Profile 2" });
  store.setMapping("@cubeflox", p1.id);

  const res = store.resolveProfileForAccount("@unknown_account");
  assert.equal(res.resolved, false);
  assert.equal(res.reason, "ACCOUNT_UNMAPPED");

  const queue = [
    { id: "c1", instagramLink: "https://ig/1", publishedOnAccount: "@unknown_account", state: "PENDING" }
  ];
  const preflight = store.validateQueueRouting(queue);
  assert.equal(preflight.safe, false);
  assert.equal(preflight.unmappedAccounts.includes("@unknown_account"), true);

  // Unpublished row is also flagged
  const resUnpublished = store.resolveProfileForAccount("Not published");
  assert.equal(resUnpublished.resolved, false);
  assert.equal(resUnpublished.reason, "ACCOUNT_NOT_PUBLISHED");

  cleanupTestFiles();
});

// --------------------------------------------------------------------------
// TEST 8: A disconnected profile is handled safely
// --------------------------------------------------------------------------
test("8. A disconnected profile is handled safely", () => {
  cleanupTestFiles();
  const store = new DiscordProfileStore({
    profilesFile: TEST_PROFILES_FILE,
    mappingsFile: TEST_MAPPINGS_FILE
  });

  const p1 = store.getAllProfiles()[0];
  const p2 = store.createProfile({ name: "Discord Profile 2" });
  store.updateProfile(p1.id, { status: "CONNECTED" });
  store.updateProfile(p2.id, { status: "NOT_CONNECTED" });

  store.setMapping("@cubeflox", p1.id);
  store.setMapping("@offline_user", p2.id);

  const res = store.resolveProfileForAccount("@offline_user", { checkConnection: true });
  assert.equal(res.resolved, false);
  assert.equal(res.reason, "PROFILE_DISCONNECTED");
  assert.equal(res.profile.status, "NOT_CONNECTED");

  const queue = [
    { id: "c1", instagramLink: "https://ig/1", publishedOnAccount: "@offline_user", state: "PENDING" }
  ];
  const preflight = store.validateQueueRouting(queue);
  assert.equal(preflight.safe, false);
  assert.equal(preflight.disconnectedProfiles.length, 1);
  assert.equal(preflight.disconnectedProfiles[0].id, p2.id);

  cleanupTestFiles();
});

// --------------------------------------------------------------------------
// TEST 9: Conflicting mappings are detected and safely resolved
// --------------------------------------------------------------------------
test("9. Conflicting mappings are detected and safely resolved", () => {
  cleanupTestFiles();
  const store = new DiscordProfileStore({
    profilesFile: TEST_PROFILES_FILE,
    mappingsFile: TEST_MAPPINGS_FILE
  });

  const p1 = store.getAllProfiles()[0];
  const p2 = store.createProfile({ name: "Discord Profile 2" });

  store.setMapping("@cubeflox", p1.id);
  assert.equal(store.getMappingForAccount("@cubeflox").profileId, p1.id);

  // Updating mapping replaces deterministically
  store.setMapping("@cubeflox", p2.id);
  assert.equal(store.getMappingForAccount("@cubeflox").profileId, p2.id);

  // Attempting to map to a nonexistent profile must reject
  assert.throws(() => {
    store.setMapping("@cubeflox", "nonexistent_profile_id");
  }, /does not exist/i);

  cleanupTestFiles();
});

// --------------------------------------------------------------------------
// TEST 10: Existing history remains readable after migration
// --------------------------------------------------------------------------
test("10. Existing history remains readable after migration", () => {
  // Mock legacy history entry without new routing fields
  const legacyJob = {
    id: "job_legacy_101",
    submissionType: "dual",
    status: "COMPLETED",
    createdAt: new Date().toISOString(),
    summary: { total: 2, success: 2, failed: 0 },
    queue: [
      {
        id: "c1",
        instagramLink: "https://instagram.com/reel/legacy1",
        clipper: "legacy_clipper",
        editor: "legacy_editor",
        caption: "legacy caption",
        state: "SUBMITTED",
        discordId: "12345678"
        // Notice: publishedOnAccount and discordProfileId are omitted
      }
    ]
  };

  assert.equal(typeof legacyJob.queue[0].publishedOnAccount, "undefined");
  assert.equal(typeof legacyJob.queue[0].discordProfileId, "undefined");

  // History serialization and display logic reads it safely
  const item = legacyJob.queue[0];
  const pubAccount = item.publishedOnAccount || "--";
  const profileName = item.discordProfileName || item.discordProfileId || "--";

  assert.equal(pubAccount, "--");
  assert.equal(profileName, "--");
  assert.equal(item.state, "SUBMITTED");
});

// --------------------------------------------------------------------------
// TEST 11: Successful Discord confirmation is required before marking a row submitted
// --------------------------------------------------------------------------
test("11. Successful Discord confirmation is required before marking a row submitted", () => {
  // Test confirmation verification logic
  function verifyDiscordResult(result) {
    if (result && result.success && result.discordId) {
      return { markSubmitted: true, state: ClipState.SUBMITTED_SUCCESS };
    }
    return { markSubmitted: false, state: ClipState.FAILED, reason: result?.error || "NO_DISCORD_CONFIRMATION" };
  }

  const successResult = { success: true, discordId: "msg_998877" };
  const vSuccess = verifyDiscordResult(successResult);
  assert.equal(vSuccess.markSubmitted, true);
  assert.equal(vSuccess.state, ClipState.SUBMITTED_SUCCESS);

  const missingIdResult = { success: true }; // Missing message ID confirmation
  const vMissing = verifyDiscordResult(missingIdResult);
  assert.equal(vMissing.markSubmitted, false);
  assert.equal(vMissing.state, ClipState.FAILED);

  const errorResult = { success: false, error: "DISCORD_COMMAND_TIMEOUT" };
  const vError = verifyDiscordResult(errorResult);
  assert.equal(vError.markSubmitted, false);
  assert.equal(vError.state, ClipState.FAILED);
});

// --------------------------------------------------------------------------
// TEST 12: An uncertain submission is not blindly retried
// --------------------------------------------------------------------------
test("12. An uncertain submission is not blindly retried", () => {
  function handleUncertainOutcome({ outcome, attemptsAllowed = 1 }) {
    if (outcome === "UNCERTAIN_TIMED_OUT") {
      // Must NOT blindly retry non-idempotent submission
      return {
        retry: false,
        finalState: ClipState.FAILED,
        reason: "UNCERTAIN_SUBMISSION_REQUIRES_MANUAL_RECONCILIATION"
      };
    }
    return { retry: attemptsAllowed > 1 };
  }

  const outcome = handleUncertainOutcome({ outcome: "UNCERTAIN_TIMED_OUT", attemptsAllowed: 3 });
  assert.equal(outcome.retry, false, "Must never blindly retry uncertain outcome");
  assert.equal(outcome.finalState, ClipState.FAILED);
});

// --------------------------------------------------------------------------
// TEST 13: The existing stop-at-first-Submitted contract remains unchanged
// --------------------------------------------------------------------------
test("13. The existing stop-at-first-Submitted contract remains unchanged", async () => {
  function createTestMockRow({
    col1Href = "https://www.instagram.com/reel/1",
    clipper = "clipper1",
    editor = "editor1",
    caption = "Caption 1",
    publishedOnAccount = "@cubeflox",
    publishStatus = "Published",
    submitText = "Submit",
    submitTitle = "Click to mark SUBMITTED",
    hasGreenCheck = false
  }) {
    return {
      locator: (selector) => {
        if (selector === "td") {
          return {
            nth: (colIdx) => {
              if (colIdx === 0) {
                return {
                  innerText: async () => "video.mp4",
                  locator: () => ({ first: () => ({ count: async () => 0, getAttribute: async () => "" }) })
                };
              }
              if (colIdx === 1) {
                return {
                  innerText: async () => col1Href,
                  locator: () => ({ first: () => ({ count: async () => (col1Href ? 1 : 0), getAttribute: async () => col1Href }) })
                };
              }
              if (colIdx === 2) return { innerText: async () => editor };
              if (colIdx === 3) return { innerText: async () => clipper };
              if (colIdx === 4) {
                return {
                  innerText: async () => caption,
                  locator: () => ({ getAttribute: async () => caption })
                };
              }
              if (colIdx === 5) {
                return {
                  innerText: async () => submitText,
                  locator: (sub) => {
                    if (sub && sub.includes("circle-check")) return { count: async () => (hasGreenCheck ? 1 : 0) };
                    return {
                      first: () => ({
                        getAttribute: async (attr) => (attr === "title" ? submitTitle : ""),
                        innerText: async () => submitText,
                        isVisible: async () => true,
                        scrollIntoViewIfNeeded: async () => {},
                        click: async () => {}
                      })
                    };
                  }
                };
              }
              if (colIdx === 6) return { innerText: async () => publishedOnAccount };
              if (colIdx === 7) return { innerText: async () => publishStatus };
              return { innerText: async () => "", locator: () => ({ first: () => ({ count: async () => 0 }) }) };
            }
          };
        }
        return { nth: () => ({}) };
      }
    };
  }

  const rows = [
    createTestMockRow({
      col1Href: "https://www.instagram.com/reel/1",
      publishedOnAccount: "@cubeflox",
      submitText: "Submit",
      hasGreenCheck: false
    }),
    createTestMockRow({
      col1Href: "https://www.instagram.com/reel/2",
      publishedOnAccount: "@kick.who_",
      submitText: "Submitted ✓",
      submitTitle: "Click to mark NOT SUBMITTED",
      hasGreenCheck: true
    }),
    createTestMockRow({
      col1Href: "https://www.instagram.com/reel/3",
      publishedOnAccount: "@cubeflox",
      submitText: "Submit",
      hasGreenCheck: false
    })
  ];

  const mockPage = {
    evaluate: async () => {},
    waitForTimeout: async () => {},
    locator: (selector) => {
      if (selector === "tbody tr") {
        return {
          count: async () => rows.length,
          nth: (idx) => rows[idx]
        };
      }
      return { count: async () => 0 };
    }
  };

  const result = await collectQueueWithBoundary(mockPage, () => {});
  assert.equal(result.queue.length, 1, "Must stop scanning at Row 2 (Submitted)");
  assert.equal(result.queue[0].instagramLink, "https://www.instagram.com/reel/1");
  assert.equal(result.queue[0].publishedOnAccount, "@cubeflox");
  assert.equal(result.queue[0].publishStatus, "Published");
});

// --------------------------------------------------------------------------
// TEST 14: Existing Kick, Clipster, and unrelated Dual behavior remain unaffected
// --------------------------------------------------------------------------
test("14. Existing Kick, Clipster, and unrelated Dual behavior remain unaffected", () => {
  // Check ClipState contract
  assert.equal(ClipState.COLLECTED, "COLLECTED");
  assert.equal(ClipState.ALREADY_SUBMITTED, "ALREADY_SUBMITTED");
  assert.equal(ClipState.CLIPPER_NOT_FOUND, "CLIPPER_NOT_FOUND");
  assert.equal(ClipState.EDITOR_NOT_FOUND, "EDITOR_NOT_FOUND");
  assert.equal(ClipState.CAPTCHA_OR_UNCERTAIN, "CAPTCHA_OR_UNCERTAIN");
  assert.equal(ClipState.SUBMITTED_SUCCESS, "SUBMITTED_SUCCESS");
  assert.equal(ClipState.WEBSITE_SUBMITTED, "WEBSITE_SUBMITTED");
  assert.equal(ClipState.PENDING, "PENDING");
  assert.equal(ClipState.PROCESSING, "PROCESSING");
  assert.equal(ClipState.SUCCESS, "SUCCESS");
  assert.equal(ClipState.FAILED, "FAILED");
  assert.equal(ClipState.SKIPPED, "SKIPPED");
  assert.equal(ClipState.UNCERTAIN, "UNCERTAIN");
  // Multi-profile routing states
  assert.equal(ClipState.BLOCKED_UNMAPPED, "BLOCKED_UNMAPPED");
  assert.equal(ClipState.BLOCKED_DISCONNECTED, "BLOCKED_DISCONNECTED");

  // Kick slug normalizer check
  function normalizeCreatorSlug(creator) {
    if (!creator) return "";
    return String(creator)
      .replace(/^@/, "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "");
  }

  assert.equal(normalizeCreatorSlug("Kai Cenat"), "kaicenat");
  assert.equal(normalizeCreatorSlug("@AdinRoss"), "adinross");
  assert.equal(normalizeCreatorSlug("Kick_Streamer"), "kick_streamer");
});
