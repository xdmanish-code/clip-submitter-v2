import { chromium } from "playwright";
import path from "path";
import os from "os";
import fs from "fs";
import { getStandardBrowserPaths } from "./browser-discovery.js";

export class BrowserManager {
  constructor() {
    this.activeContext = null;
    this.activeBrowser = null;
    this.isPersistentLaunch = false;
  }

  /**
   * Returns default user data directory for dedicated profiles.
   */
  getDefaultProfileDir(profileName = "default") {
    const baseDir = process.env["LOCALAPPDATA"]
      ? path.join(process.env["LOCALAPPDATA"], "ClipSubmitterProfiles")
      : path.join(os.homedir(), ".clip-submitter", "profiles");

    const profileDir = path.join(baseDir, profileName);
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }
    return profileDir;
  }

  /**
   * Connects to an existing browser instance running with remote debugging (CDP).
   */
  async connectExistingProfile({ port = 9222, host = "127.0.0.1" }) {
    const cdpUrl = `http://${host}:${port}`;
    try {
      const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 8000 });
      const context = browser.contexts()[0];
      if (!context) {
        throw new Error(`Connected to CDP at ${cdpUrl} but no browser context was found.`);
      }
      this.activeBrowser = browser;
      this.activeContext = context;
      this.isPersistentLaunch = false;

      // Safe dialog handler
      context.on("page", (p) => {
        p.on("dialog", (d) => d.dismiss().catch(() => {}));
      });
      for (const p of context.pages()) {
        p.on("dialog", (d) => d.dismiss().catch(() => {}));
      }

      return { browser, context, cdpUrl };
    } catch (err) {
      throw new Error(
        `Failed to connect to browser on ${cdpUrl}. Ensure Chrome/Chromium is running with --remote-debugging-port=${port}. Details: ${err.message}`
      );
    }
  }

  /**
   * Launches a new dedicated Chromium profile.
   */
  async launchNewChromium({
    profileName = "profile-1",
    profileDir = null,
    headless = false,
    executablePath = null
  }) {
    const targetDir = profileDir || this.getDefaultProfileDir(profileName);

    const launchOptions = {
      headless: Boolean(headless),
      viewport: null,
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-blink-features=AutomationControlled"
      ]
    };

    let execToUse = executablePath;
    if (!execToUse) {
      const standard = getStandardBrowserPaths();
      const candidates = [...standard.chrome, ...standard.edge, ...standard.brave];
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          execToUse = p;
          break;
        }
      }
    }

    if (execToUse) {
      launchOptions.executablePath = execToUse;
    }

    try {
      const context = await chromium.launchPersistentContext(targetDir, launchOptions);
      this.activeContext = context;
      this.activeBrowser = null;
      this.isPersistentLaunch = true;
      context.on("close", () => {
        if (this.activeContext === context) {
          this.activeContext = null;
        }
      });
      return { context, profileDir: targetDir };
    } catch (err) {
      throw new Error(`Failed to launch Chromium profile at ${targetDir}: ${err.message}`);
    }
  }

  /**
   * Obtains a context based on user configuration.
   */
  async getContext(config) {
    if (this.activeContext) {
      try {
        const pages = this.activeContext.pages();
        if (Array.isArray(pages)) {
          return this.activeContext;
        }
      } catch {
        this.activeContext = null;
      }
    }

    if (config.mode === "existing") {
      const { context } = await this.connectExistingProfile({
        port: config.port || 9222,
        host: config.host || "127.0.0.1"
      });
      return context;
    } else {
      const { context } = await this.launchNewChromium({
        profileName: config.profileName || "profile-1",
        profileDir: config.profileDir || null,
        headless: config.headless || false,
        executablePath: config.executablePath || null
      });
      return context;
    }
  }

  /**
   * Tests browser connection.
   */
  async testConnection(config) {
    if (config.mode === "existing") {
      const port = config.port || 9222;
      const host = config.host || "127.0.0.1";
      const cdpUrl = `http://${host}:${port}`;
      try {
        const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 5000 });
        const pages = browser.contexts()[0]?.pages() || [];
        await browser.close().catch(() => {});
        return {
          success: true,
          message: `Successfully connected to existing browser over CDP (${cdpUrl}). Found ${pages.length} active tab(s).`
        };
      } catch (err) {
        return {
          success: false,
          message: `Could not connect to browser on ${cdpUrl}. Check that the browser is open with --remote-debugging-port=${port}.`
        };
      }
    } else {
      // New profile test
      try {
        const targetDir = config.profileDir || this.getDefaultProfileDir("test-check");
        const options = {
          headless: true,
          args: ["--no-first-run", "--no-default-browser-check"]
        };
        let execToUse = config.executablePath;
        if (!execToUse) {
          const standard = getStandardBrowserPaths();
          const candidates = [...standard.chrome, ...standard.edge, ...standard.brave, ...standard.chromium];
          for (const p of candidates) {
            if (fs.existsSync(p)) {
              execToUse = p;
              break;
            }
          }
        }
        if (execToUse) {
          options.executablePath = execToUse;
        }
        const context = await chromium.launchPersistentContext(targetDir, options);
        await context.close().catch(() => {});
        return {
          success: true,
          message: `Browser executable verified and successfully launched dedicated profile.`
        };
      } catch (err) {
        return {
          success: false,
          message: `Failed to launch browser: ${err.message}`
        };
      }
    }
  }

  /**
   * Closes active browser / context if needed.
   */
  async cleanup() {
    try {
      if (this.isPersistentLaunch && this.activeContext) {
        // For persistent launch we don't necessarily kill it between jobs unless asked, but we can close it
      }
    } catch {
      // ignore
    }
  }
}
