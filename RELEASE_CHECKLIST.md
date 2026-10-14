# Release Checklist & Known Limitations — Clip Submitter V2

## Pre-Release Audit & Verification Checklist

- [x] **Dual Submission Pipeline**:
  - [x] Top-to-bottom Cleanframe table scanning.
  - [x] Stop-at-first-Submitted contract strictly enforced.
  - [x] Discord `/submit Instagram` command automated with autocomplete picker resolution.
  - [x] Message confirmation `#ID` capture and verification.
- [x] **Multi-Discord Profile Routing**:
  - [x] Dedicated isolated profiles created and persisted in `data/discord_profiles.json`.
  - [x] Persistent cookies and sessions stored in `ClipSubmitterProfiles/profile_<id>`.
  - [x] Cleanframe **Published on Account** column parsed and mapped.
  - [x] Automatic profile routing tested and verified.
  - [x] Unmapped accounts blocked safely (`BLOCKED_UNMAPPED`).
  - [x] Disconnected profiles handled safely (`BLOCKED_DISCONNECTED`).
- [x] **Cleanframe Submit-Mark Synchronization**:
  - [x] Returns to Cleanframe All Clips table after Discord submissions finish.
  - [x] Clicks Submit button for confirmed Discord reels.
  - [x] Verifies transition to `Submitted ✓` and visual green row appearance (`isRowVisuallyGreen`).
  - [x] Idempotency: rows already submitted are not clicked again.
  - [x] Recovery re-read and safe single retry on delay.
  - [x] Ambiguous timeouts marked as `UNKNOWN` (`NEEDS_ATTENTION`).
  - [x] Failed Discord reels are never clicked (`NOT_REQUIRED`).
  - [x] 100% completion gate: flags `COMPLETED_WITH_WARNINGS` if any marks are unresolved.
- [x] **Teach Mode & Workflow Builder**:
  - [x] Live browser recorder capturing events in real-time.
  - [x] Visual step editor (reorder, duplicate, edit, disable, delete).
  - [x] Pre-flight schema validation.
  - [x] Safe variable interpolation (no code execution).
  - [x] Batch queue with pause, resume, cancel, duplicate prevention, and crash recovery.
- [x] **Kick & Clipster Pipelines**:
  - [x] Kick PDF upload & text parsing preserved and functional.
  - [x] Clipster engine intact.
- [x] **Platform Portability & Cleanliness**:
  - [x] Node.js standard ESM modules (`"type": "module"`).
  - [x] Cross-platform browser discovery (Windows, macOS, Linux).
  - [x] No hardcoded machine paths (`C:\Users\manis\...`).
  - [x] Secrets and personal data excluded (`.env`, `history.json`, cookies, sessions).
  - [x] Safe template configuration (`.env.example`).
  - [x] Starter data templates auto-created (`setup.js`).
  - [x] All 11 automated test suites passing 100% green.

---

## Known Limitations & Environment Considerations

1. **Browser Installation**:
   - The application requires a local desktop installation of Google Chrome, Microsoft Edge, Brave Browser, or Chromium.
   - If installed in a non-standard path, set `CHROME_PATH` in `.env`.
2. **First-Time Account Authentication**:
   - Because user sessions, cookies, and tokens are intentionally excluded from the export for privacy and security, a new user must authenticate their Discord accounts once in the designated browser profile before live submissions.
   - Once logged in, session cookies persist in the local `ClipSubmitterProfiles/` folder.
3. **Headless Limitations with Cloudflare Captcha**:
   - If Cleanframe or Discord presents a Cloudflare turnstile or interactive CAPTCHA during login, the initial login should be completed in a non-headless browser window. Once the session cookie is saved, automation runs smoothly.
4. **Discord UI / Slash Command Updates**:
   - Discord occasionally updates client CSS or command picker DOM elements. If command autocompletion times out, verify that Discord slash commands are active in the target channel and adjust `UI_TIMEOUT_MS` in `.env` if operating on slow network connections.
