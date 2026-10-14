# Changelog — Clip Submitter V2

All notable changes to this project are documented in this file.

## [2.0.0] - 2026-10-14 — Final Portable Release

### Added
- **Multi-Discord Profile Management**:
  - Ability to create, configure, test, and launch multiple named Discord profiles (`Discord Profile 1`, `Discord Profile 2`, etc.).
  - Isolated browser sessions for each profile stored under `ClipSubmitterProfiles/profile_<id>` with separate cookies and cache.
  - Support for dedicated browser mode and existing CDP remote-debugging attachment.
- **Automatic Account-Based Profile Routing**:
  - Automatically reads the **Published on Account** column in the Cleanframe All Clips table.
  - Dynamically routes each reel to its mapped Discord profile (e.g. `@cubeflox` $\rightarrow$ Profile 1, `@kick.who_` $\rightarrow$ Profile 2).
  - Normalizes account handles (whitespace trimming, lowercase, leading `@` enforcement).
  - Pre-flight routing validation grid and live queue inspector with assigned profile badges.
  - Safe error handling: blocks unmapped accounts as `BLOCKED_UNMAPPED` and disconnected profiles as `BLOCKED_DISCONNECTED` without halting other clips.
- **Cleanframe Submit-Mark Synchronization & Reconciliation**:
  - Mandatory Phase 3 finalization loop returning to Cleanframe after all Discord submissions complete.
  - Clicks row Submit button for every confirmed Discord reel.
  - Verifies DOM transitions to `Submitted ✓`, visual green row styling (`isRowVisuallyGreen`), and green checkmark icons.
  - Idempotency guard: skips clicking rows that are already submitted.
  - Safe recovery re-read and single safe retry on delayed responses; flags ambiguous timeouts as `UNKNOWN` (`NEEDS_ATTENTION`).
  - Never clicks Submit for failed, skipped, or blocked reels (`CleanframeMarkResult.NOT_REQUIRED`).
  - 100% completion gate: flags job as `COMPLETED_WITH_WARNINGS` if any confirmed reel remains unverified on Cleanframe.
  - Comprehensive 6-column per-reel reconciliation table (`Reel`, `Published Account`, `Discord Profile`, `Discord Result`, `Cleanframe Mark`, `Overall Result`) in both active dashboard and history modal.
- **Convenience Cross-Platform Scripts**:
  - Added `setup.bat` and `start.bat` for Windows one-click initialization and launch.
  - Added `setup.sh` and `start.sh` for macOS and Linux bash environments.
- **Expanded Unified Test Suite**:
  - Added `tests/test_multi_discord_routing.js` (14 tests).
  - Added `tests/test_cleanframe_finalization.js` (9 comprehensive tests).
  - 11 total suites executed sequentially via `npm test` with 100% pass rate.

### Enhanced
- **Browser Discovery**:
  - Expanded cross-platform paths for Windows, macOS, and Linux in `agent/browser-discovery.js`.
  - Added Scoop and LocalAppData search paths for Chrome, Edge, Brave, and Chromium.
- **Teach Mode & Workflow Builder**:
  - Full browser recorder engine capturing clicks, text typing, dropdowns, keyboard events, and navigations in real time.
  - Visual Step Editor supporting reordering, duplication, parameter editing, disabling/enabling, and deletion.
  - Pre-flight schema validation and safe variable interpolation.
  - Batch workflow queue with pause, resume, cancel, idempotency keys, and crash recovery.
- **UI & Dashboard**:
  - Added Discord Profile manager card and Account Mapping table to the dashboard.
  - Added live reconciliation report cards, metric boxes, and manual action alert banners.

### Fixed
- Prevented Playwright locator timeouts on Cleanframe table scanning by checking selector count before attribute resolution.
- Fixed reconciliation report badge rendering on job completion over WebSocket.
- Fixed boundary scanning to strictly respect stop-at-first-submitted row contract across all load modes.

---

## [1.0.0] - Legacy Initial Version
- Initial CLI-based dual submission script and Kick PDF parsing bot.
