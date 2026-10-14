# Clip Submitter V2

**Clip Submitter V2** is a modular, cross-platform browser automation platform and visual workflow engine designed for high-reliability content submissions. It features an interactive **Teach Mode** (record browser actions, visual step editor, safe variable interpolation, and batch execution), alongside dedicated pipelines for **Dual Submissions** (Cleanframe → Discord `/submit`) and **Kick Submissions** (PDF source → Kick Discord clipping bot).

---

## 1. System Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│                    WEB DASHBOARD & BUILDER                      │
│                    (http://localhost:4000)                      │
│                                                                 │
│  • Teach Mode Workflow Builder    • Dual Submission Pipeline    │
│  • Interactive Browser Recorder   • Kick PDF Pipeline           │
│  • Visual Step Editor & Reorder   • Batch Execution & Queue     │
│  • Pre-Flight Schema Validator    • Audit History & Diagnostics │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 │ HTTP & WebSocket (ws://localhost:4000/client-ws)
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                    BACKEND & STORAGE ENGINE                     │
│                                                                 │
│  • Job Manager & Session Lock     • Batch Queue Runner          │
│  • Atomic Workflow Store          • Pre-Flight Validation Engine│
│  • History & Result Persistence   • Agent RPC Handshake         │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 │ WebSocket (ws://localhost:4000/agent-ws)
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                     LOCAL DESKTOP AGENT                         │
│                                                                 │
│  • Multi-Platform Browser Detection (Chrome / Edge / Brave)     │
│  • CDP Remote Debugging Attach (Port 9222)                      │
│  • Isolated Automation Profile Management                       │
│  • Recorder Engine & Action Capture                             │
│  • Workflow Executor & Multi-Tier Locator Resolver              │
└────────────────────────────────┬────────────────────────────────┘
                                 │
             ┌───────────────────┴───────────────────┐
             ▼                                       ▼
    Dedicated Browser Session                Target Platforms
(Chrome, Edge, Brave, Chromium)       (Discord, Cleanframe, Web Portals)
```

---

## 2. Supported Platforms & Requirements

| Platform | Supported | Tested Environments |
| :--- | :--- | :--- |
| **Windows** | Yes | Windows 10, Windows 11 (PowerShell & CMD) |
| **macOS** | Yes | macOS Ventura, Sonoma, Sequoia (Intel & Apple Silicon) |
| **Linux** | Yes | Ubuntu 20.04+, Debian 11+, Fedora, Arch Linux |

### Prerequisites
- **Node.js**: `v18.0.0` or higher (`v20+` or `v22+` recommended).
- **Compatible Browser**: One of Google Chrome, Microsoft Edge, Brave Browser, or Chromium installed locally.

---

## 3. Quick Start (4 Simple Steps)

### Step 1: Install Dependencies
```bash
npm install
```

### Step 2: Run Setup
```bash
npm run setup
```
*Creates the default `.env` configuration, prepares required data folders (`data/`, `data/screenshots/`), verifies dependencies, and detects installed browsers.*

### Step 3: Run Pre-Flight Health Check
```bash
npm run check
```
*Verifies system health, port availability, data folder write permissions, and browser status without triggering any submissions.*

### Step 4: Start the Application
```bash
npm start
```
*Starts both the Web Dashboard and the Local Agent together in a single command, automatically connecting them over WebSocket.*

Open your browser to:
**[http://localhost:4000](http://localhost:4000)**

---

## 4. Browser Setup & Automation Profiles

Clip Submitter V2 uses a **safe, dedicated browser profile**. It **never** touches, modifies, or deletes your personal default browser profile.

You have two simple ways to connect your browser:

### Option A: Remote Debugging (Recommended)
Launch your installed browser with a dedicated automation data directory and remote debugging enabled on port `9222`.

#### Windows (PowerShell)
```powershell
chrome.exe --remote-debugging-port=9222 --user-data-dir="$env:LOCALAPPDATA\ClipSubmitterChrome"
```

#### Windows (CMD)
```cmd
start chrome.exe --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\ClipSubmitterChrome"
```

#### macOS (Terminal)
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir="$HOME/Library/Application Support/ClipSubmitterChrome"
```

#### Linux (Terminal)
```bash
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.config/ClipSubmitterChrome"
```

> **First-Time Login Tip**: In the dedicated browser window that opens, log into your submission destinations (Discord, Cleanframe, etc.) **once**. Your session cookies are stored safely in that isolated profile directory and will persist across runs without saving plaintext passwords in the app.

### Option B: Dedicated Chromium Profile via Agent
If you prefer not to launch Chrome manually from the terminal:
1. Open the dashboard at [http://localhost:4000](http://localhost:4000).
2. Under **Browser Configuration**, switch from **"Attach to Existing Browser (Port 9222)"** to **"Launch Dedicated Profile"**.
3. Click **"Test Browser Connection"**. The agent will launch an isolated Chromium session automatically.

---

## 5. Teach Mode & Visual Automation Builder

Teach Mode allows you to demonstrate browser actions, save them as reusable templates, customize steps visually, and execute them safely on individual items or queued batches.

### Recording a Workflow
1. Navigate to the **Workflow Builder** tab in the dashboard.
2. Select your browser connection and click **"Start Recording"**.
3. In the designated automation browser, perform your actions (navigate, click buttons, fill forms, select dropdowns, press keys).
4. Watch the recorded steps stream into the dashboard live.
5. Sensitive fields (passwords, auth tokens) are automatically redacted to `[REDACTED_SENSITIVE]`.
6. Click **"Pause"** to temporarily pause recording, **"Resume"** to continue, or **"Stop Recording"** when finished.

### Visual Step Editor
In the step list you can:
- **Reorder steps**: Drag or use `▲` / `▼` buttons to adjust execution order.
- **Duplicate steps**: Clone any step with one click.
- **Enable / Disable steps**: Temporarily bypass steps without deleting them.
- **Edit step parameters**: Configure timeouts, failure policies (`stop` or `continue`), and selectors.
- **Add custom steps**: Insert waits, comments, navigation commands, or assertions.

### Supported Action Types
- `click` — Left clicks an element resolved via multi-tier locators (TestID $\rightarrow$ Role $\rightarrow$ ID $\rightarrow$ CSS $\rightarrow$ Coordinates).
- `double_click` — Double clicks target element.
- `type_text` — Safely fills or types text with variable interpolation support.
- `select_option` — Selects a dropdown option by value or visible label.
- `press_key` — Dispatches keyboard keystrokes (`Enter`, `Tab`, `Escape`, etc.).
- `wait` — Configurable delay in milliseconds.
- `navigate` — Navigates to a target URL.
- `comment` — Non-executing documentation note.
- `verify` — Asserts that an element is present, contains expected text, or has a specific value before proceeding.

### Safe Variable Interpolation
Templates support dynamic Mustache-style interpolation:
- `{{clip.url}}` — The target clip/video URL.
- `{{clip.title}}` — Title or caption of the item.
- `{{clip.creator}}` — Creator or channel handle.
- `{{clip.category}}` — Category or platform tag.

> **Security Guardrail**: Interpolation strictly replaces strings literally and **never** evaluates supplied content as executable JavaScript.

### Batch Execution & Queue Controls
- **Queue Management**: Load multiple clips into the batch queue and execute them sequentially.
- **Live State Tracking**: Each item tracks its own state: `QUEUED`, `RUNNING`, `SUCCESS`, `FAILED`, `SKIPPED`, `CANCELLED`, or `UNKNOWN`.
- **Queue Controls**: Pause, Resume, or Cancel batch execution on the fly.
- **Crash Recovery**: Queue state is atomically persisted to disk. Unfinished items can be resumed safely after restarting the backend without losing progress or duplicating work.
- **Duplicate Prevention**: Idempotency keys prevent duplicate runs of the same clip in a batch.

---

## 6. Submission Pipelines

### Dual Submission (`Cleanframe → Discord`)
- **Source**: Scans Cleanframe dashboard (`All Clips` view).
- **Discord Flow**: Executes `/submit Instagram` command, populates clipper and editor user pickers, injects caption and post link via CDP, confirms submission `#ID`, and syncs status back to Cleanframe.
- **Stop Contract**: Automatically stops scanning at the first already-submitted row to prevent redundant network traffic.

### Kick Submission (`PDF / Text → Kick Discord`)
- **Source**: Upload a PDF or paste table text containing `Clip URL` and `Creator`.
- **Discord Flow**: Dynamically routes to creator-specific slash commands (e.g. `/<creator> links`), types the link, submits, and verifies bot confirmation.

---

## 7. Configuration Reference (`.env`)

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `4000` | Port for the web dashboard and backend API server. |
| `AGENT_TOKEN` | `local-agent-secret` | Shared secret token for WebSocket authentication. |
| `WEBSITE_URL` | *None* | Cleanframe dashboard URL for Dual queue scanning and sync. |
| `DISCORD_URL` | *None* | Discord channel URL containing the Dual `/submit` command bot. |
| `KICK_DISCORD_URL` | *None* | Discord channel URL containing the Kick clipping bot commands. |
| `DRY_RUN` | `true` | When `true`, automations run in safe mode without committing final submissions. |
| `UI_TIMEOUT_MS` | `12000` | Maximum wait time (in milliseconds) for Discord UI element state changes. |
| `SEARCH_DELAY_MS` | `900` | Inter-keystroke delay for autocomplete searches. |
| `BROWSER_PORT` | `9222` | Remote debugging port for CDP browser connection. |
| `CHROME_PATH` | *Auto-detected* | Optional absolute path to override browser executable location. |

---

## 8. Multi-Discord Profiles & Account-Based Routing

Clip Submitter V2 allows you to configure multiple named Discord profiles with isolated, persistent login sessions.

- **Isolated Sessions**: Each profile maintains its own dedicated user data directory in `ClipSubmitterProfiles/profile_<id>`, allowing simultaneous or sequential execution across multiple Discord accounts without session crosstalk or repeated logins.
- **Dynamic Account Routing**: Maps the Cleanframe **Published on Account** column (e.g., `@cubeflox`, `@kick.who_`) directly to a designated Discord profile.
- **Safety Fallbacks**:
  - Unmapped accounts are safely flagged as `BLOCKED_UNMAPPED` (`NEEDS_ATTENTION`) without blind retries or accidental submission to the wrong server.
  - Disconnected profiles are flagged as `BLOCKED_DISCONNECTED` with clear remediation instructions.

---

## 9. Cleanframe Submit-Mark Synchronization & Reconciliation

Following Discord submissions, the Dual pipeline executes a mandatory Cleanframe reconciliation phase:

1. **Returns to Cleanframe**: Navigates back to the All Clips table to synchronize the server state.
2. **Submit Mark Execution**: Clicks the row Submit button for every confirmed Discord reel.
3. **Green Row Verification**: Confirms that the row changes to `Submitted ✓`, visual green row styling (`bg-green`, `emerald`), or green checkmark icon.
4. **Idempotency**: Rows already marked submitted are safely skipped without re-clicking.
5. **Fail-Safe Marking**: Timeouts or ambiguous transitions are marked `UNKNOWN` (`NEEDS_ATTENTION`) with exact manual action instructions; never falsely marked complete.
6. **Reconciliation Report**: Surfaces a 6-column report (`Reel`, `Published Account`, `Discord Profile`, `Discord Result`, `Cleanframe Mark`, `Overall Result`) in both the active job monitor and history modal.

---

## 10. CLI Scripts & Verification

| Command | Platform | Purpose |
| :--- | :--- | :--- |
| `npm start` or `start.bat` / `./start.sh` | All | **Unified launch**: Starts Backend server and Local Agent together. |
| `npm run setup` or `setup.bat` / `./setup.sh` | All | Guided setup: verifies Node.js, creates directories, prepares `.env`, detects browsers. |
| `npm run check` | All | Diagnostic health check: validates ports, storage, permissions, and browser status. |
| `npm test` | All | **Comprehensive test suite**: Runs all 11 unit, integration, validation, batch, and E2E suites. |
| `npm run web` | All | Starts only the web dashboard and backend server. |
| `npm run agent` | All | Starts only the local desktop agent. |

---

## 11. Security & Privacy Principles

1. **Local-First Architecture**: All recordings, workflows, execution logs, and history remain strictly on your local computer. No telemetry, analytical beacons, or external cloud relays are used.
2. **Dedicated Profiles**: Browser automations run exclusively in isolated profiles, ensuring your personal browsing history, passwords, and sessions are untouched.
3. **Automatic Redaction**: Password and sensitive fields are automatically masked as `[REDACTED_SENSITIVE]` during recording and storage.
4. **No Code Execution**: Workflow steps are interpreted deterministically by a secure executor; arbitrary JavaScript execution (`eval` or `Function`) is strictly disallowed.

---

## 10. Troubleshooting

### Port 4000 is occupied
If port 4000 is already in use:
```env
# In .env
PORT=4001
```
Then run `npm start` again.

### Could not connect to browser on 127.0.0.1:9222
- Ensure you started your browser with `--remote-debugging-port=9222`.
- Verify no other process is blocking port 9222.
- Click **"Test Browser Connection"** on the dashboard to test connectivity.
- Alternatively, switch to **"Launch Dedicated Profile"** mode.

### Missing Dependencies
Run:
```bash
npm install
```

---

## 11. License

Private & Proprietary. All rights reserved.
