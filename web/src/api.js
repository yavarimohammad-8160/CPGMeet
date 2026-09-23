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

export async function api(path, { method = "GET", body, token } = {}) {
  const headers = { Accept: "application/json" };
  const t = token ?? getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API_BASE}${path}`, {
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
  a.click();
  URL.revokeObjectURL(url);
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

export async function downloadMeetingFile(fileId, name) {
  const res = await fetch(`${API_BASE}/api/files/${fileId}`, {
    headers: { Authorization: `Bearer ${getToken()}` }
  });
  if (!res.ok) throw new Error("download_failed");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name || `file-${fileId}`;
  a.click();
  URL.revokeObjectURL(url);
}
