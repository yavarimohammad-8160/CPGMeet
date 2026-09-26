/**
 * API / Socket.IO base.
 *
 * Production front (meet.cpg-pars.ir, *.pages.dev) is served by Cloudflare
 * Pages; its `_worker.js` proxies /api and /socket.io to Render. Render's
 * 216.24.57.0/24 is blocked by several Iranian ISPs (Pishgaman, Irancell,
 * Zitel, many office networks), so the browser must NEVER talk to the Render
 * host directly — always same-origin, exactly like CPGChat.
 */
function isLocalDevHost(h) {
  if (!h) return true;
  if (h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1") return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

export const API_BASE = (() => {
  const host = typeof window !== "undefined" ? String(window.location.hostname || "").toLowerCase() : "";
  // Cloudflare-fronted hosts and local dev: always same-origin (ignore any build env).
  if (host === "meet.cpg-pars.ir" || host.endsWith(".pages.dev") || isLocalDevHost(host)) return "";
  return String(import.meta.env.VITE_API_URL || "").replace(/\/+$/, "");
})();

export function getApiBase() {
  return API_BASE;
}

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
    .then((r) => r.ok && isJsonResponse(r))
    .catch(() => false)
    .finally(() => {
      setTimeout(() => { wakePromise = null; }, 30_000);
    });
  return wakePromise;
}

function isJsonResponse(res) {
  return String(res?.headers?.get?.("content-type") || "").toLowerCase().includes("application/json");
}

let apiReadyAt = 0;
/** True if /api/health answered OK within the last few minutes. */
export function apiRecentlyReady() {
  return apiReadyAt > 0 && Date.now() - apiReadyAt < 5 * 60_000;
}

/**
 * Wait for the API to answer /api/health, tolerating a Render free-tier cold
 * start (~30-60s). Calls onWaking(true) once the first probe is slow/failed
 * so the UI can show «در حال بیدار شدن سرور…» instead of an error.
 * Resolves true when healthy, false after `maxMs`.
 */
export async function waitForApi({ maxMs = 120_000, onWaking } = {}) {
  const started = Date.now();
  let wakingShown = false;
  const showWaking = () => {
    if (!wakingShown) {
      wakingShown = true;
      try { onWaking?.(true); } catch { /* ignore */ }
    }
  };
  const slowTimer = setTimeout(showWaking, 2500);
  try {
    while (Date.now() - started < maxMs) {
      const ctrl = new AbortController();
      const remaining = maxMs - (Date.now() - started);
      const timer = setTimeout(() => ctrl.abort(), Math.max(1000, Math.min(45_000, remaining)));
      try {
        const res = await fetch(`${API_BASE}/api/health?_=${Date.now()}`, {
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: ctrl.signal
        });
        clearTimeout(timer);
        if (res.ok && isJsonResponse(res)) {
          apiReadyAt = Date.now();
          return true;
        }
      } catch {
        clearTimeout(timer);
      }
      showWaking();
      await sleep(3000);
    }
    return false;
  } finally {
    clearTimeout(slowTimer);
  }
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
