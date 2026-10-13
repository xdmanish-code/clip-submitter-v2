import fs from "fs";
import path from "path";
import os from "os";

/**
 * Common browser executable locations across Windows, macOS, and Linux.
 */
export function getStandardBrowserPaths() {
  const isWindows = process.platform === "win32";
  const isMac = process.platform === "darwin";
  const isLinux = process.platform === "linux";

  const paths = {
    chrome: [],
    chromium: [],
    edge: [],
    brave: []
  };

  if (process.env.CHROME_PATH) {
    paths.chrome.unshift(process.env.CHROME_PATH);
  }
  if (process.env.BROWSER_PATH) {
    paths.chrome.unshift(process.env.BROWSER_PATH);
  }

  if (isWindows) {
    const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const localAppData = process.env["LOCALAPPDATA"] || path.join(os.homedir(), "AppData", "Local");

    paths.chrome.push(
      path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(os.homedir(), "scoop", "apps", "googlechrome", "current", "chrome.exe")
    );

    paths.edge.push(
      path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe")
    );

    paths.brave.push(
      path.join(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      path.join(programFilesX86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      path.join(localAppData, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      path.join(os.homedir(), "scoop", "apps", "brave", "current", "brave.exe")
    );

    paths.chromium.push(
      path.join(localAppData, "Chromium", "Application", "chrome.exe"),
      path.join(programFiles, "Chromium", "Application", "chrome.exe")
    );
  } else if (isMac) {
    const userApps = path.join(os.homedir(), "Applications");
    paths.chrome.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(userApps, "Google Chrome.app/Contents/MacOS/Google Chrome")
    );
    paths.edge.push(
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      path.join(userApps, "Microsoft Edge.app/Contents/MacOS/Microsoft Edge")
    );
    paths.brave.push(
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      path.join(userApps, "Brave Browser.app/Contents/MacOS/Brave Browser")
    );
    paths.chromium.push(
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      path.join(userApps, "Chromium.app/Contents/MacOS/Chromium")
    );
  } else if (isLinux) {
    paths.chrome.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome-unstable",
      "/usr/local/bin/chrome",
      "/snap/bin/google-chrome"
    );
    paths.edge.push(
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
      "/snap/bin/microsoft-edge"
    );
    paths.brave.push(
      "/usr/bin/brave-browser",
      "/snap/bin/brave",
      "/usr/bin/brave"
    );
    paths.chromium.push(
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
      "/usr/local/bin/chromium"
    );
  }

  return paths;
}

/**
 * Discovers available local browsers by checking standard filesystem paths.
 */
export async function discoverBrowsers() {
  const browserPaths = getStandardBrowserPaths();
  const detected = [];

  const checkCandidates = (name, type, candidates) => {
    for (const filePath of candidates) {
      try {
        if (fs.existsSync(filePath)) {
          return {
            name,
            type,
            executablePath: filePath,
            available: true
          };
        }
      } catch {
        // Continue checking
      }
    }
    return {
      name,
      type,
      executablePath: null,
      available: false
    };
  };

  detected.push(checkCandidates("Google Chrome", "chrome", browserPaths.chrome));
  detected.push(checkCandidates("Microsoft Edge", "edge", browserPaths.edge));
  detected.push(checkCandidates("Brave Browser", "brave", browserPaths.brave));
  detected.push(checkCandidates("Chromium", "chromium", browserPaths.chromium));

  return detected;
}

/**
 * Validates a custom browser executable path.
 */
export function validateCustomPath(executablePath) {
  if (!executablePath) return false;
  try {
    return fs.existsSync(executablePath);
  } catch {
    return false;
  }
}
