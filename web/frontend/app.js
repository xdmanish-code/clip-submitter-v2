// Global State
const state = {
  submissionType: "dual",
  browserMode: "existing",
  agentOnline: false,
  agentInfo: null,
  loadedQueue: [],
  selectedKickIds: new Set(),
  pendingOverrideCreator: null,
  activeJob: null,
  history: [],
  workflows: [],
  currentWorkflow: null,
  recordedSteps: [],
  recordingState: "IDLE",
  activeRecordingSessionId: null,
  discordProfiles: [],
  accountMappings: [],
  routingPreflight: null,
  defaults: {
    websiteUrl: "",
    discordUrl: "",
    kickDiscordUrl: ""
  }
};
window.state = state;
window.renderKickQueueTable = renderKickQueueTable;

let clientWs = null;

// Initialize App
document.addEventListener("DOMContentLoaded", async () => {
  await loadConfigDefaults();
  initWebSocket();
  await loadHistory();
  await loadDiscordProfiles();
  await loadAccountMappings();
});

// Load config defaults from backend
async function loadConfigDefaults() {
  try {
    const res = await fetch("/api/config/defaults");
    const data = await res.json();
    state.defaults = data;

    if (data.websiteUrl) {
      document.getElementById("inputWebsiteUrl").value = data.websiteUrl;
    }
    if (data.discordUrl) {
      document.getElementById("inputDiscordUrl").value = data.discordUrl;
    }
    if (data.kickDiscordUrl) {
      document.getElementById("inputKickDiscordUrl").value = data.kickDiscordUrl;
    }
  } catch (err) {
    console.warn("Could not fetch backend defaults:", err);
  }
}

// WebSocket Connection to Backend
function initWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/client-ws`;

  clientWs = new WebSocket(wsUrl);

  clientWs.onopen = () => {
    console.log("Connected to dashboard WebSocket backend.");
  };

  clientWs.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleWsMessage(data);
    } catch (err) {
      console.error("Error parsing WS message:", err);
    }
  };

  clientWs.onclose = () => {
    console.warn("WS disconnected. Reconnecting in 3s...");
    setTimeout(initWebSocket, 3000);
  };
}

function handleWsMessage({ type, payload }) {
  switch (type) {
    case "INIT_STATE":
      updateAgentStatus(payload.agent?.online, payload.agent?.agent);
      if (payload.activeJob) {
        state.activeJob = payload.activeJob;
        renderActiveJob(payload.activeJob);
      }
      if (payload.history) {
        state.history = payload.history;
        renderHistoryTable(payload.history);
      }
      if (payload.workflows) {
        state.workflows = payload.workflows;
        renderWorkflowTemplatesDropdown(payload.workflows);
      }
      if (payload.activeRecording) {
        state.recordingState = payload.activeRecording.status || "IDLE";
        state.activeRecordingSessionId = payload.activeRecording.sessionId || null;
        updateRecorderUI(state.recordingState);
      }
      if (payload.discordProfiles) {
        state.discordProfiles = payload.discordProfiles;
        renderDiscordProfiles();
      }
      if (payload.accountMappings) {
        state.accountMappings = payload.accountMappings;
        renderAccountMappings();
      }
      break;

    case "AGENT_STATUS":
      updateAgentStatus(payload.online, payload.agent);
      break;

    case "RECORDING_STARTED":
      state.recordingState = "RECORDING";
      state.activeRecordingSessionId = payload.sessionId;
      updateRecorderUI("RECORDING");
      showRecorderFeedback("● Recording active in browser session. Interact with elements to record steps.", "info");
      break;

    case "RECORDING_PAUSED":
      state.recordingState = "PAUSED";
      updateRecorderUI("PAUSED");
      showRecorderFeedback("⏸ Recording paused.", "warning");
      break;

    case "RECORDING_RESUMED":
      state.recordingState = "RECORDING";
      updateRecorderUI("RECORDING");
      showRecorderFeedback("▶ Recording resumed.", "info");
      break;

    case "RECORDED_STEP":
      handleRecordedStepEvent(payload);
      break;

    case "RECORDING_STOPPED":
      state.recordingState = "IDLE";
      state.activeRecordingSessionId = null;
      updateRecorderUI("IDLE");
      showRecorderFeedback(`✓ Recording stopped. Captured ${payload.stepsCount || state.recordedSteps.length} step(s).`, "success");
      break;

    case "RECORDING_ERROR":
      updateRecorderUI("FAILED");
      showRecorderFeedback(`Error: ${payload.error || "Recording failed."}`, "error");
      break;

    case "JOB_STARTED":
      state.activeJob = payload.job;
      renderActiveJob(payload.job);
      break;

    case "JOB_STATUS_UPDATE":
      if (state.activeJob && String(state.activeJob.id) === String(payload.jobId)) {
        state.activeJob.status = payload.status;
        renderActiveJob(state.activeJob);
      }
      break;

    case "JOB_STEP":
      if (state.activeJob && String(state.activeJob.id) === String(payload.jobId)) {
        state.activeJob.currentStep = payload.step;
        state.activeJob.currentStepDetail = payload.detail;
        const stepLabel = document.getElementById("activeJobCurrentStep");
        if (stepLabel) {
          stepLabel.textContent = `${payload.step} ${payload.detail ? `— ${payload.detail}` : ""}`;
        }
      }
      break;

    case "JOB_LOG":
      if (payload.log) {
        appendLiveLog(payload.log);
      }
      break;

    case "JOB_CLIP_UPDATE":
      if (state.activeJob && String(state.activeJob.id) === String(payload.jobId)) {
        state.activeJob.currentClip = payload.clip;
        state.activeJob.processedCount = payload.progress.current;
        state.activeJob.totalCount = payload.progress.total;
        if (payload.queue) {
          state.activeJob.queue = payload.queue;
          if (state.activeJob.submissionType === "kick") {
            renderKickQueueTable(payload.queue);
          } else {
            renderDualQueueTable(payload.queue);
          }
        }
        renderActiveJob(state.activeJob);
      }
      break;

    case "JOB_COMPLETED":
    case "JOB_FAILED":
    case "JOB_CANCELLED":
      loadHistory();
      if (state.activeJob && String(state.activeJob.id) === String(payload.jobId)) {
        state.activeJob.status = payload.status || (type === "JOB_COMPLETED" ? "COMPLETED" : "FAILED");
        if (payload.job) {
          state.activeJob = { ...state.activeJob, ...payload.job };
        }
        if (payload.result?.summary) {
          state.activeJob.summary = payload.result.summary;
        }
        renderActiveJob(state.activeJob);
      }
      break;

    case "BATCH_JOB_CREATED":
      state.activeBatchJob = payload.batchJob;
      renderBatchQueueTable(payload.batchJob);
      break;

    case "BATCH_JOB_PAUSED":
      if (state.activeBatchJob) {
        state.activeBatchJob.status = "PAUSED";
        renderBatchQueueTable(state.activeBatchJob);
      }
      break;

    case "BATCH_JOB_RESUMED":
      if (state.activeBatchJob) {
        state.activeBatchJob.status = "PROCESSING";
        renderBatchQueueTable(state.activeBatchJob);
      }
      break;

    case "DISCORD_PROFILES_UPDATED":
      state.discordProfiles = payload.profiles || payload || [];
      renderDiscordProfiles();
      renderAccountMappings();
      updateRoutingPreflightSummary();
      break;

    case "ACCOUNT_MAPPINGS_UPDATED":
      state.accountMappings = payload.mappings || payload || [];
      renderAccountMappings();
      updateRoutingPreflightSummary();
      break;

    case "DISCORD_PROFILE_STATUS_CHANGED":
      if (payload.profileId) {
        const p = state.discordProfiles.find(x => x.id === payload.profileId);
        if (p) {
          p.status = payload.status;
          p.lastTestedAt = payload.lastTestedAt || new Date().toISOString();
          p.lastError = payload.lastError || null;
          renderDiscordProfiles();
          renderAccountMappings();
        }
      }
      break;
  }
}

// Update Agent Status Indicator
function updateAgentStatus(online, agentInfo) {
  state.agentOnline = Boolean(online);
  state.agentInfo = agentInfo;

  const badge = document.getElementById("agentStatusBadge");
  const text = document.getElementById("agentStatusText");
  const alertBanner = document.getElementById("agentOfflineAlert");

  if (online) {
    badge.className = "status-indicator online";
    text.textContent = `Agent Online (${agentInfo?.hostname || "Local"})`;
    alertBanner.style.display = "none";
  } else {
    badge.className = "status-indicator offline";
    text.textContent = "Agent Offline";
    alertBanner.style.display = "flex";
  }

  renderDetectedBrowsers(agentInfo?.browsers || []);
}

function renderDetectedBrowsers(browsers = []) {
  const container = document.getElementById("detectedBrowsersList");
  if (!container) return;

  if (!browsers || browsers.length === 0) {
    container.innerHTML = '<span class="text-muted">No browser information reported by agent.</span>';
    return;
  }

  container.innerHTML = browsers.map(b => `
    <div class="browser-pill ${b.available ? 'available' : ''}">
      <span>${b.available ? '●' : '○'}</span>
      <strong>${b.name}</strong>
      <span class="text-muted font-mono" style="font-size:0.75rem">${b.executablePath || 'Not found in default paths'}</span>
    </div>
  `).join("");
}

// View Navigation
window.switchView = function(viewName) {
  document.querySelectorAll(".nav-tab").forEach(tab => tab.classList.remove("active"));
  document.querySelectorAll(".view-panel").forEach(panel => panel.classList.remove("active"));

  if (viewName === "dashboard") {
    document.getElementById("navDashboard").classList.add("active");
    document.getElementById("viewDashboard").classList.add("active");
  } else if (viewName === "history") {
    document.getElementById("navHistory").classList.add("active");
    document.getElementById("viewHistory").classList.add("active");
    loadHistory();
  } else if (viewName === "workflow-builder") {
    document.getElementById("navWorkflowBuilder").classList.add("active");
    document.getElementById("viewWorkflowBuilder").classList.add("active");
    loadWorkflowsList();
  } else if (viewName === "setup") {
    document.getElementById("navSetup").classList.add("active");
    document.getElementById("viewSetup").classList.add("active");
  }
};

// Submission Type Switcher
window.selectSubmissionType = function(type) {
  if (type === "clipster") {
    alert("Clipster submission automation is not configured yet.");
    return;
  }

  state.submissionType = type;
  document.querySelectorAll(".type-card").forEach(c => c.classList.remove("selected"));

  const dualPanel = document.getElementById("panelDualSubmission");
  const kickPanel = document.getElementById("panelKickSubmission");

  if (type === "kick") {
    document.getElementById("typeKickCard").classList.add("selected");
    dualPanel.style.display = "none";
    kickPanel.style.display = "block";
    renderKickQueueTable(state.loadedQueue);
    validateKickQueue();
  } else {
    document.getElementById("typeDualCard").classList.add("selected");
    dualPanel.style.display = "block";
    kickPanel.style.display = "none";
    renderDualQueueTable(state.loadedQueue);
  }
};

// Browser Mode Switcher
window.setBrowserMode = function(mode) {
  state.browserMode = mode;
  document.getElementById("tabExistingBrowser").classList.toggle("active", mode === "existing");
  document.getElementById("tabNewChromium").classList.toggle("active", mode === "new");

  document.getElementById("sectionExistingBrowser").classList.toggle("active", mode === "existing");
  document.getElementById("sectionNewChromium").classList.toggle("active", mode === "new");
};

function getBrowserConfig() {
  if (state.browserMode === "existing") {
    return {
      mode: "existing",
      browserType: document.getElementById("browserTypeSelect").value,
      host: document.getElementById("browserHost").value || "127.0.0.1",
      port: Number(document.getElementById("browserPort").value || 9222)
    };
  } else {
    return {
      mode: "new",
      profileName: document.getElementById("newProfileName").value || "profile-1",
      executablePath: document.getElementById("customExecPath").value || null,
      headless: document.getElementById("chkHeadless").checked
    };
  }
}

// Test Browser Connection
window.testBrowserConnection = async function() {
  const btn = document.getElementById("btnTestBrowser");
  const feedback = document.getElementById("browserTestFeedback");
  btn.disabled = true;
  feedback.className = "test-feedback";
  feedback.textContent = "Testing connection with local agent...";

  try {
    const res = await fetch("/api/browser/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browserConfig: getBrowserConfig() })
    });
    const data = await res.json();

    if (data.success) {
      feedback.className = "test-feedback success";
      feedback.textContent = `✓ ${data.message}`;
    } else {
      feedback.className = "test-feedback error";
      feedback.textContent = `✕ ${data.message || data.error}`;
    }
  } catch (err) {
    feedback.className = "test-feedback error";
    feedback.textContent = `✕ Connection test failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
};

// Helper: Normalize Creator name for slash commands
function normalizeCreatorSlug(creator) {
  if (!creator) return "";
  return String(creator)
    .replace(/^@/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
}

// ==========================================
// UNIFIED QUEUE LOADING (Cleanframe / Source)
// ==========================================

window.loadQueuePreview = async function() {
  const btnDual = document.getElementById("btnLoadQueue");
  const btnKick = document.getElementById("btnLoadKickQueue");
  const websiteUrl = document.getElementById("inputWebsiteUrl").value.trim();

  if (!websiteUrl) {
    alert("Please provide a valid Cleanframe URL.");
    return;
  }

  if (btnDual) btnDual.disabled = true;
  if (btnKick) btnKick.disabled = true;

  try {
    const res = await fetch("/api/queue/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        submissionType: "dual",
        browserConfig: getBrowserConfig(),
        websiteUrl
      })
    });
    const data = await res.json();

    if (data.success && data.queue) {
      // Map loaded clips into unified structure
      state.loadedQueue = data.queue.map((c, idx) => {
        const creator = c.creator || c.clipper || null;
        const clipUrl = c.instagramLink || c.clipUrl || "";
        return {
          id: c.id || `reel-${idx + 1}-${Date.now()}`,
          index: idx + 1,
          instagramLink: clipUrl,
          clipUrl: clipUrl,
          clipper: c.clipper || creator || "",
          creator: creator,
          command: creator ? normalizeCreatorSlug(creator) : null,
          editor: c.editor || "",
          caption: c.caption || "",
          publishedOnAccount: c.publishedOnAccount || c.published_on_account || "",
          publishStatus: c.publishStatus || c.publish_status || "",
          discordProfileId: c.discordProfileId || null,
          discordProfileName: c.discordProfileName || null,
          routingStatus: c.routingStatus || null,
          state: c.state || "PENDING"
        };
      });

      // Select all by default for Kick
      state.selectedKickIds.clear();
      state.loadedQueue.forEach(c => state.selectedKickIds.add(c.id));

      renderDualQueueTable(state.loadedQueue);
      renderKickQueueTable(state.loadedQueue);
      validateKickQueue();
      updateRoutingPreflightSummary();

      document.getElementById("btnStartJob").disabled = state.loadedQueue.length === 0;
    } else {
      alert(`Could not load queue: ${data.error || "Unknown error"}`);
    }
  } catch (err) {
    alert(`Error scanning Cleanframe queue: ${err.message}`);
  } finally {
    if (btnDual) btnDual.disabled = false;
    if (btnKick) btnKick.disabled = false;
  }
};

// ==========================================
// DUAL SUBMISSION UI & START
// ==========================================

function renderDualQueueTable(queue = []) {
  const tbody = document.getElementById("queueTableBody");
  const countLabel = document.getElementById("queueCountLabel");

  if (!tbody) return;
  countLabel.textContent = queue.length;

  if (queue.length === 0) {
    tbody.innerHTML = `
      <tr class="empty-row">
        <td colspan="8">No pending clips loaded yet. Click <strong>"Load Pending Clips"</strong>.</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = queue.map((clip, idx) => {
    let profileDisplay = '<span class="text-muted">--</span>';
    const pubAccount = clip.publishedOnAccount ? clip.publishedOnAccount.trim() : "";
    const isPublished = pubAccount && pubAccount.toLowerCase() !== "not published";

    if (clip.discordProfileName) {
      profileDisplay = `<span class="profile-assigned-badge">${escapeHtml(clip.discordProfileName)}</span>`;
    } else if (isPublished) {
      const norm = pubAccount.toLowerCase().startsWith("@") ? pubAccount.toLowerCase() : `@${pubAccount.toLowerCase()}`;
      const mapping = (state.accountMappings || []).find(m => m.account.toLowerCase() === norm);
      if (mapping) {
        const prof = (state.discordProfiles || []).find(p => p.id === mapping.profileId);
        profileDisplay = `<span class="profile-assigned-badge">${escapeHtml(prof ? prof.name : mapping.profileName)}</span>`;
      } else if (state.discordProfiles && state.discordProfiles.length === 1 && (!state.accountMappings || state.accountMappings.length === 0)) {
        profileDisplay = `<span class="profile-assigned-badge" style="background:#1e293b; color:#94a3b8;">${escapeHtml(state.discordProfiles[0].name)} (default)</span>`;
      } else {
        profileDisplay = `<span class="routing-unmapped-pill">Unmapped</span> <button class="btn btn-xs btn-outline" style="padding:1px 6px; font-size:10px; margin-left:4px;" onclick="showAddMappingModal('${escapeHtml(pubAccount)}')">+ Map</button>`;
      }
    } else if (pubAccount) {
      profileDisplay = `<span class="text-muted" style="font-size:0.75rem;">Not Published</span>`;
    }

    return `
      <tr>
        <td><strong>${idx + 1}</strong></td>
        <td class="font-mono" style="font-size: 0.8rem;"><a href="${clip.instagramLink}" target="_blank" style="color:#60a5fa">${clip.instagramLink}</a></td>
        <td><strong>@${escapeHtml(clip.clipper || clip.creator || 'unknown')}</strong></td>
        <td>${clip.editor ? `@${escapeHtml(clip.editor)}` : '<span class="text-muted">unclaimed</span>'}</td>
        <td>${pubAccount ? `<strong style="color:#c084fc">${escapeHtml(pubAccount)}</strong>` : '<span class="text-muted">--</span>'}</td>
        <td>${profileDisplay}</td>
        <td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(clip.caption)}</td>
        <td><span class="badge badge-${clip.state}">${clip.state}</span></td>
      </tr>
    `;
  }).join("");
}

// ==========================================
// MULTI-DISCORD PROFILES & ROUTING RULES
// ==========================================

window.toggleRoutingPanel = function() {
  const panel = document.getElementById("routingDetailsPanel");
  const btnText = document.getElementById("toggleRoutingText");
  if (!panel) return;
  const isHidden = panel.style.display === "none";
  panel.style.display = isHidden ? "block" : "none";
  if (btnText) btnText.textContent = isHidden ? "Hide Routing Settings" : "Show Routing Settings";
};

async function loadDiscordProfiles() {
  try {
    const res = await fetch("/api/discord-profiles");
    const data = await res.json();
    if (data.success && Array.isArray(data.profiles)) {
      state.discordProfiles = data.profiles;
      renderDiscordProfiles();
      renderAccountMappings();
    }
  } catch (err) {
    console.warn("Could not load Discord profiles:", err);
  }
}

function renderDiscordProfiles() {
  const container = document.getElementById("discordProfilesList");
  if (!container) return;

  const profiles = state.discordProfiles || [];
  if (profiles.length === 0) {
    container.innerHTML = `<div class="text-muted" style="padding: 12px; font-size: 0.85rem;">No Discord profiles configured yet. Click "+ Add Discord Profile" above.</div>`;
    return;
  }

  container.innerHTML = profiles.map(p => {
    let statusClass = "status-not-connected";
    let statusLabel = "Not Connected";
    if (p.status === "CONNECTED") {
      statusClass = "status-connected";
      statusLabel = "Connected";
    } else if (p.status === "CONNECTION_FAILED") {
      statusClass = "status-failed";
      statusLabel = "Failed";
    }

    const modeDesc = p.sessionMode === "existing"
      ? `CDP Port: ${p.cdpPort || 9222}`
      : `Dedicated Profile: ${escapeHtml(p.userDataDirName || `discord_${p.id}`)}`;

    const lastTested = p.lastTestedAt ? new Date(p.lastTestedAt).toLocaleTimeString() : null;

    return `
      <div class="profile-card" data-profile-id="${p.id}">
        <div class="profile-card-header">
          <div>
            <div class="profile-name">${escapeHtml(p.name)}</div>
            <div class="profile-port-badge">${modeDesc}</div>
          </div>
          <span class="profile-status-pill ${statusClass}">
            <span class="status-dot"></span>
            ${statusLabel}
          </span>
        </div>
        ${p.lastError ? `<div class="text-xs" style="color: #f87171; margin-top: 6px; word-break: break-word;">${escapeHtml(p.lastError)}</div>` : ''}
        <div class="profile-card-actions">
          <button class="btn btn-xs btn-primary" onclick="launchDiscordProfileBrowser('${p.id}')" title="Opens isolated browser window so you can log into Discord directly without revealing credentials">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
            Open Browser
          </button>
          <button class="btn btn-xs btn-secondary" onclick="testDiscordProfileConnection('${p.id}')">
            Test
          </button>
          ${profiles.length > 1 ? `
            <button class="btn btn-xs btn-outline" style="color: #f87171;" onclick="deleteDiscordProfile('${p.id}')">
              Delete
            </button>
          ` : ''}
        </div>
        ${lastTested ? `<div class="text-xs text-muted" style="margin-top: 6px;">Tested at ${lastTested}</div>` : ''}
      </div>
    `;
  }).join("");

  updateMappingProfileSelectOptions();
}

window.showAddProfileModal = function(profileId = null) {
  const modal = document.getElementById("addProfileModal");
  const title = document.getElementById("addProfileModalTitle");
  const editIdInput = document.getElementById("editProfileId");
  const nameInput = document.getElementById("inputProfileName");
  const modeSelect = document.getElementById("selectProfileMode");
  const portInput = document.getElementById("inputProfilePort");

  if (!modal) return;

  if (profileId) {
    const p = (state.discordProfiles || []).find(x => x.id === profileId);
    if (p) {
      title.textContent = "Edit Discord Profile";
      editIdInput.value = p.id;
      nameInput.value = p.name;
      modeSelect.value = p.sessionMode || "dedicated";
      portInput.value = p.cdpPort || 9223;
    }
  } else {
    title.textContent = "Add Discord Profile";
    editIdInput.value = "";
    nameInput.value = `Discord Profile ${(state.discordProfiles?.length || 0) + 1}`;
    modeSelect.value = "dedicated";
    portInput.value = 9222 + (state.discordProfiles?.length || 0);
  }

  window.onProfileModeChange();
  modal.style.display = "flex";
  nameInput.focus();
};

window.closeAddProfileModal = function() {
  const modal = document.getElementById("addProfileModal");
  if (modal) modal.style.display = "none";
};

window.onProfileModeChange = function() {
  const modeSelect = document.getElementById("selectProfileMode");
  const portGroup = document.getElementById("profilePortGroup");
  if (modeSelect && portGroup) {
    portGroup.style.display = modeSelect.value === "existing" ? "block" : "none";
  }
};

window.saveDiscordProfile = async function() {
  const editId = document.getElementById("editProfileId").value;
  const name = document.getElementById("inputProfileName").value.trim();
  const sessionMode = document.getElementById("selectProfileMode").value;
  const cdpPort = Number(document.getElementById("inputProfilePort").value || 9222);

  if (!name) {
    alert("Please enter a profile name.");
    return;
  }

  try {
    let res;
    if (editId) {
      res = await fetch(`/api/discord-profiles/${editId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, sessionMode, cdpPort })
      });
    } else {
      res = await fetch("/api/discord-profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, sessionMode, cdpPort })
      });
    }

    const data = await res.json();
    if (data.success) {
      closeAddProfileModal();
      await loadDiscordProfiles();
    } else {
      alert(`Could not save profile: ${data.error}`);
    }
  } catch (err) {
    alert(`Failed to save profile: ${err.message}`);
  }
};

window.deleteDiscordProfile = async function(profileId) {
  const p = (state.discordProfiles || []).find(x => x.id === profileId);
  const name = p ? p.name : profileId;

  if (!confirm(`Are you sure you want to delete "${name}"? Any account mappings pointing to this profile will need to be re-assigned.`)) {
    return;
  }

  try {
    const res = await fetch(`/api/discord-profiles/${profileId}`, {
      method: "DELETE"
    });
    const data = await res.json();
    if (data.success) {
      await loadDiscordProfiles();
      await loadAccountMappings();
    } else {
      alert(`Could not delete profile: ${data.error}`);
    }
  } catch (err) {
    alert(`Failed to delete profile: ${err.message}`);
  }
};

window.launchDiscordProfileBrowser = async function(profileId) {
  const profile = (state.discordProfiles || []).find(p => p.id === profileId);
  const name = profile ? profile.name : profileId;
  const discordUrl = document.getElementById("inputDiscordUrl")?.value?.trim() || "";

  try {
    const res = await fetch(`/api/discord-profiles/${profileId}/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ discordUrl })
    });
    const data = await res.json();
    if (data.success) {
      alert(`Launched isolated browser session for "${name}".\n\nPlease log into Discord in the opened browser window. Your login session will be securely saved locally. Close or minimize the browser window when done.`);
    } else {
      alert(`Could not launch browser for "${name}": ${data.error || "Unknown error"}`);
    }
  } catch (err) {
    alert(`Failed to launch browser: ${err.message}`);
  }
};

window.testDiscordProfileConnection = async function(profileId) {
  const profile = (state.discordProfiles || []).find(p => p.id === profileId);
  const name = profile ? profile.name : profileId;
  const discordUrl = document.getElementById("inputDiscordUrl")?.value?.trim() || "";

  try {
    const res = await fetch(`/api/discord-profiles/${profileId}/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ discordUrl })
    });
    const data = await res.json();
    if (data.success) {
      if (profile) {
        profile.status = data.status;
        profile.lastTestedAt = new Date().toISOString();
        profile.lastError = data.error || null;
      }
      renderDiscordProfiles();
      renderAccountMappings();
      updateRoutingPreflightSummary();
      alert(`Connection test for "${name}": ${data.status}\n${data.status === "CONNECTED" ? "Discord authenticated successfully!" : (data.error || "Not logged in")}`);
    } else {
      alert(`Test failed: ${data.error}`);
    }
  } catch (err) {
    alert(`Failed to test connection: ${err.message}`);
  }
};

async function loadAccountMappings() {
  try {
    const res = await fetch("/api/account-mappings");
    const data = await res.json();
    if (data.success && Array.isArray(data.mappings)) {
      state.accountMappings = data.mappings;
      renderAccountMappings();
      updateRoutingPreflightSummary();
    }
  } catch (err) {
    console.warn("Could not load account mappings:", err);
  }
}

function renderAccountMappings() {
  const tbody = document.getElementById("mappingsTableBody");
  if (!tbody) return;

  const mappings = state.accountMappings || [];
  if (mappings.length === 0) {
    tbody.innerHTML = `
      <tr class="empty-row">
        <td colspan="4" class="text-muted">No account routing rules defined. In single-profile mode, all items route to the default profile.</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = mappings.map(m => {
    const prof = (state.discordProfiles || []).find(p => p.id === m.profileId);
    const profileName = prof ? prof.name : (m.profileName || m.profileId);
    let statusPill = '<span class="profile-status-pill status-not-connected"><span class="status-dot"></span>Not Connected</span>';
    if (prof && prof.status === "CONNECTED") {
      statusPill = '<span class="profile-status-pill status-connected"><span class="status-dot"></span>Connected</span>';
    } else if (prof && prof.status === "CONNECTION_FAILED") {
      statusPill = '<span class="profile-status-pill status-failed"><span class="status-dot"></span>Failed</span>';
    }

    return `
      <tr>
        <td><strong style="color: #c084fc;">${escapeHtml(m.account)}</strong></td>
        <td><span class="profile-assigned-badge">${escapeHtml(profileName)}</span></td>
        <td>${statusPill}</td>
        <td style="text-align: center;">
          <button class="btn btn-xs btn-outline" style="color: #f87171; padding: 2px 6px;" onclick="deleteAccountMapping('${escapeHtml(m.account)}')">✕</button>
        </td>
      </tr>
    `;
  }).join("");
}

function updateMappingProfileSelectOptions() {
  const select = document.getElementById("selectMappingProfile");
  if (!select) return;

  const profiles = state.discordProfiles || [];
  if (profiles.length === 0) {
    select.innerHTML = '<option value="">-- No profiles configured --</option>';
    return;
  }

  select.innerHTML = profiles.map(p => `
    <option value="${p.id}">${escapeHtml(p.name)} (${p.status || 'NOT_CONNECTED'})</option>
  `).join("");
}

window.showAddMappingModal = function(prefilledAccount = "") {
  const modal = document.getElementById("addMappingModal");
  const accInput = document.getElementById("inputMappingAccount");
  if (!modal) return;

  updateMappingProfileSelectOptions();
  if (accInput) {
    accInput.value = prefilledAccount || "";
  }

  modal.style.display = "flex";
  if (accInput && !prefilledAccount) accInput.focus();
};

window.closeAddMappingModal = function() {
  const modal = document.getElementById("addMappingModal");
  if (modal) modal.style.display = "none";
};

window.saveAccountMapping = async function() {
  const account = document.getElementById("inputMappingAccount").value.trim();
  const profileId = document.getElementById("selectMappingProfile").value;

  if (!account) {
    alert("Please enter the Published on Account handle.");
    return;
  }
  if (!profileId) {
    alert("Please select a Discord Profile.");
    return;
  }

  try {
    const res = await fetch("/api/account-mappings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account, profileId })
    });
    const data = await res.json();
    if (data.success) {
      closeAddMappingModal();
      await loadAccountMappings();
      renderDualQueueTable(state.loadedQueue);
    } else {
      alert(`Could not save mapping: ${data.error}`);
    }
  } catch (err) {
    alert(`Failed to save mapping: ${err.message}`);
  }
};

window.deleteAccountMapping = async function(account) {
  if (!confirm(`Delete routing rule for "${account}"?`)) {
    return;
  }

  try {
    const res = await fetch(`/api/account-mappings/${encodeURIComponent(account)}`, {
      method: "DELETE"
    });
    const data = await res.json();
    if (data.success) {
      await loadAccountMappings();
      renderDualQueueTable(state.loadedQueue);
    } else {
      alert(`Could not delete mapping: ${data.error}`);
    }
  } catch (err) {
    alert(`Failed to delete mapping: ${err.message}`);
  }
};

window.discoverAccountsFromQueue = async function() {
  if (!state.loadedQueue || state.loadedQueue.length === 0) {
    alert("No clips loaded yet. Click 'Load Pending Clips' first.");
    return;
  }

  try {
    const res = await fetch("/api/account-mappings/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queue: state.loadedQueue })
    });
    const data = await res.json();
    if (data.success) {
      const { discovered, unmapped } = data;
      if (discovered.length === 0) {
        alert("No published account handles found in the loaded clips.");
      } else if (unmapped.length === 0) {
        alert(`Discovered ${discovered.length} account(s): ${discovered.join(", ")}.\n\nAll accounts are mapped to Discord profiles!`);
      } else {
        alert(`Discovered ${discovered.length} account(s): ${discovered.join(", ")}.\n\n${unmapped.length} account(s) are unmapped: ${unmapped.join(", ")}.`);
        showAddMappingModal(unmapped[0]);
      }
    } else {
      alert(`Discovery failed: ${data.error}`);
    }
  } catch (err) {
    alert(`Discovery request failed: ${err.message}`);
  }
};

async function updateRoutingPreflightSummary() {
  const box = document.getElementById("routingPreflightSummary");
  if (!box) return;

  if (!state.loadedQueue || state.loadedQueue.length === 0) {
    box.style.display = "none";
    return;
  }

  try {
    const res = await fetch("/api/account-mappings/preflight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queue: state.loadedQueue })
    });
    const data = await res.json();
    if (!data.success) {
      box.style.display = "none";
      return;
    }

    const { summary, unmappedAccounts, disconnectedProfiles } = data;
    box.style.display = "block";

    let html = `
      <div class="preflight-status-title">
        <span class="status-dot" style="background: ${summary.safeToRun ? '#10b981' : '#f59e0b'};"></span>
        <strong>Preflight Routing Check:</strong>
        ${summary.safeToRun 
          ? '<span style="color: #34d399;">Ready for execution</span>' 
          : '<span style="color: #fbbf24;">Action required before starting</span>'}
      </div>
      <div class="preflight-stats-row">
        <span>Eligible: <strong>${summary.eligibleCount}</strong></span>
        <span>Mapped: <strong>${summary.mappedCount}</strong></span>
        <span>Unmapped: <strong style="${unmappedAccounts.length > 0 ? 'color:#f87171;' : ''}">${unmappedAccounts.length}</strong></span>
        <span>Disconnected: <strong style="${disconnectedProfiles.length > 0 ? 'color:#fbbf24;' : ''}">${disconnectedProfiles.length}</strong></span>
      </div>
    `;

    if (unmappedAccounts.length > 0) {
      html += `
        <div class="preflight-warning-list" style="margin-top: 8px;">
          <span style="color: #f87171; font-weight: 600;">⚠ Unmapped accounts detected:</span>
          ${unmappedAccounts.map(acc => `
            <span class="unmapped-account-tag">
              ${escapeHtml(acc)}
              <button class="btn btn-xs btn-primary" style="padding: 1px 6px; font-size: 10px; margin-left: 4px;" onclick="showAddMappingModal('${escapeHtml(acc)}')">+ Map</button>
            </span>
          `).join(" ")}
        </div>
      `;
    }

    if (disconnectedProfiles.length > 0) {
      html += `
        <div class="preflight-warning-list" style="margin-top: 8px;">
          <span style="color: #fbbf24; font-weight: 600;">⚠ Disconnected profile(s) used by queue:</span>
          ${disconnectedProfiles.map(p => `
            <span class="badge" style="background: rgba(245, 158, 11, 0.2); color: #fbbf24;">
              ${escapeHtml(p.name)}
              <button class="btn btn-xs btn-secondary" style="padding: 1px 6px; font-size: 10px; margin-left: 4px;" onclick="launchDiscordProfileBrowser('${p.id}')">Open</button>
            </span>
          `).join(" ")}
        </div>
      `;
    }

    box.innerHTML = html;
  } catch (err) {
    console.warn("Preflight check failed:", err);
  }
}

window.startDualJob = async function() {
  const websiteUrl = document.getElementById("inputWebsiteUrl").value.trim();
  const discordUrl = document.getElementById("inputDiscordUrl").value.trim();

  if (!websiteUrl || !discordUrl) {
    alert("Please provide both Cleanframe URL and Discord Channel URL.");
    return;
  }

  if (state.loadedQueue.length === 0) {
    alert("No pending clips loaded. Please click 'Load Pending Clips' first.");
    return;
  }

  const btn = document.getElementById("btnStartJob");
  btn.disabled = true;

  try {
    const res = await fetch("/api/jobs/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        submissionType: "dual",
        browserConfig: getBrowserConfig(),
        websiteUrl,
        discordUrl,
        queueOverride: state.loadedQueue
      })
    });
    const data = await res.json();

    if (data.success && data.job) {
      state.activeJob = data.job;
      renderActiveJob(data.job);
    } else {
      alert(`Could not start job: ${data.error}`);
    }
  } catch (err) {
    alert(`Failed to start job: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
};

// ==========================================
// KICK SUBMISSION UI, CREATOR ASSIGNMENT & START
// ==========================================

function validateKickQueue() {
  const warningBanner = document.getElementById("kickValidationWarning");
  const warningText = document.getElementById("kickValidationWarningText");
  const btnStart = document.getElementById("btnStartKickJob");

  if (!warningBanner || !btnStart) return;

  const selectedClips = state.loadedQueue.filter(c => state.selectedKickIds.has(c.id));
  const missingCount = selectedClips.filter(c => !c.creator).length;

  if (selectedClips.length === 0) {
    btnStart.disabled = true;
    warningBanner.style.display = "none";
    return false;
  }

  if (missingCount > 0) {
    warningBanner.style.display = "flex";
    warningText.textContent = `${missingCount} selected reel${missingCount > 1 ? 's are' : ' is'} missing a Creator. Assign a Creator before starting.`;
    btnStart.disabled = false;
    return false;
  } else {
    warningBanner.style.display = "none";
    btnStart.disabled = false;
    return true;
  }
}

function renderKickQueueTable(queue = []) {
  window.renderKickQueueTable = renderKickQueueTable;
  const tbody = document.getElementById("kickQueueTableBody");
  const countLabel = document.getElementById("kickQueueCountLabel");
  const bulkBar = document.getElementById("kickBulkAssignBar");

  if (!tbody) return;
  countLabel.textContent = queue.length;
  bulkBar.style.display = queue.length > 0 ? "flex" : "none";

  if (queue.length === 0) {
    tbody.innerHTML = `
      <tr class="empty-row">
        <td colspan="6">No reels loaded yet. Click <strong>"Load Pending Clips"</strong> to fetch available reels.</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = queue.map((clip, idx) => {
    const isSelected = state.selectedKickIds.has(clip.id);
    const hasCreator = Boolean(clip.creator);

    return `
      <tr class="${!hasCreator ? 'row-missing' : ''} ${isSelected ? 'row-selected' : ''}">
        <td style="text-align: center;">
          <input type="checkbox" ${isSelected ? 'checked' : ''} onchange="toggleSelectKickRow('${clip.id}', this.checked)">
        </td>
        <td><strong>${idx + 1}</strong></td>
        <td class="font-mono" style="font-size: 0.8rem;">
          <a href="${clip.clipUrl || clip.instagramLink}" target="_blank" style="color:#38bdf8">${clip.clipUrl || clip.instagramLink}</a>
        </td>
        <td>
          ${hasCreator ? `<strong style="color:#60a5fa">${clip.creator}</strong>` : '<span class="badge badge-MISSING">MISSING</span>'}
        </td>
        <td class="font-mono" style="color:#a5b4fc">
          ${clip.command ? `/${clip.command}` : '<span class="text-muted">--</span>'}
        </td>
        <td><span class="badge badge-${clip.state}">${clip.state}</span></td>
      </tr>
    `;
  }).join("");

  updateKickSelectionUI();
}

// Selection Handlers
window.toggleSelectKickRow = function(id, isChecked) {
  if (isChecked) {
    state.selectedKickIds.add(id);
  } else {
    state.selectedKickIds.delete(id);
  }
  renderKickQueueTable(state.loadedQueue);
  validateKickQueue();
};

window.toggleSelectAllKick = function(isChecked) {
  if (isChecked) {
    state.loadedQueue.forEach(c => state.selectedKickIds.add(c.id));
  } else {
    state.selectedKickIds.clear();
  }
  renderKickQueueTable(state.loadedQueue);
  validateKickQueue();
};

window.selectMissingKickRows = function() {
  state.selectedKickIds.clear();
  state.loadedQueue.forEach(c => {
    if (!c.creator) {
      state.selectedKickIds.add(c.id);
    }
  });
  renderKickQueueTable(state.loadedQueue);
  validateKickQueue();
};

window.clearKickSelection = function() {
  state.selectedKickIds.clear();
  renderKickQueueTable(state.loadedQueue);
  validateKickQueue();
};

function updateKickSelectionUI() {
  const selectedCount = state.selectedKickIds.size;
  const missingCount = state.loadedQueue.filter(c => !c.creator).length;

  const selBadge = document.getElementById("kickSelectedCount");
  const missBadge = document.getElementById("btnMissingCountBadge");
  const btnApply = document.getElementById("btnApplyCreator");

  if (selBadge) selBadge.textContent = selectedCount;
  if (missBadge) missBadge.textContent = missingCount;

  if (btnApply) {
    btnApply.textContent = selectedCount > 0 ? `Assign to ${selectedCount} Reel${selectedCount > 1 ? 's' : ''}` : "Assign Creator";
    btnApply.disabled = selectedCount === 0;
  }

  const chkAll = document.getElementById("chkSelectAllKick");
  if (chkAll) {
    const total = state.loadedQueue.length;
    chkAll.checked = total > 0 && selectedCount === total;
    chkAll.indeterminate = selectedCount > 0 && selectedCount < total;
  }
}

// Manual Creator Assignment
window.applyManualCreator = function() {
  const input = document.getElementById("manualCreatorInput");
  const creatorName = input.value.trim();

  if (!creatorName) {
    alert("Please enter a Creator name (e.g. N3on).");
    input.focus();
    return;
  }

  if (state.selectedKickIds.size === 0) {
    alert("Please select at least one reel to assign a Creator.");
    return;
  }

  const selectedClips = state.loadedQueue.filter(c => state.selectedKickIds.has(c.id));
  const existingCreators = selectedClips.filter(c => Boolean(c.creator));

  if (existingCreators.length > 0) {
    state.pendingOverrideCreator = creatorName;
    document.getElementById("overrideModalMessage").textContent = `You are about to replace the Creator for ${existingCreators.length} reel${existingCreators.length > 1 ? 's' : ''}. Continue?`;
    document.getElementById("creatorOverrideModal").style.display = "flex";
  } else {
    executeCreatorAssignment(creatorName);
  }
};

window.closeOverrideModal = function() {
  document.getElementById("creatorOverrideModal").style.display = "none";
  state.pendingOverrideCreator = null;
};

window.confirmOverrideCreator = function() {
  if (state.pendingOverrideCreator) {
    executeCreatorAssignment(state.pendingOverrideCreator);
    closeOverrideModal();
  }
};

function executeCreatorAssignment(creatorName) {
  const command = normalizeCreatorSlug(creatorName);

  state.loadedQueue.forEach(clip => {
    if (state.selectedKickIds.has(clip.id)) {
      clip.creator = creatorName;
      clip.command = command;
      clip.clipper = creatorName;
    }
  });

  const assignedClips = state.loadedQueue.filter(c => state.selectedKickIds.has(c.id));
  console.log(`[Frontend] Creator assigned: "${creatorName}" to ${assignedClips.length} reels`);
  console.log("[Frontend] After Creator assignment:", assignedClips.map(c => ({
    id: c.id,
    url: c.clipUrl || c.instagramLink,
    creator: c.creator,
    command: c.command
  })));

  document.getElementById("manualCreatorInput").value = "";
  renderKickQueueTable(state.loadedQueue);
  validateKickQueue();
}

window.startKickJob = async function() {
  const discordUrl = document.getElementById("inputKickDiscordUrl").value.trim();

  if (!discordUrl) {
    alert("Please provide the Kick Discord Channel URL.");
    return;
  }

  const selectedClips = state.loadedQueue.filter(c => state.selectedKickIds.has(c.id)).map(c => ({
    id: c.id,
    url: c.clipUrl || c.instagramLink,
    clipUrl: c.clipUrl || c.instagramLink,
    instagramLink: c.clipUrl || c.instagramLink,
    creator: c.creator,
    command: c.command || normalizeCreatorSlug(c.creator),
    clipper: c.creator,
    state: c.state || "PENDING"
  }));

  console.log("[Frontend] Selected reel IDs:", Array.from(state.selectedKickIds));
  console.log(`[Frontend] Selected reels count: ${selectedClips.length}`);

  if (selectedClips.length === 0) {
    alert("No reels selected. Please select at least one reel to submit.");
    return;
  }

  // Pre-flight check for missing creators among selected reels
  const missingClips = selectedClips.filter(c => !c.creator);
  if (missingClips.length > 0) {
    alert(`${missingClips.length} selected reel${missingClips.length > 1 ? 's are' : ' is'} missing a Creator. Assign a Creator before starting.`);
    selectMissingKickRows();
    document.getElementById("manualCreatorInput").focus();
    return;
  }

  // Pre-flight check for missing URLs
  const missingUrls = selectedClips.filter(c => !c.url);
  if (missingUrls.length > 0) {
    alert(`${missingUrls.length} selected reel${missingUrls.length > 1 ? 's are' : ' is'} missing a URL.`);
    return;
  }

  const payload = {
    submissionType: "kick",
    browserConfig: getBrowserConfig(),
    discordUrl,
    reels: selectedClips,
    queueOverride: selectedClips
  };

  console.log("[START REQUEST] Kick submission payload:", payload);

  const btn = document.getElementById("btnStartKickJob");
  btn.disabled = true;

  try {
    const res = await fetch("/api/jobs/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (data.success && data.job) {
      state.activeJob = data.job;
      renderActiveJob(data.job);
    } else {
      alert(`Could not start Kick job: ${data.error}`);
    }
  } catch (err) {
    alert(`Failed to start Kick job: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
};

// ==========================================
// ACTIVE JOB MONITORING & CANCELLATION
// ==========================================

window.cancelActiveJob = async function() {
  if (!state.activeJob) return;

  if (!confirm(`Are you sure you want to stop Job #${state.activeJob.id}? It will halt safely before the next clip.`)) {
    return;
  }

  try {
    await fetch(`/api/jobs/${state.activeJob.id}/cancel`, { method: "POST" });
  } catch (err) {
    alert(`Failed to cancel job: ${err.message}`);
  }
};

function renderActiveJob(job) {
  const section = document.getElementById("activeJobSection");
  if (!job) {
    section.style.display = "none";
    return;
  }

  section.style.display = "block";
  document.getElementById("activeJobIdBadge").textContent = `#${job.id}`;

  const typeBadge = document.getElementById("activeJobTypeBadge");
  typeBadge.textContent = job.submissionType?.toUpperCase() || "DUAL";
  typeBadge.className = `badge ${job.submissionType === "kick" ? "badge-accent" : "badge-success"}`;

  document.getElementById("activeJobCurrentStep").textContent = `${job.currentStep || "Processing"} ${job.currentStepDetail ? `— ${job.currentStepDetail}` : ""}`;

  const current = job.processedCount || 0;
  const total = job.totalCount || job.queue?.length || 0;
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;

  document.getElementById("progressText").textContent = `Progress: ${current} / ${total} clips`;
  document.getElementById("progressPercent").textContent = `${percent}%`;
  document.getElementById("progressBarFill").style.width = `${percent}%`;

  if (job.currentClip) {
    const isKick = job.submissionType === "kick";
    document.getElementById("heroLabelTarget").textContent = isKick ? "Target Reel" : "Instagram URL";
    document.getElementById("heroLabelEntity1").textContent = isKick ? "Creator" : "Clipper";
    document.getElementById("heroLabelEntity2").textContent = isKick ? "Slash Command" : "Editor";

    document.getElementById("heroInstagram").textContent = isKick ? (job.currentClip.clipUrl || job.currentClip.instagramLink) : job.currentClip.instagramLink;
    document.getElementById("heroClipper").textContent = isKick ? (job.currentClip.creator || "Unknown") : `@${job.currentClip.clipper}`;
    document.getElementById("heroEditor").textContent = isKick ? `/${job.currentClip.command}` : (job.currentClip.editor ? `@${job.currentClip.editor}` : "(unclaimed)");
  }

  if (job.logs && job.logs.length > 0) {
    const logsBox = document.getElementById("liveLogsBox");
    logsBox.innerHTML = job.logs.map(l => `
      <div class="log-line">
        <span class="log-time">[${l.timestamp}]</span>
        <span class="log-msg">${escapeHtml(l.message)}</span>
      </div>
    `).join("");
    logsBox.scrollTop = logsBox.scrollHeight;
  }

  if (job.summary && job.summary.reelsReport && job.summary.reelsReport.length > 0) {
    renderReconciliationReport("activeJob", job.summary, job.status);
  } else {
    renderReconciliationReport("activeJob", null, null);
  }
}

function appendLiveLog(logEntry) {
  const logsBox = document.getElementById("liveLogsBox");
  if (!logsBox) return;

  const line = document.createElement("div");
  line.className = "log-line";
  line.innerHTML = `<span class="log-time">[${logEntry.timestamp}]</span> <span class="log-msg">${escapeHtml(logEntry.message)}</span>`;
  logsBox.appendChild(line);
  logsBox.scrollTop = logsBox.scrollHeight;
}

window.clearLiveLogs = function() {
  document.getElementById("liveLogsBox").innerHTML = "";
};

// ==========================================
// HISTORY VIEW & MODAL
// ==========================================

async function loadHistory() {
  try {
    const res = await fetch("/api/history");
    const data = await res.json();
    state.history = data;
    renderHistoryTable(data);
  } catch (err) {
    console.warn("Could not load history:", err);
  }
}

function renderHistoryTable(history = []) {
  const tbody = document.getElementById("historyTableBody");
  if (!tbody) return;

  if (history.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="9">No submission history found.</td></tr>`;
    return;
  }

  tbody.innerHTML = history.map(j => {
    const dateStr = j.createdAt ? new Date(j.createdAt).toLocaleString() : "--";
    const total = j.summary?.total || j.queue?.length || 0;
    const success = j.summary?.success || 0;
    const already = j.summary?.already || j.summary?.skipped || 0;
    const failed = j.summary?.failed || 0;

    return `
      <tr>
        <td><strong>#${j.id}</strong></td>
        <td><span class="badge ${j.submissionType === 'kick' ? 'badge-accent' : 'badge-success'}">${j.submissionType?.toUpperCase() || 'DUAL'}</span></td>
        <td>${total}</td>
        <td style="color:#34d399"><strong>${success}</strong></td>
        <td style="color:#22d3ee">${already}</td>
        <td style="color:#f87171">${failed}</td>
        <td><span class="badge badge-${j.status === 'COMPLETED' ? 'success' : (j.status === 'FAILED' ? 'danger' : 'muted')}">${j.status}</span></td>
        <td>${dateStr}</td>
        <td>
          <button class="btn btn-xs btn-outline" onclick="openJobModal('${j.id}')">View Clips</button>
        </td>
      </tr>
    `;
  }).join("");
}

window.openJobModal = async function(jobId) {
  const job = state.history.find(j => String(j.id) === String(jobId));
  if (!job) return;

  const isKick = job.submissionType === "kick";
  document.getElementById("modalJobTitle").textContent = `Job Details #${job.id} (${job.submissionType?.toUpperCase()})`;

  const metaGrid = document.getElementById("modalMetaGrid");
  metaGrid.innerHTML = `
    <div><div class="clip-hero-label">Status</div><strong>${job.status}</strong></div>
    <div><div class="clip-hero-label">Total Clips</div><strong>${job.summary?.total || job.queue?.length || 0}</strong></div>
    <div><div class="clip-hero-label">Success Sync</div><strong style="color:#34d399">${job.summary?.success || 0}</strong></div>
    <div><div class="clip-hero-label">Created At</div><span style="font-size:0.8rem">${new Date(job.createdAt).toLocaleString()}</span></div>
  `;

  const tbody = document.getElementById("modalClipsTableBody");
  const queue = job.queue || [];

  if (queue.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-muted" style="text-align:center">No individual clip logs stored.</td></tr>`;
  } else {
    tbody.innerHTML = queue.map((c, i) => `
      <tr>
        <td>${i + 1}</td>
        <td class="font-mono" style="font-size:0.75rem;"><a href="${isKick ? (c.clipUrl || c.instagramLink) : c.instagramLink}" target="_blank" style="color:#60a5fa">${isKick ? (c.clipUrl || c.instagramLink) : c.instagramLink}</a></td>
        <td>${c.publishedOnAccount ? `<strong style="color:#c084fc">${escapeHtml(c.publishedOnAccount)}</strong>` : '<span class="text-muted">--</span>'}</td>
        <td>${c.discordProfileName ? `<span class="profile-assigned-badge">${escapeHtml(c.discordProfileName)}</span>` : (c.discordProfileId ? escapeHtml(c.discordProfileId) : '<span class="text-muted">--</span>')}</td>
        <td>${isKick ? escapeHtml(c.creator) : `@${escapeHtml(c.clipper || 'unknown')}`}</td>
        <td><span class="badge badge-${c.state}">${c.state}</span></td>
        <td class="font-mono" style="font-size:0.75rem;">${c.discordId ? `#${escapeHtml(c.discordId)}` : escapeHtml(c.discordMessage || c.errorReason || '--')}</td>
      </tr>
    `).join("");
  }

  if (job.summary && job.summary.reelsReport && job.summary.reelsReport.length > 0) {
    renderReconciliationReport("modal", job.summary, job.status);
  } else {
    renderReconciliationReport("modal", null, null);
  }

  document.getElementById("jobDetailModal").style.display = "flex";
};

window.closeJobModal = function() {
  document.getElementById("jobDetailModal").style.display = "none";
};

function renderReconciliationReport(prefix, summary, status) {
  const container = document.getElementById(`${prefix}ReconciliationSection`);
  if (!container) return;

  if (!summary || !summary.reelsReport || summary.reelsReport.length === 0) {
    container.style.display = "none";
    return;
  }

  container.style.display = "block";

  // Badge
  const badge = document.getElementById(`${prefix}ReconciliationBadge`);
  if (badge) {
    if (summary.allReconciled) {
      badge.textContent = "✓ 100% Reconciled";
      badge.className = "badge badge-success";
    } else if (status === "COMPLETED_WITH_WARNINGS" || (summary.needsAttention && summary.needsAttention > 0)) {
      badge.textContent = `⚠ Incomplete (${summary.needsAttention || 0} Need Attention)`;
      badge.className = "badge badge-warning";
    } else if (status === "FAILED") {
      badge.textContent = "✕ Failed";
      badge.className = "badge badge-danger";
    } else {
      badge.textContent = status || "Processed";
      badge.className = "badge badge-muted";
    }
  }

  // Stats Grid
  const statsGrid = document.getElementById(`${prefix}ReconciliationStatsGrid`);
  if (statsGrid) {
    statsGrid.innerHTML = `
      <div class="reconciliation-stat-box">
        <span class="reconciliation-stat-value">${summary.total || 0}</span>
        <span class="reconciliation-stat-label">Total Reels</span>
      </div>
      <div class="reconciliation-stat-box">
        <span class="reconciliation-stat-value" style="color: #34d399;">${summary.discordSuccess || 0}</span>
        <span class="reconciliation-stat-label">Discord Confirmed</span>
      </div>
      <div class="reconciliation-stat-box">
        <span class="reconciliation-stat-value" style="color: #f87171;">${(summary.discordFailed || 0) + (summary.discordSkipped || 0)}</span>
        <span class="reconciliation-stat-label">Discord Failed/Skip</span>
      </div>
      <div class="reconciliation-stat-box">
        <span class="reconciliation-stat-value" style="color: #34d399;">${summary.cleanframeCompleted || 0}</span>
        <span class="reconciliation-stat-label">Cleanframe Marked</span>
      </div>
      <div class="reconciliation-stat-box">
        <span class="reconciliation-stat-value" style="color: ${(summary.cleanframeFailed || summary.cleanframeUnknown) ? '#fbbf24' : '#9ca3af'};">${(summary.cleanframeFailed || 0) + (summary.cleanframeUnknown || 0)}</span>
        <span class="reconciliation-stat-label">Cleanframe Unverified</span>
      </div>
      <div class="reconciliation-stat-box">
        <span class="reconciliation-stat-value" style="color: #34d399;">${summary.fullyCompleted || 0}</span>
        <span class="reconciliation-stat-label">Overall Complete</span>
      </div>
      <div class="reconciliation-stat-box">
        <span class="reconciliation-stat-value" style="color: ${(summary.needsAttention || 0) > 0 ? '#fbbf24' : '#9ca3af'};">${summary.needsAttention || 0}</span>
        <span class="reconciliation-stat-label">Needs Attention</span>
      </div>
    `;
  }

  // Manual Actions Alert
  const manualAlert = document.getElementById(`${prefix}ManualActionsAlert`);
  if (manualAlert) {
    if (summary.manualActions && summary.manualActions.length > 0) {
      manualAlert.style.display = "block";
      manualAlert.innerHTML = `
        <strong>⚠ Manual Actions Required (${summary.manualActions.length}):</strong>
        <ul style="margin: 4px 0 0 18px; padding: 0;">
          ${summary.manualActions.map(a => `<li>${escapeHtml(a)}</li>`).join("")}
        </ul>
      `;
    } else {
      manualAlert.style.display = "none";
      manualAlert.innerHTML = "";
    }
  }

  // Table Body
  const tbody = document.getElementById(`${prefix}ReconciliationTableBody`);
  if (tbody) {
    tbody.innerHTML = summary.reelsReport.map(r => {
      let discordBadge = `<span class="badge badge-muted">${escapeHtml(r.discordResult)}</span>`;
      if (r.discordResult === "SUCCESS") {
        discordBadge = `<span class="badge badge-success">✓ SUCCESS</span>${r.discordId ? `<div style="font-size:0.7rem; color:#9ca3af; margin-top:2px;">#${escapeHtml(r.discordId)}</div>` : ""}`;
      } else if (r.discordResult === "FAILED") {
        discordBadge = `<span class="badge badge-danger">✕ FAILED</span>`;
      } else if (r.discordResult === "UNKNOWN") {
        discordBadge = `<span class="badge badge-warning">? UNKNOWN</span>`;
      } else if (r.discordResult === "SKIPPED") {
        discordBadge = `<span class="badge badge-muted">SKIPPED</span>`;
      }

      let cfBadge = `<span class="badge badge-muted">${escapeHtml(r.cleanframeMark)}</span>`;
      if (r.cleanframeMark === "COMPLETED") {
        cfBadge = `<span class="badge badge-success">✓ MARKED</span>${r.greenRowConfirmed ? `<span class="badge-green-row" style="margin-left:4px;">🟢 Green</span>` : ""}`;
      } else if (r.cleanframeMark === "FAILED") {
        cfBadge = `<span class="badge badge-danger">✕ FAILED</span>`;
      } else if (r.cleanframeMark === "UNKNOWN") {
        cfBadge = `<span class="badge badge-warning">? UNKNOWN</span>`;
      } else if (r.cleanframeMark === "PENDING") {
        cfBadge = `<span class="badge badge-muted">PENDING</span>`;
      } else if (r.cleanframeMark === "NOT_REQUIRED") {
        cfBadge = `<span class="badge badge-muted">NOT REQUIRED</span>`;
      }

      let overallBadge = `<span class="badge badge-${escapeHtml(r.overallResult)}">${escapeHtml(r.overallResult)}</span>`;
      if (r.overallResult === "COMPLETE") {
        overallBadge = `<span class="badge badge-COMPLETE">✓ COMPLETE</span>`;
      } else if (r.overallResult === "NEEDS_ATTENTION") {
        overallBadge = `<span class="badge badge-NEEDS_ATTENTION">⚠ NEEDS ATTENTION</span>`;
      } else if (r.overallResult === "FAILED") {
        overallBadge = `<span class="badge badge-danger">✕ FAILED</span>`;
      } else if (r.overallResult === "SKIPPED") {
        overallBadge = `<span class="badge badge-muted">SKIPPED</span>`;
      }

      const manualMsg = r.manualAction ? `<div style="font-size:0.7rem; color:#fbbf24; margin-top:2px;">${escapeHtml(r.manualAction)}</div>` : "";

      return `
        <tr>
          <td>
            <div class="font-mono" style="font-size:0.75rem;"><a href="${escapeHtml(r.reel)}" target="_blank" style="color:#60a5fa">${escapeHtml(r.reel)}</a></div>
            <div style="font-size:0.7rem; color:#9ca3af;">${escapeHtml(r.sourceId || '')}</div>
          </td>
          <td>
            ${r.publishedAccount && r.publishedAccount !== '--' ? `<strong style="color:#c084fc">@${escapeHtml(r.publishedAccount)}</strong>` : '<span class="text-muted">--</span>'}
          </td>
          <td>
            <span class="profile-assigned-badge">${escapeHtml(r.discordProfile || 'default')}</span>
          </td>
          <td>
            ${discordBadge}
          </td>
          <td>
            ${cfBadge}
          </td>
          <td>
            ${overallBadge}
            ${manualMsg}
          </td>
        </tr>
      `;
    }).join("");
  }
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ==========================================
// WORKFLOW BUILDER & BROWSER RECORDER LOGIC
// ==========================================

async function loadWorkflowsList() {
  try {
    const res = await fetch("/api/workflows");
    const data = await res.json();
    if (data.success && Array.isArray(data.workflows)) {
      state.workflows = data.workflows;
      renderWorkflowTemplatesDropdown(data.workflows);
    }
  } catch (err) {
    console.warn("Could not load workflows:", err);
  }
}

function renderWorkflowTemplatesDropdown(workflows) {
  const select = document.getElementById("workflowTemplateSelect");
  if (!select) return;

  const currentVal = select.value;
  select.innerHTML = '<option value="">-- New Workflow --</option>' + workflows.map(w => `
    <option value="${w.id}">${escapeHtml(w.name)} (v${w.version} ${w.status})</option>
  `).join("");

  if (currentVal && workflows.some(w => w.id === currentVal)) {
    select.value = currentVal;
  }
}

window.loadSelectedWorkflow = async function(workflowId) {
  if (!workflowId) {
    state.currentWorkflow = null;
    document.getElementById("workflowNameInput").value = "";
    document.getElementById("workflowDescInput").value = "";
    state.recordedSteps = [];
    renderRecordedStepsTable();
    return;
  }

  try {
    const res = await fetch(`/api/workflows/${workflowId}`);
    const data = await res.json();
    if (data.success && data.workflow) {
      const wf = data.workflow;
      state.currentWorkflow = wf;
      document.getElementById("workflowNameInput").value = wf.name || "";
      document.getElementById("workflowDescInput").value = wf.description || "";
      state.recordedSteps = wf.steps || [];
      renderRecordedStepsTable();
      showRecorderFeedback(`Loaded template "${wf.name}" (v${wf.version}, ${wf.status})`, "info");
    }
  } catch (err) {
    showRecorderFeedback(`Failed to load workflow #${workflowId}: ${err.message}`, "error");
  }
};

function updateRecorderUI(status) {
  const badge = document.getElementById("recorderStatusIndicator");
  const text = document.getElementById("recorderStatusText");
  const btnStart = document.getElementById("btnStartRecording");
  const btnPause = document.getElementById("btnPauseRecording");
  const btnResume = document.getElementById("btnResumeRecording");
  const btnStop = document.getElementById("btnStopRecording");

  if (!badge) return;

  if (status === "RECORDING") {
    badge.className = "status-indicator recording";
    text.textContent = "● Recording Live";
    btnStart.style.display = "none";
    btnPause.style.display = "inline-flex";
    btnResume.style.display = "none";
    btnStop.style.display = "inline-flex";
  } else if (status === "PAUSED") {
    badge.className = "status-indicator paused";
    text.textContent = "⏸ Recording Paused";
    btnStart.style.display = "none";
    btnPause.style.display = "none";
    btnResume.style.display = "inline-flex";
    btnStop.style.display = "inline-flex";
  } else {
    badge.className = "status-indicator offline";
    text.textContent = "Recorder Idle";
    btnStart.style.display = "inline-flex";
    btnPause.style.display = "none";
    btnResume.style.display = "none";
    btnStop.style.display = "none";
  }
}

function showRecorderFeedback(message, type = "info") {
  const el = document.getElementById("recorderFeedback");
  if (!el) return;
  el.className = `test-feedback ${type}`;
  el.textContent = message;
}

function handleRecordedStepEvent(payload) {
  const step = payload.step;
  if (!step) return;

  // Ignore duplicates by stepId
  if (state.recordedSteps.some(s => s.stepId === step.stepId)) return;

  state.recordedSteps.push(step);
  renderRecordedStepsTable();

  // Show sensitive warning banner if sensitive input detected
  if (step.isSensitive) {
    const alertEl = document.getElementById("recorderSensitiveAlert");
    if (alertEl) alertEl.style.display = "flex";
  }
}

function renderRecordedStepsTable() {
  const tbody = document.getElementById("recordedStepsTableBody");
  const countLabel = document.getElementById("recordedStepsCount");
  if (countLabel) countLabel.textContent = state.recordedSteps.length;

  if (!tbody) return;

  if (state.recordedSteps.length === 0) {
    tbody.innerHTML = `
      <tr class="empty-row">
        <td colspan="9">No steps yet. Start recording or click <strong>"+ Add Step"</strong> to create actions.</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = state.recordedSteps.map((s, idx) => {
    let locatorStr = "--";
    if (s.locator) {
      if (s.locator.testId) {
        locatorStr = `[data-testid="${escapeHtml(s.locator.testId)}"]`;
      } else if (s.locator.role && s.locator.accessibleName) {
        locatorStr = `role=${escapeHtml(s.locator.role)} "${escapeHtml(s.locator.accessibleName)}"`;
      } else if (s.locator.id) {
        locatorStr = `#${escapeHtml(s.locator.id)}`;
      } else if (s.locator.css) {
        locatorStr = escapeHtml(s.locator.css);
      } else if (s.locator.primary) {
        locatorStr = escapeHtml(s.locator.primary);
      }
    }

    let valueStr = s.value !== null && s.value !== undefined ? String(s.value) : "--";
    if (s.actionType === "wait") {
      valueStr = `${Number(s.value) / 1000}s duration`;
    }

    const isEnabled = s.enabled !== false;
    const isFirst = idx === 0;
    const isLast = idx === state.recordedSteps.length - 1;

    return `
      <tr class="${!isEnabled ? 'row-disabled' : ''}">
        <td style="text-align: center;">
          <input type="checkbox" ${isEnabled ? 'checked' : ''} onchange="toggleStepEnabled('${s.stepId}', this.checked)" title="Enable / Disable Step">
        </td>
        <td style="font-weight:600; color:var(--text-muted);">${idx + 1}</td>
        <td>
          <span class="action-type-pill action-${s.actionType}">
            ${s.actionType}
          </span>
          ${s.isSensitive ? '<span class="step-sensitive-badge">SENSITIVE</span>' : ''}
        </td>
        <td>
          ${s.locator ? `<span class="locator-code">${locatorStr}</span>` : '<span class="text-muted">N/A</span>'}
        </td>
        <td>
          <span class="font-mono text-sm">${escapeHtml(valueStr)}</span>
        </td>
        <td style="color:var(--text-muted); font-size:0.8rem;">
          ${s.timeout ? `${s.timeout / 1000}s` : '--'}
        </td>
        <td style="color:var(--text-muted); font-size:0.78rem;">
          <code>${escapeHtml(s.failurePolicy || "stop")}</code>
        </td>
        <td style="color:var(--text-muted); font-size:0.82rem;">
          ${escapeHtml(s.comment || "")}
        </td>
        <td style="text-align: center;">
          <div class="step-btn-group">
            <button class="btn-icon-xs" onclick="moveStep(${idx}, -1)" ${isFirst ? 'disabled style="opacity:0.3"' : ''} title="Move Up">↑</button>
            <button class="btn-icon-xs" onclick="moveStep(${idx}, 1)" ${isLast ? 'disabled style="opacity:0.3"' : ''} title="Move Down">↓</button>
            <button class="btn-icon-xs" onclick="duplicateStep('${s.stepId}')" title="Duplicate Step">⎘</button>
            <button class="btn-icon-xs" onclick="openStepEditModal('${s.stepId}')" title="Edit Step">✎</button>
            <button class="btn-icon-xs btn-delete" onclick="removeRecordedStep('${s.stepId}')" title="Delete Step">✕</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");
}

window.startRecorderSession = async function() {
  if (!state.agentOnline) {
    showRecorderFeedback("Cannot start recording: Local Desktop Agent is offline. Please launch agent first.", "error");
    return;
  }

  showRecorderFeedback("Initializing recorder on designated browser session...", "info");
  const browserConfig = getBrowserConfig();

  try {
    const res = await fetch("/api/recorder/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browserConfig })
    });
    const data = await res.json();
    if (!data.success) {
      throw new Error(data.error || "Failed to start recorder");
    }
    state.recordingState = "RECORDING";
    state.activeRecordingSessionId = data.session?.sessionId;
    updateRecorderUI("RECORDING");
    showRecorderFeedback("● Recording active in browser session. Interact with elements to record steps.", "info");
  } catch (err) {
    showRecorderFeedback(`Start Recording Error: ${err.message}`, "error");
  }
};

window.pauseRecorderSession = async function() {
  try {
    const res = await fetch("/api/recorder/pause", { method: "POST" });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    state.recordingState = "PAUSED";
    updateRecorderUI("PAUSED");
  } catch (err) {
    showRecorderFeedback(`Pause Error: ${err.message}`, "error");
  }
};

window.resumeRecorderSession = async function() {
  try {
    const res = await fetch("/api/recorder/resume", { method: "POST" });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    state.recordingState = "RECORDING";
    updateRecorderUI("RECORDING");
  } catch (err) {
    showRecorderFeedback(`Resume Error: ${err.message}`, "error");
  }
};

window.stopRecorderSession = async function() {
  try {
    const res = await fetch("/api/recorder/stop", { method: "POST" });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    state.recordingState = "IDLE";
    state.activeRecordingSessionId = null;
    updateRecorderUI("IDLE");
  } catch (err) {
    showRecorderFeedback(`Stop Error: ${err.message}`, "error");
  }
};

window.promptAddWaitStep = async function() {
  const durationSec = prompt("Enter wait duration in seconds (e.g. 5, 10):", "5");
  if (!durationSec) return;
  const durationMs = (parseFloat(durationSec) || 5) * 1000;
  const comment = `Wait ${durationSec}s`;

  if (state.recordingState === "RECORDING" || state.recordingState === "PAUSED") {
    try {
      await fetch("/api/recorder/wait", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ durationMs, comment })
      });
    } catch (err) {
      showRecorderFeedback(`Failed to add wait step: ${err.message}`, "error");
    }
  } else {
    // Add locally to step list
    const step = {
      stepId: `step_${Math.random().toString(36).slice(2, 10)}`,
      actionType: "wait",
      locator: null,
      value: durationMs,
      timeout: durationMs,
      enabled: true,
      comment
    };
    state.recordedSteps.push(step);
    renderRecordedStepsTable();
  }
};

window.promptAddCommentStep = async function() {
  const text = prompt("Enter annotation / explanatory comment for this step:");
  if (!text) return;

  if (state.recordingState === "RECORDING" || state.recordingState === "PAUSED") {
    try {
      await fetch("/api/recorder/comment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
      });
    } catch (err) {
      showRecorderFeedback(`Failed to add comment step: ${err.message}`, "error");
    }
  } else {
    const step = {
      stepId: `step_${Math.random().toString(36).slice(2, 10)}`,
      actionType: "comment",
      locator: null,
      value: text,
      timeout: 0,
      enabled: true,
      comment: text
    };
    state.recordedSteps.push(step);
    renderRecordedStepsTable();
  }
};

window.removeRecordedStep = function(stepId) {
  state.recordedSteps = state.recordedSteps.filter(s => s.stepId !== stepId);
  renderRecordedStepsTable();
};

window.clearRecordedSteps = function() {
  if (state.recordedSteps.length === 0) return;
  if (!confirm("Clear all recorded steps?")) return;
  state.recordedSteps = [];
  renderRecordedStepsTable();
};

window.saveCurrentWorkflowDraft = async function() {
  const nameInput = document.getElementById("workflowNameInput");
  const descInput = document.getElementById("workflowDescInput");
  const name = nameInput?.value?.trim();
  const description = descInput?.value?.trim() || "";

  if (!name) {
    alert("Please enter a Workflow Name before saving.");
    nameInput?.focus();
    return;
  }

  const payload = {
    name,
    description,
    steps: state.recordedSteps
  };

  try {
    let res;
    if (state.currentWorkflow?.id) {
      res = await fetch(`/api/workflows/${state.currentWorkflow.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    } else {
      res = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    }

    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    state.currentWorkflow = data.workflow;
    showRecorderFeedback(`Workflow draft "${data.workflow.name}" saved successfully (v${data.workflow.version})!`, "success");
    await loadWorkflowsList();
    document.getElementById("workflowTemplateSelect").value = data.workflow.id;
  } catch (err) {
    showRecorderFeedback(`Failed to save workflow: ${err.message}`, "error");
  }
};

window.publishCurrentWorkflow = async function() {
  if (!state.currentWorkflow?.id) {
    alert("Please save this workflow as a draft before publishing.");
    return;
  }

  if (!confirm(`Publish workflow "${state.currentWorkflow.name}"? Published workflows become immutable versions.`)) {
    return;
  }

  try {
    const res = await fetch(`/api/workflows/${state.currentWorkflow.id}/publish`, {
      method: "POST"
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    state.currentWorkflow = data.workflow;
    showRecorderFeedback(`✓ Workflow published successfully! Version ${data.workflow.version} is now immutable.`, "success");
    await loadWorkflowsList();
  } catch (err) {
    showRecorderFeedback(`Failed to publish workflow: ${err.message}`, "error");
  }
};

// Step Reordering & Manipulation
window.moveStep = function(index, direction) {
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= state.recordedSteps.length) return;
  const temp = state.recordedSteps[index];
  state.recordedSteps[index] = state.recordedSteps[targetIndex];
  state.recordedSteps[targetIndex] = temp;
  // Reassign sequence numbers
  state.recordedSteps.forEach((s, idx) => { s.sequence = idx + 1; });
  renderRecordedStepsTable();
};

window.duplicateStep = function(stepId) {
  const index = state.recordedSteps.findIndex(s => s.stepId === stepId);
  if (index === -1) return;
  const original = state.recordedSteps[index];
  const duplicate = JSON.parse(JSON.stringify(original));
  duplicate.stepId = `step_${Math.random().toString(36).slice(2, 10)}`;
  duplicate.comment = original.comment ? `${original.comment} (Copy)` : "Duplicated step";
  state.recordedSteps.splice(index + 1, 0, duplicate);
  state.recordedSteps.forEach((s, idx) => { s.sequence = idx + 1; });
  renderRecordedStepsTable();
  showRecorderFeedback(`Duplicated step #${index + 1}`, "info");
};

window.toggleStepEnabled = function(stepId, isEnabled) {
  const step = state.recordedSteps.find(s => s.stepId === stepId);
  if (!step) return;
  step.enabled = Boolean(isEnabled);
  renderRecordedStepsTable();
};

// Step Editor Modal
window.openStepEditModal = function(stepId) {
  const modal = document.getElementById("stepEditModal");
  if (!modal) return;

  const isNew = !stepId;
  const title = document.getElementById("stepEditModalTitle");
  if (title) title.textContent = isNew ? "Create New Workflow Step" : "Configure Workflow Step";

  const step = isNew
    ? {
        stepId: `step_${Math.random().toString(36).slice(2, 10)}`,
        actionType: "click",
        locator: { primary: "", testId: "", role: "", accessibleName: "" },
        value: "",
        timeout: 5000,
        enabled: true,
        comment: "",
        failurePolicy: "stop"
      }
    : state.recordedSteps.find(s => s.stepId === stepId);

  if (!step) return;

  document.getElementById("editStepId").value = step.stepId;
  document.getElementById("editActionType").value = step.actionType || "click";
  document.getElementById("editFailurePolicy").value = step.failurePolicy || "stop";
  
  const loc = step.locator || {};
  document.getElementById("editLocatorPrimary").value = loc.primary || loc.css || "";
  document.getElementById("editLocatorTestId").value = loc.testId || "";
  document.getElementById("editLocatorRole").value = loc.role || "";
  document.getElementById("editLocatorName").value = loc.accessibleName || "";

  document.getElementById("editStepValue").value = step.value !== null && step.value !== undefined ? String(step.value) : "";
  document.getElementById("editStepTimeout").value = step.timeout || 5000;
  document.getElementById("editStepComment").value = step.comment || "";
  document.getElementById("editStepEnabled").checked = step.enabled !== false;

  onActionTypeChange(step.actionType || "click");
  modal.style.display = "flex";
};

window.closeStepEditModal = function() {
  const modal = document.getElementById("stepEditModal");
  if (modal) modal.style.display = "none";
};

window.onActionTypeChange = function(actionType) {
  const locSection = document.getElementById("locatorConfigSection");
  const valSection = document.getElementById("valueConfigSection");
  const chips = document.getElementById("variableQuickChips");
  const lblValue = document.getElementById("lblStepValue");

  const requiresLocator = ["click", "dblclick", "type_text", "select_option", "verify"].includes(actionType);
  if (locSection) locSection.style.display = requiresLocator ? "block" : "none";

  if (actionType === "wait") {
    if (lblValue) lblValue.textContent = "Wait Duration (milliseconds)";
    if (chips) chips.style.display = "none";
  } else if (actionType === "navigate") {
    if (lblValue) lblValue.textContent = "URL to Navigate to";
    if (chips) chips.style.display = "flex";
  } else if (actionType === "press_key") {
    if (lblValue) lblValue.textContent = "Key Name (e.g. Enter, Tab, Escape, ArrowDown)";
    if (chips) chips.style.display = "none";
  } else if (actionType === "comment") {
    if (lblValue) lblValue.textContent = "Annotation Comment Text";
    if (chips) chips.style.display = "none";
  } else if (actionType === "verify") {
    if (lblValue) lblValue.textContent = "Expected Text or State (Optional)";
    if (chips) chips.style.display = "flex";
  } else {
    if (lblValue) lblValue.textContent = "Value / Text / Variable";
    if (chips) chips.style.display = "flex";
  }
};

window.insertVariableIntoValue = function(variableStr) {
  const valInput = document.getElementById("editStepValue");
  if (!valInput) return;
  const start = valInput.selectionStart || valInput.value.length;
  const end = valInput.selectionEnd || valInput.value.length;
  valInput.value = valInput.value.substring(0, start) + variableStr + valInput.value.substring(end);
  valInput.focus();
  valInput.setSelectionRange(start + variableStr.length, start + variableStr.length);
};

window.saveStepEditModal = function() {
  const stepId = document.getElementById("editStepId").value;
  const actionType = document.getElementById("editActionType").value;
  const failurePolicy = document.getElementById("editFailurePolicy").value;
  const primary = document.getElementById("editLocatorPrimary").value.trim();
  const testId = document.getElementById("editLocatorTestId").value.trim();
  const role = document.getElementById("editLocatorRole").value.trim();
  const accessibleName = document.getElementById("editLocatorName").value.trim();
  const rawValue = document.getElementById("editStepValue").value.trim();
  const timeout = parseInt(document.getElementById("editStepTimeout").value, 10) || 5000;
  const comment = document.getElementById("editStepComment").value.trim();
  const enabled = document.getElementById("editStepEnabled").checked;

  let locator = null;
  if (["click", "dblclick", "type_text", "select_option", "verify"].includes(actionType)) {
    locator = {
      primary: primary || (testId ? `[data-testid="${testId}"]` : null),
      testId: testId || null,
      role: role || null,
      accessibleName: accessibleName || null,
      css: primary || null
    };
  }

  let value = rawValue;
  if (actionType === "wait") {
    value = parseInt(rawValue, 10) || 1000;
  }

  const existingIndex = state.recordedSteps.findIndex(s => s.stepId === stepId);
  const updatedStep = {
    stepId,
    sequence: existingIndex >= 0 ? existingIndex + 1 : state.recordedSteps.length + 1,
    actionType,
    locator,
    value,
    timeout,
    enabled,
    comment,
    failurePolicy,
    isSensitive: false
  };

  if (existingIndex >= 0) {
    state.recordedSteps[existingIndex] = updatedStep;
  } else {
    state.recordedSteps.push(updatedStep);
  }

  closeStepEditModal();
  renderRecordedStepsTable();
  showRecorderFeedback(`Saved configuration for step (${actionType})`, "info");
};

// Pre-flight Validation
window.runPreflightValidation = async function() {
  const name = document.getElementById("workflowNameInput")?.value?.trim() || "Untitled Workflow";
  const banner = document.getElementById("workflowValidationBanner");
  const icon = document.getElementById("validationBannerIcon");
  const body = document.getElementById("validationBannerBody");

  if (!banner || !body) return;

  try {
    const res = await fetch("/api/workflows/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflow: {
          name,
          steps: state.recordedSteps
        }
      })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    banner.style.display = "flex";
    if (data.valid) {
      banner.className = "alert-banner success";
      if (icon) icon.textContent = "✓";
      const warnHtml = data.warnings.length > 0
        ? `<div style="margin-top:6px; font-size:0.8rem; color:#fde047;"><strong>Warnings (${data.warnings.length}):</strong><ul style="margin:4px 0 0 16px;">${data.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join("")}</ul></div>`
        : "";
      body.innerHTML = `<strong>Pre-flight Validation Passed:</strong> All ${data.enabledStepCount} enabled steps are structurally valid and safe to execute.${warnHtml}`;
    } else {
      banner.className = "alert-banner error";
      if (icon) icon.textContent = "✕";
      const errHtml = `<ul style="margin:6px 0 0 16px;">${data.errors.map(e => `<li>${escapeHtml(e)}</li>`).join("")}</ul>`;
      const warnHtml = data.warnings.length > 0
        ? `<div style="margin-top:6px; font-size:0.8rem; color:#fde047;"><strong>Warnings:</strong><ul style="margin:4px 0 0 16px;">${data.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join("")}</ul></div>`
        : "";
      body.innerHTML = `<strong>Pre-flight Validation Failed (${data.errors.length} errors):</strong>${errHtml}${warnHtml}`;
    }
  } catch (err) {
    banner.style.display = "flex";
    banner.className = "alert-banner error";
    if (icon) icon.textContent = "✕";
    body.innerHTML = `<strong>Validation Error:</strong> ${escapeHtml(err.message)}`;
  }
};

// Single Item Test Execution Modal & Trigger
window.openTestExecutionModal = function() {
  if (state.recordedSteps.length === 0) {
    alert("Please record or add at least one step before running a test execution.");
    return;
  }
  const modal = document.getElementById("testExecutionModal");
  if (modal) modal.style.display = "flex";
};

window.closeTestExecutionModal = function() {
  const modal = document.getElementById("testExecutionModal");
  if (modal) modal.style.display = "none";
};

window.startSingleItemTestExecution = async function() {
  const btn = document.getElementById("btnExecuteTestItem");
  const fb = document.getElementById("testExecutionFeedback");
  const reelUrl = document.getElementById("testReelUrl")?.value?.trim();
  const creatorName = document.getElementById("testCreatorName")?.value?.trim();
  const clipId = document.getElementById("testClipId")?.value?.trim();
  const takeDiagnostics = document.getElementById("testTakeDiagnostics")?.checked;

  if (!state.agentOnline) {
    if (fb) {
      fb.className = "test-feedback error";
      fb.textContent = "Local Desktop Agent is offline. Please launch agent first.";
    }
    return;
  }

  btn.disabled = true;
  btn.textContent = "Executing Test Step...";
  if (fb) {
    fb.className = "test-feedback info";
    fb.textContent = "Running pre-flight checks and launching browser test session...";
  }

  const browserConfig = getBrowserConfig();
  const workflow = {
    name: document.getElementById("workflowNameInput")?.value?.trim() || "Test Workflow",
    steps: state.recordedSteps,
    settings: {
      screenshotOnFailure: Boolean(takeDiagnostics)
    }
  };

  const clipData = {
    reel_url: reelUrl,
    instagramLink: reelUrl,
    creator_name: creatorName,
    creator: creatorName,
    clip_id: clipId,
    id: clipId,
    campaign_name: "TestCampaign",
    submission_type: "workflow"
  };

  try {
    const res = await fetch("/api/workflows/test-execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflow,
        clipData,
        browserConfig
      })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    if (fb) {
      fb.className = "test-feedback success";
      fb.textContent = `✓ Test execution completed successfully! Total steps: ${data.result?.totalSteps || state.recordedSteps.length}.`;
    }
    showRecorderFeedback("✓ Single-item workflow test run completed successfully!", "success");
  } catch (err) {
    if (fb) {
      fb.className = "test-feedback error";
      fb.textContent = `Test execution failed: ${err.message}`;
    }
    showRecorderFeedback(`Test execution failed: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Start Test Execution";
  }
};

// ==========================================
// BATCH WORKFLOW QUEUE UI LOGIC
// ==========================================

state.activeBatchJob = null;

window.openBatchExecutionModal = function() {
  if (state.recordedSteps.length === 0) {
    alert("Please record or create workflow steps before running a batch.");
    return;
  }
  const modal = document.getElementById("batchExecutionModal");
  const title = document.getElementById("batchWorkflowTitle");
  const wfName = document.getElementById("workflowNameInput")?.value?.trim() || "Active Workflow";
  if (title) title.textContent = wfName;
  if (modal) modal.style.display = "flex";
};

window.closeBatchExecutionModal = function() {
  const modal = document.getElementById("batchExecutionModal");
  if (modal) modal.style.display = "none";
};

window.loadSampleBatchQueue = function() {
  const sample = [
    { reel_url: "https://instagram.com/reel/sample_test_01", creator_name: "AlphaCreator", clip_id: "CLIP_SAMPLE_01" },
    { reel_url: "https://instagram.com/reel/sample_test_02", creator_name: "BetaCreator", clip_id: "CLIP_SAMPLE_02" },
    { reel_url: "https://instagram.com/reel/sample_test_03", creator_name: "GammaCreator", clip_id: "CLIP_SAMPLE_03" }
  ];
  const textarea = document.getElementById("batchItemsTextarea");
  if (textarea) textarea.value = JSON.stringify(sample, null, 2);
};

window.renderBatchQueueTable = function(batchJob) {
  if (!batchJob) return;
  const tbody = document.getElementById("batchQueueTableBody");
  const badge = document.getElementById("batchJobStatusBadge");
  const countTotal = document.getElementById("batchCountTotal");
  const countSuccess = document.getElementById("batchCountSuccess");
  const countFailed = document.getElementById("batchCountFailed");
  const countSkipped = document.getElementById("batchCountSkipped");
  const countUnknown = document.getElementById("batchCountUnknown");
  const countCancelled = document.getElementById("batchCountCancelled");

  if (badge) {
    badge.className = `badge badge-${batchJob.status}`;
    badge.textContent = batchJob.status;
  }

  const s = batchJob.summary || {};
  if (countTotal) countTotal.textContent = batchJob.items?.length || 0;
  if (countSuccess) countSuccess.textContent = s.success || 0;
  if (countFailed) countFailed.textContent = s.failed || 0;
  if (countSkipped) countSkipped.textContent = s.skipped || 0;
  if (countUnknown) countUnknown.textContent = s.unknown || 0;
  if (countCancelled) countCancelled.textContent = s.cancelled || 0;

  if (!tbody) return;
  const items = batchJob.items || [];
  if (items.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">No items in queue.</td></tr>`;
    return;
  }

  tbody.innerHTML = items.map((item, idx) => {
    let statusClass = "badge-QUEUED";
    if (item.status === "RUNNING") statusClass = "badge-PROCESSING";
    if (item.status === "SUCCESS") statusClass = "badge-SUCCESS";
    if (item.status === "FAILED") statusClass = "badge-FAILED";
    if (item.status === "SKIPPED") statusClass = "badge-SKIPPED";
    if (item.status === "UNKNOWN") statusClass = "badge-UNCERTAIN";
    if (item.status === "CANCELLED") statusClass = "badge-FAILED";

    const reason = item.uncertainReason || item.failureReason || (item.status === "SUCCESS" ? "✓ Verified" : "--");

    return `
      <tr>
        <td><strong>${idx + 1}</strong></td>
        <td class="font-mono text-sm" style="color:#38bdf8; word-break:break-all;">
          ${escapeHtml(item.reel_url || item.id)}
        </td>
        <td style="color:#a5b4fc; font-size:0.85rem;">
          ${escapeHtml(item.creator_name || "--")}
        </td>
        <td>
          <span class="badge ${statusClass}">${item.status}</span>
        </td>
        <td style="text-align:center; color:var(--text-muted); font-size:0.85rem;">
          ${item.attempts || 0}
        </td>
        <td style="font-size:0.8rem; color:${item.status === 'FAILED' ? '#f87171' : (item.status === 'UNKNOWN' ? '#facc15' : 'var(--text-muted)')};">
          ${escapeHtml(reason)}
        </td>
      </tr>
    `;
  }).join("");
};

window.startBatchWorkflowExecution = async function() {
  const fb = document.getElementById("batchFeedback");
  const rawInput = document.getElementById("batchItemsTextarea")?.value?.trim();
  const stopOnFail = document.getElementById("chkStopOnFirstFailure")?.checked;
  const btnStart = document.getElementById("btnStartBatch");
  const btnPause = document.getElementById("btnPauseBatch");
  const btnCancel = document.getElementById("btnCancelBatch");

  if (!rawInput) {
    alert("Please enter at least one clip URL or JSON array of items.");
    return;
  }

  let items = [];
  try {
    if (rawInput.startsWith("[")) {
      items = JSON.parse(rawInput);
    } else {
      items = rawInput.split("\n").map(l => l.trim()).filter(Boolean).map(url => ({
        reel_url: url,
        creator_name: "BatchItem"
      }));
    }
  } catch (err) {
    alert("Could not parse items as JSON array. Please check format.");
    return;
  }

  if (items.length === 0) {
    alert("No valid items parsed.");
    return;
  }

  const workflow = {
    name: document.getElementById("workflowNameInput")?.value?.trim() || "Batch Workflow",
    steps: state.recordedSteps
  };

  const browserConfig = getBrowserConfig();

  btnStart.disabled = true;
  btnStart.textContent = "Validating...";
  if (fb) {
    fb.className = "test-feedback info";
    fb.textContent = "Validating entire workflow and initializing batch queue...";
  }

  try {
    const res = await fetch("/api/workflows/batch/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflow,
        items,
        browserConfig,
        settings: {
          stopOnFirstFailure: Boolean(stopOnFail)
        }
      })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    state.activeBatchJob = data.batchJob;
    renderBatchQueueTable(data.batchJob);

    btnStart.style.display = "none";
    if (btnPause) btnPause.style.display = "inline-flex";
    if (btnCancel) btnCancel.style.display = "inline-flex";

    if (fb) {
      fb.className = "test-feedback success";
      fb.textContent = `Batch execution started (#${data.batchJob.id}). Processing ${data.batchJob.items.length} items.`;
    }
  } catch (err) {
    btnStart.disabled = false;
    btnStart.textContent = "▶ Run Batch";
    if (fb) {
      fb.className = "test-feedback error";
      fb.textContent = `Batch start failed: ${err.message}`;
    }
  }
};

window.pauseBatchWorkflowExecution = async function() {
  if (!state.activeBatchJob) return;
  try {
    await fetch(`/api/workflows/batch/jobs/${state.activeBatchJob.id}/pause`, { method: "POST" });
    const btnPause = document.getElementById("btnPauseBatch");
    const btnResume = document.getElementById("btnResumeBatch");
    if (btnPause) btnPause.style.display = "none";
    if (btnResume) btnResume.style.display = "inline-flex";
  } catch (err) {
    console.error("Pause error:", err);
  }
};

window.resumeBatchWorkflowExecution = async function() {
  if (!state.activeBatchJob) return;
  try {
    await fetch(`/api/workflows/batch/jobs/${state.activeBatchJob.id}/resume`, { method: "POST" });
    const btnPause = document.getElementById("btnPauseBatch");
    const btnResume = document.getElementById("btnResumeBatch");
    if (btnResume) btnResume.style.display = "none";
    if (btnPause) btnPause.style.display = "inline-flex";
  } catch (err) {
    console.error("Resume error:", err);
  }
};

window.cancelBatchWorkflowExecution = async function() {
  if (!state.activeBatchJob) return;
  if (!confirm("Are you sure you want to cancel the entire batch?")) return;
  try {
    await fetch(`/api/jobs/${state.activeBatchJob.id}/cancel`, { method: "POST" });
    const btnPause = document.getElementById("btnPauseBatch");
    const btnResume = document.getElementById("btnResumeBatch");
    const btnCancel = document.getElementById("btnCancelBatch");
    const btnStart = document.getElementById("btnStartBatch");
    if (btnPause) btnPause.style.display = "none";
    if (btnResume) btnResume.style.display = "none";
    if (btnCancel) btnCancel.style.display = "none";
    if (btnStart) {
      btnStart.style.display = "inline-flex";
      btnStart.disabled = false;
      btnStart.textContent = "▶ Run Batch";
    }
  } catch (err) {
    console.error("Cancel error:", err);
  }
};



