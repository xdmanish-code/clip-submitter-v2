import crypto from "crypto";
import EventEmitter from "events";

export const RecorderState = {
  IDLE: "IDLE",
  STARTING: "STARTING",
  RECORDING: "RECORDING",
  PAUSED: "PAUSED",
  STOPPING: "STOPPING",
  STOPPED: "STOPPED",
  FAILED: "FAILED"
};

/**
 * Checks whether an element or input is sensitive (passwords, tokens, keys).
 */
export function isSensitiveField(elementData = {}) {
  const { type = "", name = "", id = "", autocomplete = "", placeholder = "", label = "" } = elementData;

  if (type.toLowerCase() === "password") return true;
  if (/current-password|new-password/i.test(autocomplete)) return true;

  const sensitivePattern = /(password|passwd|secret|token|api[_-]?key|auth|bearer|credit|cvv|ssn)/i;
  return (
    sensitivePattern.test(name) ||
    sensitivePattern.test(id) ||
    sensitivePattern.test(placeholder) ||
    sensitivePattern.test(label)
  );
}

/**
 * Injected script into browser pages to listen to user interactions.
 */
export const BROWSER_RECORDER_INJECTION = `
(function() {
  if (window.__clipSubmitterRecorderInjected) return;
  window.__clipSubmitterRecorderInjected = true;
  window.__clipSubmitterRecordingEnabled = true;

  // Sensitive check helper
  function checkIsSensitive(el) {
    if (!el) return false;
    const type = (el.type || '').toLowerCase();
    if (type === 'password') return true;
    const auto = (el.autocomplete || '').toLowerCase();
    if (auto.includes('password')) return true;

    const pattern = /(password|passwd|secret|token|api[_-]?key|auth|bearer|credit|cvv|ssn)/i;
    const name = el.getAttribute('name') || '';
    const id = el.getAttribute('id') || '';
    const placeholder = el.getAttribute('placeholder') || '';
    const ariaLabel = el.getAttribute('aria-label') || '';
    return pattern.test(name) || pattern.test(id) || pattern.test(placeholder) || pattern.test(ariaLabel);
  }

  // Generates robust multi-tier locator metadata
  function extractElementMetadata(el) {
    if (!el || el === document.body || el === document.documentElement) return null;

    // Accessible role
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    const ariaLabel = el.getAttribute('aria-label') || '';
    const textContent = (el.innerText || el.textContent || '').trim().slice(0, 80);
    const accessibleName = ariaLabel || textContent || el.getAttribute('title') || el.getAttribute('alt') || '';

    // Attributes
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-qa') || '';
    const rawId = el.getAttribute('id') || '';
    // Avoid dynamic generated IDs like ember123, :r1:, input-4938
    const isDynamicId = /(:|\\d{4,}|[a-f0-9]{8,}|ember)/i.test(rawId);
    const stableId = (!isDynamicId && rawId) ? rawId : '';
    const name = el.getAttribute('name') || '';
    const tagName = el.tagName.toLowerCase();

    // CSS Selector
    let cssSelector = '';
    if (testId) {
      cssSelector = '[data-testid="' + testId + '"]';
    } else if (stableId) {
      cssSelector = '#' + CSS.escape(stableId);
    } else if (name) {
      cssSelector = tagName + '[name="' + CSS.escape(name) + '"]';
    } else {
      // Build safe tag + classes (omitting dynamic tailwind hashes or weird classes)
      const classes = Array.from(el.classList || [])
        .filter(c => !/(\\d{3,}|[a-f0-9]{6,}|css-|jsx-)/i.test(c))
        .slice(0, 2);
      cssSelector = tagName + (classes.length ? '.' + classes.map(c => CSS.escape(c)).join('.') : '');
    }

    const rect = el.getBoundingClientRect();
    const coordinates = {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2)
    };

    return {
      tagName,
      role,
      accessibleName: accessibleName.slice(0, 60),
      testId,
      id: stableId,
      name,
      cssSelector,
      text: textContent.slice(0, 60),
      isSensitive: checkIsSensitive(el),
      coordinates
    };
  }

  // Ignore clicks inside dashboard or recorder UI if embedded
  function isRecorderUi(el) {
    return el && el.closest && Boolean(el.closest('#clip-submitter-recorder-ui, .clip-submitter-internal'));
  }

  // 1. Click & Double Click listener
  let lastClickTime = 0;
  let lastClickTarget = null;

  document.addEventListener('click', function(e) {
    if (!window.__clipSubmitterRecordingEnabled) return;
    const target = e.target;
    if (isRecorderUi(target)) return;

    const meta = extractElementMetadata(target);
    if (!meta) return;

    const now = Date.now();
    const isDbl = (now - lastClickTime < 350 && lastClickTarget === target);
    lastClickTime = now;
    lastClickTarget = target;

    if (isDbl) {
      if (typeof window.__clipSubmitterRecordAction === 'function') {
        window.__clipSubmitterRecordAction({
          actionType: 'dblclick',
          target: meta
        });
      }
    } else {
      if (typeof window.__clipSubmitterRecordAction === 'function') {
        window.__clipSubmitterRecordAction({
          actionType: 'click',
          target: meta
        });
      }
    }
  }, true);

  // 2. Input / Change listener (for typing and dropdown selects)
  let inputDebounceTimer = null;

  document.addEventListener('input', function(e) {
    if (!window.__clipSubmitterRecordingEnabled) return;
    const target = e.target;
    if (isRecorderUi(target)) return;

    const tagName = target.tagName.toLowerCase();
    if (tagName !== 'input' && tagName !== 'textarea' && !target.isContentEditable) return;

    clearTimeout(inputDebounceTimer);
    inputDebounceTimer = setTimeout(() => {
      const meta = extractElementMetadata(target);
      if (!meta) return;

      const isSens = meta.isSensitive || checkIsSensitive(target);
      const rawValue = target.isContentEditable ? target.innerText : target.value;
      const value = isSens ? '[REDACTED_SENSITIVE]' : rawValue;

      if (typeof window.__clipSubmitterRecordAction === 'function') {
        window.__clipSubmitterRecordAction({
          actionType: 'type_text',
          target: meta,
          value: value,
          isSensitive: isSens
        });
      }
    }, 500);
  }, true);

  // Immediate commit on change / blur for inputs and selects
  document.addEventListener('change', function(e) {
    if (!window.__clipSubmitterRecordingEnabled) return;
    const target = e.target;
    if (isRecorderUi(target)) return;

    const tagName = target.tagName.toLowerCase();
    if (tagName === 'input' || tagName === 'textarea') {
      clearTimeout(inputDebounceTimer);
      const meta = extractElementMetadata(target);
      if (!meta) return;

      const isSens = meta.isSensitive || checkIsSensitive(target);
      const rawValue = target.value;
      const value = isSens ? '[REDACTED_SENSITIVE]' : rawValue;

      if (typeof window.__clipSubmitterRecordAction === 'function') {
        window.__clipSubmitterRecordAction({
          actionType: 'type_text',
          target: meta,
          value: value,
          isSensitive: isSens
        });
      }
    } else if (tagName === 'select') {
      const meta = extractElementMetadata(target);
      if (!meta) return;

      const selectedOption = target.options[target.selectedIndex];
      const value = selectedOption ? selectedOption.value || selectedOption.text : target.value;

      if (typeof window.__clipSubmitterRecordAction === 'function') {
        window.__clipSubmitterRecordAction({
          actionType: 'select_option',
          target: meta,
          value: value
        });
      }
    }
  }, true);

  // 4. Special Keydowns (Enter, Tab)
  document.addEventListener('keydown', function(e) {
    if (!window.__clipSubmitterRecordingEnabled) return;
    const key = e.key;
    if (key !== 'Enter' && key !== 'Tab') return;

    const target = e.target;
    if (isRecorderUi(target)) return;

    const meta = extractElementMetadata(target);
    if (typeof window.__clipSubmitterRecordAction === 'function') {
      window.__clipSubmitterRecordAction({
        actionType: 'press_key',
        target: meta,
        value: key
      });
    }
  }, true);

})();
`;

export class RecorderEngine extends EventEmitter {
  constructor(browserManager) {
    super();
    this.browserManager = browserManager;
    this.state = RecorderState.IDLE;
    this.currentSession = null;
    this.sequenceNumber = 0;
    this.activePage = null;
    this.boundPages = new Set();
    this.eventDeduplicationWindow = 400;
    this.lastRecordedSignature = null;
    this.lastRecordedTimestamp = 0;
  }

  getState() {
    return {
      state: this.state,
      session: this.currentSession ? {
        sessionId: this.currentSession.sessionId,
        startedAt: this.currentSession.startedAt,
        stepsCount: this.currentSession.steps.length
      } : null
    };
  }

  /**
   * Starts a new recording session on the designated browser context.
   */
  async startRecording({ browserConfig = {}, permittedDomains = [] } = {}) {
    if (this.state === RecorderState.RECORDING || this.state === RecorderState.STARTING) {
      throw new Error(`Recorder is already active in state ${this.state}.`);
    }

    this.state = RecorderState.STARTING;
    this.emit("state_changed", this.state);

    try {
      // 1. Obtain context from existing browser manager
      const context = await this.browserManager.getContext(browserConfig);
      if (!context) {
        throw new Error("Designated browser context is unavailable.");
      }

      // 2. Identify or create valid target page
      let pages = context.pages();
      // Exclude dashboard page if inside same context
      let targetPage = pages.find(p => {
        try {
          const url = p.url();
          return !url.includes("localhost:4000") && !url.includes("127.0.0.1:4000");
        } catch {
          return true;
        }
      });

      if (!targetPage) {
        targetPage = pages[0] || (await context.newPage());
      }

      this.activePage = targetPage;
      const sessionId = `rec_${crypto.randomUUID().slice(0, 10)}`;
      this.currentSession = {
        sessionId,
        browserConfig,
        permittedDomains: Array.isArray(permittedDomains) ? permittedDomains : [],
        startedAt: new Date().toISOString(),
        steps: []
      };
      this.sequenceNumber = 0;

      // 3. Inject bindings into context and current page
      await this.bindPage(targetPage);

      // Listen for new pages / tabs opened during recording
      context.on("page", (newPage) => {
        if (this.state === RecorderState.RECORDING || this.state === RecorderState.PAUSED) {
          this.bindPage(newPage).catch(() => {});
        }
      });

      // Listen for browser context disconnect / close
      context.on("close", () => {
        if (this.state === RecorderState.RECORDING || this.state === RecorderState.PAUSED) {
          this.state = RecorderState.IDLE;
          this.currentSession = null;
          this.boundPages.clear();
          this.emit("state_changed", this.state);
          this.emit("recording_error", { error: "Browser session disconnected." });
        }
      });

      this.state = RecorderState.RECORDING;
      this.emit("state_changed", this.state);

      const startEvent = {
        sessionId,
        eventId: `ev_${crypto.randomUUID().slice(0, 8)}`,
        timestamp: new Date().toISOString(),
        status: "RECORDING",
        pageUrl: targetPage.url()
      };
      this.emit("recording_started", startEvent);
      return startEvent;
    } catch (err) {
      this.state = RecorderState.FAILED;
      this.emit("state_changed", this.state);
      this.emit("recording_error", { error: err.message });
      throw err;
    }
  }

  /**
   * Binds interaction listener to a page.
   */
  async bindPage(page) {
    if (!page || this.boundPages.has(page)) return;
    this.boundPages.add(page);

    try {
      // Expose interaction callback to page if not already exposed
      await page.exposeFunction("__clipSubmitterRecordAction", (actionData) => {
        this.handleRawAction(actionData, page);
      }).catch(() => {
        // Function may already be exposed in this context
      });

      // Inject on current page
      await page.evaluate(BROWSER_RECORDER_INJECTION).catch(() => {});

      // Add init script so page reloads or navigations keep recording
      await page.addInitScript(BROWSER_RECORDER_INJECTION).catch(() => {});

      // Track URL navigation
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame() && this.state === RecorderState.RECORDING) {
          this.handleNavigation(frame.url());
        }
      });

      page.on("close", () => {
        this.boundPages.delete(page);
        if (page === this.activePage || this.boundPages.size === 0) {
          if (this.state === RecorderState.RECORDING || this.state === RecorderState.PAUSED) {
            this.state = RecorderState.IDLE;
            this.emit("state_changed", this.state);
            this.emit("recording_error", { error: "Target browser window or tab was closed." });
          }
        }
      });
    } catch (err) {
      console.warn("[RecorderEngine] Failed to bind page:", err.message);
    }
  }

  /**
   * Pauses action capture without destroying session.
   */
  async pauseRecording() {
    if (this.state !== RecorderState.RECORDING) {
      throw new Error(`Cannot pause recorder in state ${this.state}.`);
    }

    this.state = RecorderState.PAUSED;
    this.emit("state_changed", this.state);

    // Disable capture in pages
    for (const page of this.boundPages) {
      try {
        await page.evaluate(() => { window.__clipSubmitterRecordingEnabled = false; });
      } catch {}
    }

    const event = {
      sessionId: this.currentSession?.sessionId,
      eventId: `ev_${crypto.randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      status: "PAUSED"
    };
    this.emit("recording_paused", event);
    return event;
  }

  /**
   * Resumes paused recording session.
   */
  async resumeRecording() {
    if (this.state !== RecorderState.PAUSED) {
      throw new Error(`Cannot resume recorder in state ${this.state}.`);
    }

    this.state = RecorderState.RECORDING;
    this.emit("state_changed", this.state);

    // Re-enable capture in pages
    for (const page of this.boundPages) {
      try {
        await page.evaluate(() => { window.__clipSubmitterRecordingEnabled = true; });
      } catch {}
    }

    const event = {
      sessionId: this.currentSession?.sessionId,
      eventId: `ev_${crypto.randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      status: "RECORDING"
    };
    this.emit("recording_resumed", event);
    return event;
  }

  /**
   * Stops recording and cleans up resources.
   */
  async stopRecording() {
    if (this.state === RecorderState.IDLE || this.state === RecorderState.STOPPED) {
      return { sessionId: this.currentSession?.sessionId, status: "STOPPED", steps: [] };
    }

    this.state = RecorderState.STOPPING;
    this.emit("state_changed", this.state);

    // Disable listeners on all bound pages
    for (const page of this.boundPages) {
      try {
        await page.evaluate(() => {
          window.__clipSubmitterRecordingEnabled = false;
        });
      } catch {}
    }

    const sessionResult = {
      sessionId: this.currentSession?.sessionId,
      status: "STOPPED",
      steps: [...(this.currentSession?.steps || [])],
      stoppedAt: new Date().toISOString()
    };

    this.state = RecorderState.STOPPED;
    this.emit("state_changed", this.state);

    const event = {
      sessionId: sessionResult.sessionId,
      eventId: `ev_${crypto.randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      status: "STOPPED",
      stepsCount: sessionResult.steps.length,
      steps: sessionResult.steps
    };
    this.emit("recording_stopped", event);

    // Reset session reference
    this.currentSession = null;
    this.boundPages.clear();
    this.state = RecorderState.IDLE;
    this.emit("state_changed", this.state);

    return sessionResult;
  }

  /**
   * Constructs locator object from candidate hierarchy.
   */
  buildLocator(target) {
    if (!target) return null;

    let primary = "";
    if (target.testId) {
      primary = `[data-testid="${target.testId}"]`;
    } else if (target.role && target.accessibleName) {
      primary = `role="${target.role}"[name="${target.accessibleName}"]`;
    } else if (target.id) {
      primary = `#${target.id}`;
    } else if (target.cssSelector) {
      primary = target.cssSelector;
    } else if (target.text) {
      primary = `text="${target.text}"`;
    }

    return {
      primary,
      role: target.role || null,
      accessibleName: target.accessibleName || null,
      testId: target.testId || null,
      id: target.id || null,
      name: target.name || null,
      css: target.cssSelector || null,
      text: target.text || null,
      fallbackCoordinates: target.coordinates || null
    };
  }

  /**
   * Processes raw action sent from injected page script.
   */
  handleRawAction(rawAction, page = null) {
    if (this.state !== RecorderState.RECORDING) return;
    if (!rawAction || !rawAction.actionType) return;

    const now = Date.now();
    const actionType = rawAction.actionType;
    const target = rawAction.target || {};

    // Deduplication check
    const signature = `${actionType}:${target.testId || target.id || target.cssSelector || target.text}:${rawAction.value || ''}`;
    if (this.lastRecordedSignature === signature && (now - this.lastRecordedTimestamp) < this.eventDeduplicationWindow) {
      return; // Skip duplicate
    }
    this.lastRecordedSignature = signature;
    this.lastRecordedTimestamp = now;

    // Check sensitivity
    const isSensitive = rawAction.isSensitive || isSensitiveField(target);
    const value = isSensitive ? "[REDACTED_SENSITIVE]" : (rawAction.value !== undefined ? rawAction.value : null);

    this.sequenceNumber += 1;
    const stepId = `step_${crypto.randomUUID().slice(0, 8)}`;

    const step = {
      stepId,
      sequence: this.sequenceNumber,
      actionType,
      locator: this.buildLocator(target),
      value,
      timeout: 5000,
      enabled: true,
      comment: isSensitive ? "Sensitive field (value redacted)" : "",
      failurePolicy: "stop",
      isSensitive
    };

    if (this.currentSession) {
      this.currentSession.steps.push(step);
    }

    const event = {
      sessionId: this.currentSession?.sessionId,
      eventId: `ev_${crypto.randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      sequence: this.sequenceNumber,
      step
    };

    this.emit("recorded_step", event);
  }

  /**
   * Records page navigation if inside permitted domain rules.
   */
  handleNavigation(url) {
    if (!url || url.startsWith("about:") || url.startsWith("chrome:")) return;

    // If permitted domains configured, check domain
    if (this.currentSession?.permittedDomains?.length > 0) {
      try {
        const parsed = new URL(url);
        const allowed = this.currentSession.permittedDomains.some(d => parsed.hostname.includes(d));
        if (!allowed) {
          console.warn(`[RecorderEngine] Ignored navigation to non-permitted domain: ${url}`);
          return;
        }
      } catch {
        return;
      }
    }

    this.sequenceNumber += 1;
    const step = {
      stepId: `step_${crypto.randomUUID().slice(0, 8)}`,
      sequence: this.sequenceNumber,
      actionType: "navigate",
      locator: null,
      value: url,
      timeout: 15000,
      enabled: true,
      comment: `Navigate to ${url}`,
      failurePolicy: "stop",
      isSensitive: false
    };

    if (this.currentSession) {
      this.currentSession.steps.push(step);
    }

    this.emit("recorded_step", {
      sessionId: this.currentSession?.sessionId,
      eventId: `ev_${crypto.randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      sequence: this.sequenceNumber,
      step
    });
  }

  /**
   * Allows manually adding a wait step into the active recording.
   */
  addWaitStep(durationMs = 5000, comment = "Wait duration") {
    if (!this.currentSession) throw new Error("No active recording session.");
    this.sequenceNumber += 1;

    const step = {
      stepId: `step_${crypto.randomUUID().slice(0, 8)}`,
      sequence: this.sequenceNumber,
      actionType: "wait",
      locator: null,
      value: Number(durationMs) || 5000,
      timeout: Number(durationMs) || 5000,
      enabled: true,
      comment: comment || `Wait ${durationMs / 1000}s`,
      failurePolicy: "stop",
      isSensitive: false
    };

    this.currentSession.steps.push(step);
    const event = {
      sessionId: this.currentSession.sessionId,
      eventId: `ev_${crypto.randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      sequence: this.sequenceNumber,
      step
    };
    this.emit("recorded_step", event);
    return step;
  }

  /**
   * Allows manually adding a comment step into the active recording.
   */
  addCommentStep(text = "") {
    if (!this.currentSession) throw new Error("No active recording session.");
    this.sequenceNumber += 1;

    const step = {
      stepId: `step_${crypto.randomUUID().slice(0, 8)}`,
      sequence: this.sequenceNumber,
      actionType: "comment",
      locator: null,
      value: text,
      timeout: 0,
      enabled: true,
      comment: text,
      failurePolicy: "continue",
      isSensitive: false
    };

    this.currentSession.steps.push(step);
    const event = {
      sessionId: this.currentSession.sessionId,
      eventId: `ev_${crypto.randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      sequence: this.sequenceNumber,
      step
    };
    this.emit("recorded_step", event);
    return step;
  }
}
