export const API_BASE = (() => {
  const fromEnv = String(import.meta.env.VITE_API_URL || "").replace(/\/+$/, "");
  if (fromEnv) return fromEnv;
  if (typeof window !== "undefined") {
    const host = String(window.location.hostname || "").toLowerCase();
    if (host === "meet.cpg-pars.ir") return "https://meet-api.cpg-pars.ir";
  }
  return "";
})();

const TOKEN_KEY = "cpgmeet_token";
const USER_KEY = "cpgmeet_user";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

export function getStoredUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || "null");
  } catch {
    return null;
  }
}

export function setSession(token, user) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

const DEFAULT_TIMEOUT_MS = 60_000;
const RETRY_BACKOFF_MS = [1000, 3000, 8000];
const RETRY_STATUSES = new Set([502, 503, 504]);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url, init = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      clearTimeout(timer);
      if (RETRY_STATUSES.has(res.status) && attempt < retries) {
        await sleep(RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)]);
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) {
        await sleep(RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)]);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error("fetch failed");
}

let wakePromise = null;
/** Fire-and-forget health ping to wake Render cold start. */
export function wakeApi() {
  if (wakePromise) return wakePromise;
  wakePromise = fetchWithRetry(`${API_BASE}/api/health`, {
    method: "GET",
    headers: { Accept: "application/json" }
  }, { timeoutMs: 90_000, retries: 2 })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      setTimeout(() => { wakePromise = null; }, 30_000);
    });
  return wakePromise;
}

export async function api(path, { method = "GET", body, token } = {}) {
  const headers = { Accept: "application/json" };
  const t = token ?? getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetchWithRetry(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: "bad_json", raw: text?.slice(0, 200) };
  }
  if (!res.ok) {
    const err = new Error(data?.error || `http_${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export async function downloadIcs(meetingId) {
  const res = await fetch(`${API_BASE}/api/meetings/${meetingId}/ics`, {
    headers: { Authorization: `Bearer ${getToken()}` }
  });
  if (!res.ok) throw new Error("ics_failed");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `meeting-${meetingId}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function uploadMeetingFile(meetingId, file, kind = "attachment") {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("kind", kind);
  const res = await fetch(`${API_BASE}/api/meetings/${meetingId}/files?kind=${encodeURIComponent(kind)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${getToken()}` },
    body: fd
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: "bad_json", raw: text?.slice(0, 200) };
  }
  if (!res.ok) {
    const err = new Error(data?.error || `http_${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** iPhone / iPad (incl. iPadOS that reports as Mac). */
export function isIOS() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function isStandalonePwa() {
  if (typeof window === "undefined") return false;
  return Boolean(window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone);
}

/** Absolute URL for a server-relative signed file link (/api/files/:id?t=...). */
export function fileUrl(rel) {
  if (!rel) return "";
  return /^https?:/i.test(rel) ? rel : `${API_BASE}${rel}`;
}

export function fileLinkExpired(file) {
  if (!file?.download_url) return true;
  const exp = Date.parse(file.link_expires_at || "");
  return !Number.isFinite(exp) || Date.now() > exp;
}

/** Fetch fresh signed links for a file (list links expire after a few hours). */
export async function freshFileLinks(fileId) {
  const data = await api(`/api/files/${fileId}/link`);
  return data.file;
}

/**
 * Open/download a meeting file via its signed URL. The server sends
 * Content-Disposition (attachment or inline) with an RFC 5987 Persian filename,
 * so a plain navigation works everywhere: iOS Safari/PWA shows its download /
 * Quick Look sheet, Android Chrome + desktop save the file.
 * `preOpened` is a window opened synchronously in the click handler (iOS
 * blocks window.open after an await).
 */
export async function openMeetingFile(file, { inline = false, preOpened = null } = {}) {
  let f = file;
  if (fileLinkExpired(f)) f = await freshFileLinks(file.id);
  const url = fileUrl(inline ? f.view_url || f.download_url : f.download_url);
  if (!url) throw new Error("file_lost");
  if (preOpened && !preOpened.closed) {
    preOpened.location.href = url;
  } else if (inline || isIOS()) {
    const w = window.open(url, "_blank", "noopener");
    if (!w) window.location.href = url;
  } else {
    window.location.href = url;
  }
  return f;
}
