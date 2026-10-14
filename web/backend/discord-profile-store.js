import fs from "fs";
import path from "path";

const DATA_DIR = path.resolve("./data");
const PROFILES_FILE = path.join(DATA_DIR, "discord_profiles.json");
const MAPPINGS_FILE = path.join(DATA_DIR, "account_mappings.json");

/**
 * Normalizes an account handle consistently:
 * Trims whitespace, lowercases, removes internal spaces, and ensures a single leading '@'.
 * e.g. "  @CubeFlox  " -> "@cubeflox", "kick.who_ " -> "@kick.who_"
 */
export function normalizeAccountName(account) {
  if (!account) return "";
  let clean = String(account).trim().toLowerCase().replace(/\s+/g, "");
  if (!clean || clean === "notpublished" || clean === "not_published" || clean === "-") {
    return "";
  }
  if (!clean.startsWith("@")) {
    clean = "@" + clean;
  }
  return clean;
}

export class DiscordProfileStore {
  constructor(options = DATA_DIR) {
    if (typeof options === "string") {
      this.dataDir = options;
      this.profilesFile = path.join(this.dataDir, "discord_profiles.json");
      this.mappingsFile = path.join(this.dataDir, "account_mappings.json");
    } else if (options && typeof options === "object") {
      this.dataDir = options.dataDir || DATA_DIR;
      this.profilesFile = options.profilesFile || path.join(this.dataDir, "discord_profiles.json");
      this.mappingsFile = options.mappingsFile || path.join(this.dataDir, "account_mappings.json");
    } else {
      this.dataDir = DATA_DIR;
      this.profilesFile = path.join(this.dataDir, "discord_profiles.json");
      this.mappingsFile = path.join(this.dataDir, "account_mappings.json");
    }
    this.ensureDataDir();
    this.profiles = this.loadProfiles();
    this.mappings = this.loadMappings();
  }

  ensureDataDir() {
    if (!fs.existsSync(this.dataDir)) {
      try {
        fs.mkdirSync(this.dataDir, { recursive: true });
      } catch {
        // ignore
      }
    }
  }

  loadProfiles() {
    try {
      if (fs.existsSync(this.profilesFile)) {
        const raw = fs.readFileSync(this.profilesFile, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch (err) {
      console.warn("[DiscordProfileStore] Error loading profiles:", err.message);
    }

    // Default seed with a single default profile
    const defaultProfile = {
      id: "prof_default",
      name: "Discord Profile 1",
      mode: "dedicated", // "dedicated" (isolated user-data dir) or "existing" (CDP)
      port: 9222,
      profileDir: null,
      status: "NOT_CONNECTED", // "CONNECTED", "NOT_CONNECTED", "CONNECTION_FAILED"
      statusMessage: "Profile initialized. Click Test or Open Browser to authenticate.",
      lastTestedAt: null,
      createdAt: new Date().toISOString()
    };
    const initial = [defaultProfile];
    this.saveProfiles(initial);
    return initial;
  }

  saveProfiles(profiles = this.profiles) {
    try {
      this.ensureDataDir();
      fs.writeFileSync(this.profilesFile, JSON.stringify(profiles, null, 2), "utf-8");
      this.profiles = profiles;
    } catch (err) {
      console.error("[DiscordProfileStore] Failed to save profiles:", err.message);
    }
  }

  loadMappings() {
    try {
      if (fs.existsSync(this.mappingsFile)) {
        const raw = fs.readFileSync(this.mappingsFile, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      }
    } catch (err) {
      console.warn("[DiscordProfileStore] Error loading mappings:", err.message);
    }
    return [];
  }

  saveMappings(mappings = this.mappings) {
    try {
      this.ensureDataDir();
      fs.writeFileSync(this.mappingsFile, JSON.stringify(mappings, null, 2), "utf-8");
      this.mappings = mappings;
    } catch (err) {
      console.error("[DiscordProfileStore] Failed to save mappings:", err.message);
    }
  }

  // --- Profile Operations ---

  getAllProfiles() {
    return [...this.profiles];
  }

  getProfileById(id) {
    return this.profiles.find(p => p.id === id) || null;
  }

  createProfile({ name, mode = "dedicated", port = 9222, profileDir = null }) {
    if (!name || !String(name).trim()) {
      throw new Error("Profile name is required.");
    }
    const cleanName = String(name).trim();
    const existing = this.profiles.find(p => p.name.toLowerCase() === cleanName.toLowerCase());
    if (existing) {
      throw new Error(`A profile with the name "${cleanName}" already exists.`);
    }

    const id = `prof_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const newProfile = {
      id,
      name: cleanName,
      mode,
      port: Number(port) || 9222,
      profileDir: profileDir || null,
      status: "NOT_CONNECTED",
      statusMessage: "New profile created. Please open browser to authenticate.",
      lastTestedAt: null,
      createdAt: new Date().toISOString()
    };

    this.profiles.push(newProfile);
    this.saveProfiles();
    return newProfile;
  }

  updateProfile(id, updates = {}) {
    const profile = this.getProfileById(id);
    if (!profile) {
      throw new Error(`Profile with ID "${id}" not found.`);
    }

    if (updates.name && String(updates.name).trim()) {
      const cleanName = String(updates.name).trim();
      const duplicate = this.profiles.find(
        p => p.id !== id && p.name.toLowerCase() === cleanName.toLowerCase()
      );
      if (duplicate) {
        throw new Error(`Another profile already uses the name "${cleanName}".`);
      }
      profile.name = cleanName;
    }

    if (updates.mode !== undefined) profile.mode = updates.mode;
    if (updates.port !== undefined) profile.port = Number(updates.port) || 9222;
    if (updates.profileDir !== undefined) profile.profileDir = updates.profileDir;
    if (updates.status !== undefined) profile.status = updates.status;
    if (updates.statusMessage !== undefined) profile.statusMessage = updates.statusMessage;
    if (updates.lastTestedAt !== undefined) profile.lastTestedAt = updates.lastTestedAt;

    profile.updatedAt = new Date().toISOString();
    this.saveProfiles();
    return profile;
  }

  deleteProfile(id) {
    const profile = this.getProfileById(id);
    if (!profile) {
      throw new Error(`Profile with ID "${id}" not found.`);
    }

    if (this.profiles.length <= 1) {
      throw new Error("Cannot delete the only remaining Discord profile.");
    }

    this.profiles = this.profiles.filter(p => p.id !== id);
    this.saveProfiles();

    // Also remove any mappings linked to this deleted profile
    this.mappings = this.mappings.filter(m => m.profileId !== id);
    this.saveMappings();

    return true;
  }

  // --- Account Mapping Operations ---

  getAllMappings() {
    return this.mappings.map(m => {
      const profile = this.getProfileById(m.profileId);
      return {
        account: m.account,
        profileId: m.profileId,
        profileName: profile ? profile.name : "Unknown / Deleted",
        profileStatus: profile ? profile.status : "NOT_CONNECTED"
      };
    });
  }

  setMapping(rawAccount, profileId) {
    const normalized = normalizeAccountName(rawAccount);
    if (!normalized) {
      throw new Error("Invalid account handle. Account name cannot be empty or 'Not published'.");
    }

    const profile = this.getProfileById(profileId);
    if (!profile) {
      throw new Error(`Target profile "${profileId}" does not exist.`);
    }

    const index = this.mappings.findIndex(m => m.account === normalized);
    if (index >= 0) {
      this.mappings[index].profileId = profileId;
      this.mappings[index].updatedAt = new Date().toISOString();
    } else {
      this.mappings.push({
        account: normalized,
        profileId,
        createdAt: new Date().toISOString()
      });
    }

    this.saveMappings();
    return {
      account: normalized,
      profileId,
      profileName: profile.name
    };
  }

  getMappingForAccount(rawAccount) {
    const normalized = normalizeAccountName(rawAccount);
    if (!normalized) return null;
    return this.mappings.find(m => m.account === normalized) || null;
  }

  deleteMapping(rawAccount) {
    const normalized = normalizeAccountName(rawAccount);
    if (!normalized) return false;

    const initialLen = this.mappings.length;
    this.mappings = this.mappings.filter(m => m.account !== normalized);
    this.saveMappings();
    return this.mappings.length < initialLen;
  }

  /**
   * Resolves the configured profile for a published account.
   * If only 1 profile exists and no mappings are defined, returns that default profile (single-profile workflow).
   */
  resolveProfileForAccount(rawAccount, { checkConnection = false } = {}) {
    const normalized = normalizeAccountName(rawAccount);

    // Single-profile backward compatibility:
    // If user has exactly 1 profile configured and no mappings are configured at all,
    // fallback cleanly to the single default profile.
    if (this.profiles.length === 1 && this.mappings.length === 0) {
      const p = this.profiles[0];
      if (checkConnection && p.status !== "CONNECTED") {
        return {
          resolved: false,
          account: normalized || "single_profile_default",
          profile: p,
          reason: "PROFILE_DISCONNECTED"
        };
      }
      return {
        resolved: true,
        account: normalized || "single_profile_default",
        profile: p,
        reason: "SINGLE_PROFILE_DEFAULT"
      };
    }

    if (!normalized) {
      return {
        resolved: false,
        account: rawAccount || "Not published",
        profile: null,
        reason: "ACCOUNT_NOT_PUBLISHED"
      };
    }

    const mapping = this.mappings.find(m => m.account === normalized);
    if (!mapping) {
      return {
        resolved: false,
        account: normalized,
        profile: null,
        reason: "ACCOUNT_UNMAPPED"
      };
    }

    const profile = this.getProfileById(mapping.profileId);
    if (!profile) {
      return {
        resolved: false,
        account: normalized,
        profile: null,
        reason: "MAPPED_PROFILE_MISSING"
      };
    }

    if (checkConnection && profile.status !== "CONNECTED") {
      return {
        resolved: false,
        account: normalized,
        profile,
        reason: "PROFILE_DISCONNECTED"
      };
    }

    return {
      resolved: true,
      account: normalized,
      profile,
      reason: "MAPPED_SUCCESS"
    };
  }

  /**
   * Analyzes an upcoming batch queue and returns a preflight summary.
   */
  validateQueueRouting(queue = []) {
    const eligibleRows = [];
    const validMappedRows = [];
    const unmappedAccounts = new Set();
    const disconnectedProfileMap = new Map();
    const missingAccounts = [];

    for (const item of queue) {
      // Check account
      const rawAccount = item.publishedOnAccount;
      const res = this.resolveProfileForAccount(rawAccount);

      if (res.resolved && res.profile) {
        if (res.profile.status !== "CONNECTED") {
          disconnectedProfileMap.set(res.profile.id, {
            id: res.profile.id,
            name: res.profile.name,
            status: res.profile.status
          });
        }
        validMappedRows.push({ item, profile: res.profile });
      } else {
        if (res.reason === "ACCOUNT_UNMAPPED") {
          unmappedAccounts.add(res.account);
        } else if (res.reason === "ACCOUNT_NOT_PUBLISHED") {
          missingAccounts.push(item);
        }
      }
      eligibleRows.push(item);
    }

    const unmappedList = Array.from(unmappedAccounts);
    const disconnectedList = Array.from(disconnectedProfileMap.values());

    const isSafe = unmappedList.length === 0 && disconnectedList.length === 0;

    return {
      totalRows: queue.length,
      eligibleRowsCount: eligibleRows.length,
      validMappedCount: validMappedRows.length,
      unmappedAccountsCount: unmappedList.length,
      unmappedAccounts: unmappedList,
      disconnectedProfilesCount: disconnectedList.length,
      disconnectedProfiles: disconnectedList,
      missingAccountsCount: missingAccounts.length,
      isSafe,
      safe: isSafe,
      canExecute: isSafe && eligibleRows.length > 0,
      summary: {
        safeToRun: isSafe,
        eligibleCount: eligibleRows.length,
        mappedCount: validMappedRows.length,
        unmappedCount: unmappedList.length,
        disconnectedCount: disconnectedList.length
      }
    };
  }
}
