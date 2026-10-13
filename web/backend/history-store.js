import fs from "fs";
import path from "path";

const DATA_DIR = path.resolve("./data");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");

export class HistoryStore {
  constructor() {
    this.ensureDataDir();
    this.history = this.loadHistory();
  }

  ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  loadHistory() {
    try {
      if (fs.existsSync(HISTORY_FILE)) {
        const raw = fs.readFileSync(HISTORY_FILE, "utf-8");
        return JSON.parse(raw);
      }
    } catch (err) {
      console.warn("Could not read history.json, initializing empty list:", err.message);
    }
    return [];
  }

  saveHistory() {
    try {
      this.ensureDataDir();
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(this.history, null, 2), "utf-8");
    } catch (err) {
      console.error("Failed to save history.json:", err.message);
    }
  }

  getAll() {
    return [...this.history].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  getById(id) {
    return this.history.find(j => String(j.id) === String(id)) || null;
  }

  addOrUpdate(job) {
    const index = this.history.findIndex(j => String(j.id) === String(job.id));
    if (index >= 0) {
      this.history[index] = { ...this.history[index], ...job, updatedAt: new Date().toISOString() };
    } else {
      this.history.unshift({ ...job, createdAt: job.createdAt || new Date().toISOString() });
    }
    this.saveHistory();
  }
}
