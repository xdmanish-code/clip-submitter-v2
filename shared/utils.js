export function clean(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").trim();
}

export function normalizeUsername(value) {
  return clean(value).replace(/^@/, "").toLowerCase();
}

export function isUnclaimed(value) {
  const v = normalizeUsername(value);
  return !v || v === "unclaimed";
}

export function escapeRegex(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeInstagramUrl(url) {
  if (!url) return "";
  const raw = clean(url).trim();
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return `https://${host}${pathname}`;
  } catch {
    return raw.replace(/^https?:\/\/(www\.)?/, "https://").replace(/\/+$/, "");
  }
}
