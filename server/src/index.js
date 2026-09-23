import http from "node:http";
import express from "express";
import cors from "cors";
import { Server } from "socket.io";
import { db, paths } from "./db.js";
import { authMiddleware, signToken, verifyToken, SECRET } from "./auth.js";
import {
  ensureMeetUsers,
  findUserByEmail,
  findUserById,
  hashPassword,
  listActiveUsers,
  listAllUsers,
  publicUser,
  verifyPassword
} from "./users.js";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";

const meetUsersSeed = ensureMeetUsers(db);
if (meetUsersSeed.seededAdmin) {
  console.log("[CPGMeet] Seeded admin", meetUsersSeed.email, "temp password:", meetUsersSeed.tempPassword);
}

const PORT = Number(process.env.PORT || 8788);
const HOST = '0.0.0.0';
const CPGCHAT_API_URL = (process.env.CPGCHAT_API_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const CPGMEET_NOTIFY_SECRET = process.env.CPGMEET_NOTIFY_SECRET || "cpgmeet-notify-pilot";
const CPGMEET_WEB_URL = (process.env.CPGMEET_WEB_URL || "https://meet.cpg-pars.ir").replace(/\/$/, "");

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(paths.rootDir, "data", "uploads");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const LOCATION_LABELS = {
  room_gf: "اتاق جلسات همکف",
  room_1: "اتاق جلسات طبقه اول",
  room_2: "اتاق جلسات طبقه دوم",
  room_3: "اتاق جلسات طبقه سوم",
  room_4: "اتاق جلسات طبقه چهارم",
  room_5: "اتاق جلسات طبقه پنجم",
  room_6: "اتاق جلسات طبقه ششم",
  deputy_planning: "دفتر معاونت برنامه‌ریزی و توسعه",
  external: "خارج از سازمان"
};

function buildLocationDisplay(key, detail) {
  const k = String(key || "").trim();
  const d = String(detail || "").trim();
  if (!k) return d || "";
  const base = LOCATION_LABELS[k] || k;
  if (k === "external") return d ? `${base} — ${d}` : base;
  return base;
}

function coerce01(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === 1 || value === "1") return 1;
  return 0;
}

const ALLOWED_MIME = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/zip",
  "application/x-zip-compressed",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "text/plain"
]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const safe = String(decodeMulterFilename(file.originalname) || "file").replace(/[^a-zA-Z0-9._\u0600-\u06FF-]+/g, "_").slice(0, 80);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
  }
});


function decodeMulterFilename(name) {
  const raw = String(name || "file");
  if (/[\u0600-\u06FF]/.test(raw)) return raw;
  try {
    const decoded = Buffer.from(raw, "latin1").toString("utf8");
    if (decoded.includes("\uFFFD")) return raw;
    if (/[\u0600-\u06FF]/.test(decoded)) return decoded;
    if (/[^\x00-\x7F]/.test(raw) && decoded !== raw) return decoded;
    return raw;
  } catch {
    return raw;
  }
}

function contentDispositionAttachment(filename) {
  const fallback = String(filename || "file")
    .replace(/[^\x20-\x7E]+/g, "_")
    .replace(/["\\]/g, "_") || "file";
  const encoded = encodeURIComponent(String(filename || "file")).replace(/['()]/g, escape);
  return 'attachment; filename="' + fallback + '"; filename*=UTF-8\'\'' + encoded;
}
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || "");
    const name = String(file.originalname || "").toLowerCase();
    const okExt = /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|zip|jpg|jpeg|png|gif|webp|txt)$/.test(name);
    if (ALLOWED_MIME.has(mime) || okExt) return cb(null, true);
    cb(new Error("unsupported_file_type"));
  }
});

function listMeetingFiles(meetingId) {
  return db
    .prepare(
      `SELECT id, meeting_id, uploader_id, name, mime, size, kind, created_at
       FROM meeting_files WHERE meeting_id = ? ORDER BY created_at DESC, id DESC`
    )
    .all(Number(meetingId));
}

function getMeetingFile(id) {
  return db.prepare("SELECT * FROM meeting_files WHERE id = ?").get(Number(id));
}

const allowedOrigins = [...new Set([
  "https://meet.cpg-pars.ir",
  "https://chat.cpg-pars.ir",
  ...(process.env.CORS_ORIGIN || "").split(",").map((origin) => origin.trim()).filter(Boolean),
  "http://localhost:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174"
])];

const app = express();
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: "1mb" }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: allowedOrigins, methods: ["GET", "POST"], credentials: true }
});

const online = new Map(); // userId -> Set(socketId)

io.use((socket, next) => {
  try {
    const token =
      socket.handshake.auth?.token ||
      (String(socket.handshake.headers?.authorization || "").startsWith("Bearer ")
        ? socket.handshake.headers.authorization.slice(7)
        : null);
    if (!token) return next(new Error("unauthorized"));
    socket.user = verifyToken(token);
    next();
  } catch {
    next(new Error("unauthorized"));
  }
});

io.on("connection", (socket) => {
  const uid = Number(socket.user.id);
  socket.join(`user:${uid}`);
  if (!online.has(uid)) online.set(uid, new Set());
  online.get(uid).add(socket.id);
  socket.on("disconnect", () => {
    const set = online.get(uid);
    if (set) {
      set.delete(socket.id);
      if (!set.size) online.delete(uid);
    }
  });
});

function emitToUser(userId, event, payload) {
  io.to(`user:${Number(userId)}`).emit(event, payload);
}

async function forwardJson(path, { method = "GET", token, body } = {}) {
  const url = `${CPGCHAT_API_URL}${path}`;
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: "bad_upstream", raw: text?.slice(0, 200) };
  }
  return { status: res.status, data };
}

function nowIso() {
  return new Date().toISOString();
}

function listActiveCompanies() {
  return db
    .prepare("SELECT id, name FROM companies WHERE active = 1 ORDER BY name COLLATE NOCASE")
    .all()
    .map((r) => ({ id: String(r.id), name: String(r.name) }));
}

function listAllCompanies() {
  return db
    .prepare("SELECT id, name, active, created_at FROM companies ORDER BY name COLLATE NOCASE")
    .all()
    .map((r) => ({
      id: String(r.id),
      name: String(r.name),
      active: Number(r.active) ? 1 : 0,
      created_at: r.created_at
    }));
}

function companyNameById(id) {
  const row = db.prepare("SELECT name FROM companies WHERE id = ?").get(String(id));
  return row ? String(row.name) : null;
}

function slugifyCompanyId(name) {
  const base = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_\u0600-\u06FF-]+/g, "")
    .slice(0, 48);
  const fallback = "co_" + Date.now().toString(36);
  let id = base || fallback;
  let n = 0;
  while (db.prepare("SELECT 1 AS ok FROM companies WHERE id = ?").get(id)) {
    n += 1;
    id = (base || fallback) + "_" + n;
  }
  return id;
}

function normalizeCompanyIds(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const x of raw) {
    const id = String(x || "").trim();
    if (!id || out.includes(id)) continue;
    const row = db.prepare("SELECT id FROM companies WHERE id = ? AND active = 1").get(id);
    if (row) out.push(id);
  }
  return out;
}

function companiesFor(meetingId) {
  const rows = db
    .prepare(
      "SELECT company_id FROM meeting_companies WHERE meeting_id = ? ORDER BY company_id"
    )
    .all(Number(meetingId));
  return rows
    .map((r) => {
      const name = companyNameById(r.company_id);
      return name ? { id: String(r.company_id), name } : null;
    })
    .filter(Boolean);
}

function setMeetingCompanies(meetingId, companyIds) {
  const ids = normalizeCompanyIds(companyIds);
  db.prepare("DELETE FROM meeting_companies WHERE meeting_id = ?").run(Number(meetingId));
  const ins = db.prepare(
    "INSERT INTO meeting_companies (meeting_id, company_id) VALUES (?, ?)"
  );
  for (const id of ids) ins.run(Number(meetingId), id);
  return companiesFor(meetingId);
}

function participantsFor(meetingId) {
  return db
    .prepare(
      `SELECT meeting_id, user_id, rsvp, reminded_at, invited_at
       FROM meeting_participants WHERE meeting_id = ? ORDER BY user_id`
    )
    .all(Number(meetingId));
}

function isDelegated(assistantId, principalId) {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM meeting_delegates WHERE assistant_id = ? AND principal_id = ?`
    )
    .get(Number(assistantId), Number(principalId));
  return Boolean(row);
}

function meetingCreatorId(meeting) {
  if (!meeting) return null;
  if (meeting.created_by_id != null && meeting.created_by_id !== "") {
    return Number(meeting.created_by_id);
  }
  return Number(meeting.organizer_id);
}

/** Edit: organizer, creator, or still-delegated assistant for organizer. */
function canManageMeeting(meeting, userId) {
  const uid = Number(userId);
  if (!meeting) return false;
  if (Number(meeting.organizer_id) === uid) return true;
  if (meeting.created_by_id != null && Number(meeting.created_by_id) === uid) return true;
  if (isDelegated(uid, meeting.organizer_id)) return true;
  return false;
}

/** Cancel strictly by creator (created_by_id, fallback organizer_id). */
function canCancelMeeting(meeting, userId) {
  const uid = Number(userId);
  if (!meeting) return false;
  return meetingCreatorId(meeting) === uid;
}

function presentMeeting(meeting) {
  if (!meeting) return null;
  const organizer_id = Number(meeting.organizer_id);
  const created_by_id =
    meeting.created_by_id != null && meeting.created_by_id !== ""
      ? Number(meeting.created_by_id)
      : organizer_id;
  const remind_15 =
    meeting.remind_15 == null || meeting.remind_15 === ""
      ? 1
      : Number(meeting.remind_15) ? 1 : 0;
  const location_key = meeting.location_key || null;
  const location_detail = meeting.location_detail || null;
  const location =
    meeting.location ||
    buildLocationDisplay(location_key, location_detail) ||
    null;
  return {
    ...meeting,
    organizer_id,
    created_by_id,
    remind_15,
    location_key,
    location_detail,
    location,
    needs_catering: coerce01(meeting.needs_catering, 0),
    catering_tea: coerce01(meeting.catering_tea, 0),
    catering_coffee: coerce01(meeting.catering_coffee, 0),
    catering_sweets: coerce01(meeting.catering_sweets, 0),
    on_behalf: created_by_id !== organizer_id,
    can_cancel: true, // filled per-request in handlers when needed
    participants: meeting.participants || participantsFor(meeting.id),
    companies: meeting.companies || companiesFor(meeting.id)
  };
}

function getMeeting(id) {
  const meeting = db.prepare("SELECT * FROM meetings WHERE id = ?").get(Number(id));
  if (!meeting) return null;
  return presentMeeting({ ...meeting, participants: participantsFor(meeting.id), companies: companiesFor(meeting.id) });
}

function userCanSee(meeting, userId) {
  if (!meeting) return false;
  const uid = Number(userId);
  if (Number(meeting.organizer_id) === uid) return true;
  if (meeting.created_by_id != null && Number(meeting.created_by_id) === uid) return true;
  return (meeting.participants || []).some((p) => Number(p.user_id) === uid);
}

function isMeetAdmin(user) {
  if (!user) return false;
  if (String(user.role || "") === "admin") return true;
  const email = String(user.email || "").trim().toLowerCase();
  return email === "m.yavari@cpg-pars.com";
}

function requireAdmin(req, res, next) {
  if (!isMeetAdmin(req.user)) {
    return res.status(403).json({ error: "forbidden" });
  }
  next();
}

function icsEscape(s) {
  return String(s || "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function toIcsUtc(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

function buildIcs(meeting) {
  const uid = `cpgmeet-${meeting.id}@local`;
  const stamp = toIcsUtc(meeting.updated_at || meeting.created_at || nowIso());
  const start = toIcsUtc(meeting.start_at);
  const end = toIcsUtc(meeting.end_at);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//CPGMeet//FA//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${icsEscape(meeting.title)}`,
    `DESCRIPTION:${icsEscape(meeting.body || "")}`,
    `LOCATION:${icsEscape(meeting.location || "")}`,
    `STATUS:${meeting.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT",
    "END:VCALENDAR"
  ];
  return lines.join("\r\n") + "\r\n";
}

function coerceRemind15(value, fallback = 1) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === false || value === 0 || value === "0") return 0;
  return Number(value) ? 1 : 0;
}

/** POST meeting events into CPGChat internal notify (socket cpgmeet:notify). */
async function notifyCpgChat(event, payload) {
  const meeting = payload?.meeting;
  const meetingId = meeting?.id != null ? Number(meeting.id) : undefined;
  let userIds = [];
  let title = "CPGMeet";
  let body = "";
  let kind = "meeting";

  if (event === "meeting:reminder") {
    kind = "reminder";
    if (payload?.userId != null) userIds = [Number(payload.userId)];
    title = meeting?.title ? String(meeting.title) : "یادآوری جلسه";
    body = `حدود ${payload?.minutesLeft ?? 15} دقیقه تا شروع`;
  } else if (event === "meeting:cancel") {
    kind = "cancel";
    userIds = (meeting?.participants || [])
      .map((p) => Number(p.user_id))
      .filter((n) => Number.isFinite(n) && n > 0);
    title = meeting?.title ? `لغو جلسه: ${meeting.title}` : "لغو جلسه";
    body = "این جلسه لغو شد";
  } else if (event === "meeting:invite") {
    kind = payload?.cancelled ? "cancel" : payload?.updated ? "update" : "invite";
    userIds = (meeting?.participants || [])
      .map((p) => Number(p.user_id))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (kind === "cancel") {
      title = meeting?.title ? `لغو جلسه: ${meeting.title}` : "لغو جلسه";
      body = "این جلسه لغو شد";
    } else if (kind === "update") {
      title = meeting?.title ? `به‌روزرسانی جلسه: ${meeting.title}` : "به‌روزرسانی جلسه";
      body = meeting?.start_at ? `شروع: ${meeting.start_at}` : meeting?.location || "";
    } else {
      title = meeting?.title ? `دعوت به جلسه: ${meeting.title}` : "دعوت به جلسه";
      body = meeting?.start_at ? `شروع: ${meeting.start_at}` : meeting?.location || "";
    }
  } else {
    return;
  }

  userIds = [...new Set(userIds.filter((n) => Number.isFinite(n) && n > 0))];
  if (!userIds.length) return;

  const url = `${CPGCHAT_API_URL}/api/internal/cpgmeet/notify`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-CPGMeet-Secret": CPGMEET_NOTIFY_SECRET
      },
      body: JSON.stringify({
        userIds,
        title,
        body,
        kind,
        meetingId,
        url: CPGMEET_WEB_URL
      })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn("[CPGMeet] notifyCpgChat", res.status, text?.slice(0, 200));
    }
  } catch (err) {
    console.warn("[CPGMeet] notifyCpgChat error", err?.message || err);
  }
}

app.get("/api/locations", authMiddleware, (_req, res) => {
  res.json({
    locations: Object.entries(LOCATION_LABELS).map(([key, label]) => ({ key, label }))
  });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    name: "CPGMeet",
    db: paths.dbPath,
    cpgchat: CPGCHAT_API_URL,
    notify: `${CPGCHAT_API_URL}/api/internal/cpgmeet/notify`,
    web: CPGMEET_WEB_URL
  });
});

app.post("/api/auth/login", (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!email || !password) return res.status(400).json({ error: "missing_fields" });
  const row = findUserByEmail(db, email);
  if (!row || !Number(row.active)) return res.status(401).json({ error: "invalid_credentials" });
  if (!verifyPassword(password, row.password_hash)) {
    return res.status(401).json({ error: "invalid_credentials" });
  }
  const user = publicUser(row);
  const token = signToken(user);
  res.json({ token, user });
});

app.get("/api/me", authMiddleware, (req, res) => {
  const row = findUserById(db, req.user.id);
  if (!row || !Number(row.active)) return res.status(401).json({ error: "unauthorized" });
  const user = publicUser(row);
  res.json({ ...user, is_admin: isMeetAdmin(user) });
});

app.get("/api/users", authMiddleware, (_req, res) => {
  res.json(listActiveUsers(db));
});

app.get("/api/delegates/principals", authMiddleware, (req, res) => {
  const me = Number(req.user.id);
  const rows = db
    .prepare("SELECT principal_id FROM meeting_delegates WHERE assistant_id = ?")
    .all(me);
  const ids = [me, ...rows.map((r) => Number(r.principal_id))];
  const unique = [...new Set(ids.filter((n) => Number.isFinite(n) && n > 0))];
  const users = listActiveUsers(db);
  const byId = new Map(users.map((u) => [Number(u.id), u]));
  const principals = unique.map((id) => {
    const u = byId.get(id) || (id === me ? publicUser(findUserById(db, me)) : null);
    return {
      id,
      name: u?.name || (id === me ? req.user.email || "من" : "کاربر #" + id),
      email: u?.email || (id === me ? req.user.email || "" : "")
    };
  });
  res.json({ principals });
});

app.get("/api/admin/companies", authMiddleware, requireAdmin, (_req, res) => {
  res.json({ companies: listAllCompanies() });
});

app.post("/api/admin/companies", authMiddleware, requireAdmin, (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "missing_fields" });
  const id = String(req.body?.id || "").trim() || slugifyCompanyId(name);
  try {
    db.prepare("INSERT INTO companies (id, name, active) VALUES (?, ?, 1)").run(id, name);
  } catch (err) {
    const msg = String(err?.message || err);
    if (/UNIQUE/i.test(msg)) return res.status(409).json({ error: "id_taken" });
    return res.status(500).json({ error: "create_failed", message: msg });
  }
  res.status(201).json({ company: { id, name, active: 1 } });
});

app.patch("/api/admin/companies/:id", authMiddleware, requireAdmin, (req, res) => {
  const id = String(req.params.id || "").trim();
  const row = db.prepare("SELECT * FROM companies WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: "not_found" });
  const name = req.body?.name !== undefined ? String(req.body.name || "").trim() : row.name;
  if (!name) return res.status(400).json({ error: "missing_fields" });
  let active = Number(row.active) ? 1 : 0;
  if (req.body?.active !== undefined) active = Number(req.body.active) ? 1 : 0;
  db.prepare("UPDATE companies SET name = ?, active = ? WHERE id = ?").run(name, active, id);
  res.json({ company: { id, name, active } });
});

app.delete("/api/admin/companies/:id", authMiddleware, requireAdmin, (req, res) => {
  const id = String(req.params.id || "").trim();
  const row = db.prepare("SELECT * FROM companies WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: "not_found" });
  db.prepare("DELETE FROM meeting_companies WHERE company_id = ?").run(id);
  db.prepare("DELETE FROM companies WHERE id = ?").run(id);
  res.json({ ok: true });
});

app.get("/api/admin/people", authMiddleware, requireAdmin, (_req, res) => {
  res.json(listAllUsers(db));
});

app.post("/api/admin/people", authMiddleware, requireAdmin, (req, res) => {
  const name = String(req.body?.name || "").trim();
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const role = String(req.body?.role || "user");
  if (!name || !email || !password) return res.status(400).json({ error: "missing_fields" });
  if (password.length < 8) return res.status(400).json({ error: "password_short" });
  if (!["user", "admin"].includes(role)) return res.status(400).json({ error: "bad_role" });
  try {
    const info = db
      .prepare("INSERT INTO meet_users (name, email, password_hash, role, active) VALUES (?, ?, ?, ?, 1)")
      .run(name, email, hashPassword(password), role);
    const row = findUserById(db, info.lastInsertRowid);
    res.status(201).json(publicUser(row));
  } catch (err) {
    const msg = String(err?.message || err);
    if (/UNIQUE/i.test(msg)) return res.status(409).json({ error: "email_taken" });
    return res.status(500).json({ error: "create_failed", message: msg });
  }
});

app.patch("/api/admin/people/:id", authMiddleware, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = findUserById(db, id);
  if (!row) return res.status(404).json({ error: "not_found" });
  const body = req.body || {};
  let name = row.name;
  let role = row.role;
  let active = Number(row.active) ? 1 : 0;
  if (body.name !== undefined) {
    name = String(body.name || "").trim();
    if (!name) return res.status(400).json({ error: "missing_fields" });
  }
  if (body.role !== undefined) {
    role = String(body.role || "user");
    if (!["user", "admin"].includes(role)) return res.status(400).json({ error: "bad_role" });
  }
  if (body.active !== undefined) active = Number(body.active) ? 1 : 0;
  if (String(row.role) === "admin" && (role !== "admin" || !active)) {
    const admins = db
      .prepare("SELECT COUNT(*) AS n FROM meet_users WHERE role = 'admin' AND active = 1 AND id != ?")
      .get(id);
    if (!admins || Number(admins.n) === 0) return res.status(400).json({ error: "last_admin" });
  }
  db.prepare(
    "UPDATE meet_users SET name = ?, role = ?, active = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(name, role, active, id);
  res.json(publicUser(findUserById(db, id)));
});

app.post("/api/admin/people/:id/password", authMiddleware, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = findUserById(db, id);
  if (!row) return res.status(404).json({ error: "not_found" });
  const password = String(req.body?.password || "");
  if (password.length < 8) return res.status(400).json({ error: "password_short" });
  db.prepare(
    "UPDATE meet_users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(hashPassword(password), id);
  res.json({ ok: true });
});

app.delete("/api/admin/people/:id", authMiddleware, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = findUserById(db, id);
  if (!row) return res.status(404).json({ error: "not_found" });
  if (Number(id) === Number(req.user.id)) return res.status(400).json({ error: "cannot_delete_self" });
  if (String(row.role) === "admin") {
    const admins = db
      .prepare("SELECT COUNT(*) AS n FROM meet_users WHERE role = 'admin' AND active = 1 AND id != ?")
      .get(id);
    if (!admins || Number(admins.n) === 0) return res.status(400).json({ error: "last_admin" });
  }
  db.prepare("DELETE FROM meet_users WHERE id = ?").run(id);
  res.json({ ok: true });
});

app.get("/api/admin/delegates", authMiddleware, requireAdmin, (_req, res) => {
  const delegates = db
    .prepare(
      `SELECT principal_id, assistant_id FROM meeting_delegates ORDER BY principal_id, assistant_id`
    )
    .all();
  res.json({ delegates });
});

app.post("/api/admin/delegates", authMiddleware, requireAdmin, (req, res) => {
  const principal_id = Number(req.body?.principal_id);
  const assistant_id = Number(req.body?.assistant_id);
  if (!Number.isFinite(principal_id) || !Number.isFinite(assistant_id) || principal_id <= 0 || assistant_id <= 0) {
    return res.status(400).json({ error: "missing_fields" });
  }
  if (principal_id === assistant_id) {
    return res.status(400).json({ error: "same_user" });
  }
  db.prepare(
    `INSERT OR IGNORE INTO meeting_delegates (principal_id, assistant_id) VALUES (?, ?)`
  ).run(principal_id, assistant_id);
  res.status(201).json({ ok: true, principal_id, assistant_id });
});

app.delete("/api/admin/delegates", authMiddleware, requireAdmin, (req, res) => {
  const principal_id = Number(req.body?.principal_id);
  const assistant_id = Number(req.body?.assistant_id);
  if (!Number.isFinite(principal_id) || !Number.isFinite(assistant_id)) {
    return res.status(400).json({ error: "missing_fields" });
  }
  db.prepare(
    `DELETE FROM meeting_delegates WHERE principal_id = ? AND assistant_id = ?`
  ).run(principal_id, assistant_id);
  res.json({ ok: true, principal_id, assistant_id });
});

app.put("/api/admin/delegates", authMiddleware, requireAdmin, (req, res) => {
  const principal_id = Number(req.body?.principal_id);
  let assistant_ids = Array.isArray(req.body?.assistant_ids)
    ? req.body.assistant_ids.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  if (!Number.isFinite(principal_id) || principal_id <= 0) {
    return res.status(400).json({ error: "missing_fields" });
  }
  assistant_ids = [...new Set(assistant_ids)].filter((id) => id !== principal_id);
  db.prepare(`DELETE FROM meeting_delegates WHERE principal_id = ?`).run(principal_id);
  const ins = db.prepare(
    `INSERT INTO meeting_delegates (principal_id, assistant_id) VALUES (?, ?)`
  );
  for (const aid of assistant_ids) {
    ins.run(principal_id, aid);
  }
  res.json({ ok: true, principal_id, assistant_ids });
});

app.get("/api/companies", authMiddleware, (_req, res) => {
  res.json({ companies: listActiveCompanies() });
});

app.get("/api/meetings", authMiddleware, (req, res) => {
  const uid = Number(req.user.id);
  const from = req.query.from ? String(req.query.from) : null;
  const to = req.query.to ? String(req.query.to) : null;

  let sql = `
    SELECT DISTINCT m.*
    FROM meetings m
    LEFT JOIN meeting_participants p ON p.meeting_id = m.id
    WHERE (m.organizer_id = ? OR m.created_by_id = ? OR p.user_id = ?)
  `;
  const params = [uid, uid, uid];
  if (from) {
    sql += " AND m.end_at >= ?";
    params.push(from);
  }
  if (to) {
    sql += " AND m.start_at <= ?";
    params.push(to);
  }
  sql += " ORDER BY m.start_at ASC";

  const rows = db.prepare(sql).all(...params);
  const meetings = rows.map((m) => presentMeeting({ ...m, participants: participantsFor(m.id), companies: companiesFor(m.id) }));
  res.json({ meetings });
});

app.post("/api/meetings", authMiddleware, (req, res) => {
  const title = String(req.body?.title || "").trim();
  const body = String(req.body?.body || "").trim();
  const location_key = String(req.body?.location_key || "").trim();
  const location_detail = String(req.body?.location_detail || "").trim();
  if (location_key && !(location_key in LOCATION_LABELS)) {
    return res.status(400).json({ error: "invalid_location_key" });
  }
  if (location_key === "external" && !location_detail) {
    return res.status(400).json({ error: "location_detail_required" });
  }
  const location =
    String(req.body?.location || "").trim() ||
    buildLocationDisplay(location_key, location_detail);
  const start_at = String(req.body?.start_at || "").trim();
  const end_at = String(req.body?.end_at || "").trim();
  let participantIds = Array.isArray(req.body?.participant_ids)
    ? req.body.participant_ids.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  const remind_15 = coerceRemind15(req.body?.remind_15, 1);
  const needs_catering = coerce01(req.body?.needs_catering, 0);
  const catering_tea = needs_catering ? coerce01(req.body?.catering_tea, 0) : 0;
  const catering_coffee = needs_catering ? coerce01(req.body?.catering_coffee, 0) : 0;
  const catering_sweets = needs_catering ? coerce01(req.body?.catering_sweets, 0) : 0;

  if (!title || !start_at || !end_at) {
    return res.status(400).json({ error: "missing_fields" });
  }
  if (new Date(end_at) <= new Date(start_at)) {
    return res.status(400).json({ error: "invalid_range" });
  }

  const me = Number(req.user.id);
  const requestedOrganizer = Number(
    req.body?.organizer_id ?? req.body?.on_behalf_of ?? me
  );
  let organizerId = me;
  const createdById = me;

  if (Number.isFinite(requestedOrganizer) && requestedOrganizer > 0 && requestedOrganizer !== me) {
    if (!isDelegated(me, requestedOrganizer)) {
      return res.status(403).json({ error: "not_delegated" });
    }
    organizerId = requestedOrganizer;
  }

  if (!participantIds.includes(organizerId)) participantIds = [organizerId, ...participantIds];
  if (createdById !== organizerId && !participantIds.includes(createdById)) {
    participantIds = [...participantIds, createdById];
  }
  participantIds = [...new Set(participantIds)];

  const result = db
    .prepare(
      `INSERT INTO meetings (
         title, body, location, location_key, location_detail,
         start_at, end_at, organizer_id, created_by_id, status, remind_15,
         needs_catering, catering_tea, catering_coffee, catering_sweets,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    )
    .run(
      title,
      body || null,
      location || null,
      location_key || null,
      location_detail || null,
      start_at,
      end_at,
      organizerId,
      createdById,
      remind_15,
      needs_catering,
      catering_tea,
      catering_coffee,
      catering_sweets
    );

  const meetingId = Number(result.lastInsertRowid);
  const insertP = db.prepare(
    `INSERT INTO meeting_participants (meeting_id, user_id, rsvp, invited_at)
     VALUES (?, ?, ?, datetime('now'))`
  );
  for (const pid of participantIds) {
    const rsvp = pid === organizerId || pid === createdById ? "accepted" : "pending";
    insertP.run(meetingId, pid, rsvp);
  }

  setMeetingCompanies(meetingId, req.body?.company_ids);

  const meeting = getMeeting(meetingId);
  for (const p of meeting.participants) {
    if (Number(p.user_id) === me) continue;
    emitToUser(p.user_id, "meeting:invite", { meeting });
  }
  notifyCpgChat("meeting:invite", { meeting }).catch(() => {});
  res.status(201).json({ meeting });
});

app.get("/api/meetings/:id", authMiddleware, (req, res) => {
  const meeting = getMeeting(req.params.id);
  if (!meeting || !userCanSee(meeting, req.user.id)) {
    return res.status(404).json({ error: "not_found" });
  }
  res.json({
    meeting: {
      ...meeting,
      can_cancel: canCancelMeeting(meeting, req.user.id),
      can_manage: canManageMeeting(meeting, req.user.id),
      files: listMeetingFiles(meeting.id)
    }
  });
});

app.patch("/api/meetings/:id", authMiddleware, (req, res) => {
  const meeting = getMeeting(req.params.id);
  if (!meeting) return res.status(404).json({ error: "not_found" });
  if (!canManageMeeting(meeting, req.user.id)) {
    return res.status(403).json({ error: "forbidden" });
  }
  if (meeting.status === "cancelled") {
    return res.status(400).json({ error: "cancelled" });
  }

  const title = req.body?.title !== undefined ? String(req.body.title).trim() : meeting.title;
  const body = req.body?.body !== undefined ? String(req.body.body).trim() : meeting.body || "";
  const location_key =
    req.body?.location_key !== undefined
      ? String(req.body.location_key || "").trim()
      : meeting.location_key || "";
  const location_detail =
    req.body?.location_detail !== undefined
      ? String(req.body.location_detail || "").trim()
      : meeting.location_detail || "";
  if (location_key && !(location_key in LOCATION_LABELS)) {
    return res.status(400).json({ error: "invalid_location_key" });
  }
  if (location_key === "external" && !location_detail) {
    return res.status(400).json({ error: "location_detail_required" });
  }
  const location =
    req.body?.location !== undefined
      ? String(req.body.location).trim()
      : buildLocationDisplay(location_key, location_detail) || meeting.location || "";
  const start_at = req.body?.start_at !== undefined ? String(req.body.start_at).trim() : meeting.start_at;
  const end_at = req.body?.end_at !== undefined ? String(req.body.end_at).trim() : meeting.end_at;
  const remind_15 =
    req.body?.remind_15 !== undefined
      ? coerceRemind15(req.body.remind_15, meeting.remind_15 ?? 1)
      : coerceRemind15(meeting.remind_15, 1);
  const needs_catering =
    req.body?.needs_catering !== undefined
      ? coerce01(req.body.needs_catering, 0)
      : coerce01(meeting.needs_catering, 0);
  const catering_tea = needs_catering
    ? req.body?.catering_tea !== undefined
      ? coerce01(req.body.catering_tea, 0)
      : coerce01(meeting.catering_tea, 0)
    : 0;
  const catering_coffee = needs_catering
    ? req.body?.catering_coffee !== undefined
      ? coerce01(req.body.catering_coffee, 0)
      : coerce01(meeting.catering_coffee, 0)
    : 0;
  const catering_sweets = needs_catering
    ? req.body?.catering_sweets !== undefined
      ? coerce01(req.body.catering_sweets, 0)
      : coerce01(meeting.catering_sweets, 0)
    : 0;

  if (!title || !start_at || !end_at) return res.status(400).json({ error: "missing_fields" });
  if (new Date(end_at) <= new Date(start_at)) return res.status(400).json({ error: "invalid_range" });

  const startChanged = start_at !== meeting.start_at;
  db.prepare(
    `UPDATE meetings SET title = ?, body = ?, location = ?, location_key = ?, location_detail = ?,
       start_at = ?, end_at = ?, remind_15 = ?,
       needs_catering = ?, catering_tea = ?, catering_coffee = ?, catering_sweets = ?,
       updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    title,
    body || null,
    location || null,
    location_key || null,
    location_detail || null,
    start_at,
    end_at,
    remind_15,
    needs_catering,
    catering_tea,
    catering_coffee,
    catering_sweets,
    meeting.id
  );

  if (Array.isArray(req.body?.participant_ids)) {
    let ids = req.body.participant_ids.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.includes(Number(meeting.organizer_id))) ids = [Number(meeting.organizer_id), ...ids];
    ids = [...new Set(ids)];
    const existing = participantsFor(meeting.id);
    const existingMap = new Map(existing.map((p) => [Number(p.user_id), p]));
    db.prepare("DELETE FROM meeting_participants WHERE meeting_id = ?").run(meeting.id);
    const insertP = db.prepare(
      `INSERT INTO meeting_participants (meeting_id, user_id, rsvp, reminded_at, invited_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    );
    for (const pid of ids) {
      const prev = existingMap.get(pid);
      const rsvp = prev?.rsvp || (pid === Number(meeting.organizer_id) ? "accepted" : "pending");
      const reminded = startChanged ? null : prev?.reminded_at || null;
      insertP.run(meeting.id, pid, rsvp, reminded);
    }
  } else if (startChanged) {
    db.prepare("UPDATE meeting_participants SET reminded_at = NULL WHERE meeting_id = ?").run(meeting.id);
  }

  if (Array.isArray(req.body?.company_ids)) {
    setMeetingCompanies(meeting.id, req.body.company_ids);
  }

  const updated = getMeeting(meeting.id);
  for (const p of updated.participants) {
    emitToUser(p.user_id, "meeting:invite", { meeting: updated, updated: true });
  }
  notifyCpgChat("meeting:invite", { meeting: updated, updated: true }).catch(() => {});
  res.json({ meeting: updated });
});

app.post("/api/meetings/:id/cancel", authMiddleware, (req, res) => {
  const meeting = getMeeting(req.params.id);
  if (!meeting) return res.status(404).json({ error: "not_found" });
  if (!canCancelMeeting(meeting, req.user.id)) {
    return res.status(403).json({ error: "forbidden", message: "only_creator_can_cancel" });
  }
  db.prepare(
    `UPDATE meetings SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`
  ).run(meeting.id);
  const updated = getMeeting(meeting.id);
  for (const p of updated.participants) {
    emitToUser(p.user_id, "meeting:invite", { meeting: updated, cancelled: true });
  }
  notifyCpgChat("meeting:cancel", { meeting: updated }).catch(() => {});
  res.json({ meeting: updated });
});


app.get("/api/meetings/:id/files", authMiddleware, (req, res) => {
  const meeting = getMeeting(req.params.id);
  if (!meeting || !userCanSee(meeting, req.user.id)) {
    return res.status(404).json({ error: "not_found" });
  }
  res.json({ files: listMeetingFiles(meeting.id) });
});

app.post(
  "/api/meetings/:id/files",
  authMiddleware,
  (req, res, next) => {
    upload.single("file")(req, res, (err) => {
      if (err) {
        const msg = err?.message || "upload_failed";
        const status = msg === "unsupported_file_type" ? 400 : msg.includes("File too large") ? 400 : 400;
        return res.status(status).json({ error: msg });
      }
      next();
    });
  },
  (req, res) => {
    const meeting = getMeeting(req.params.id);
    if (!meeting || !userCanSee(meeting, req.user.id)) {
      if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(404).json({ error: "not_found" });
    }
    if (!req.file) return res.status(400).json({ error: "missing_file" });
    let kind = String(req.query?.kind || req.body?.kind || "attachment").toLowerCase();
    if (kind !== "minutes") kind = "attachment";
    const rel = path.relative(paths.rootDir, req.file.path).replace(/\\/g, "/");
    const result = db
      .prepare(
        `INSERT INTO meeting_files (meeting_id, uploader_id, name, mime, size, path, kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      )
      .run(
        meeting.id,
        Number(req.user.id),
        decodeMulterFilename(req.file.originalname) || req.file.filename,
        req.file.mimetype || null,
        Number(req.file.size || 0),
        rel,
        kind
      );
    const file = getMeetingFile(result.lastInsertRowid);
    res.status(201).json({
      file: {
        id: file.id,
        meeting_id: file.meeting_id,
        uploader_id: file.uploader_id,
        name: file.name,
        mime: file.mime,
        size: file.size,
        kind: file.kind,
        created_at: file.created_at
      }
    });
  }
);

app.get("/api/files/:id", authMiddleware, (req, res) => {
  const file = getMeetingFile(req.params.id);
  if (!file) return res.status(404).json({ error: "not_found" });
  const meeting = getMeeting(file.meeting_id);
  if (!meeting || !userCanSee(meeting, req.user.id)) {
    return res.status(403).json({ error: "forbidden" });
  }
  const abs = path.isAbsolute(file.path) ? file.path : path.join(paths.rootDir, file.path);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: "missing_on_disk" });
  res.setHeader("Content-Disposition", contentDispositionAttachment(file.name));
  res.sendFile(abs);
});

app.delete("/api/files/:id", authMiddleware, (req, res) => {
  const file = getMeetingFile(req.params.id);
  if (!file) return res.status(404).json({ error: "not_found" });
  const meeting = getMeeting(file.meeting_id);
  if (!meeting) return res.status(404).json({ error: "not_found" });
  const uid = Number(req.user.id);
  if (Number(file.uploader_id) !== uid && !canManageMeeting(meeting, uid)) {
    return res.status(403).json({ error: "forbidden" });
  }
  const abs = path.isAbsolute(file.path) ? file.path : path.join(paths.rootDir, file.path);
  db.prepare("DELETE FROM meeting_files WHERE id = ?").run(file.id);
  try { if (fs.existsSync(abs)) fs.unlinkSync(abs); } catch {}
  res.json({ ok: true });
});

app.post("/api/meetings/:id/rsvp", authMiddleware, (req, res) => {
  const meeting = getMeeting(req.params.id);
  if (!meeting || meeting.status === "cancelled") {
    return res.status(404).json({ error: "not_found" });
  }
  const rsvp = String(req.body?.rsvp || "").toLowerCase();
  if (!["accepted", "declined", "maybe", "pending"].includes(rsvp)) {
    return res.status(400).json({ error: "invalid_rsvp" });
  }
  const uid = Number(req.user.id);
  const part = (meeting.participants || []).find((p) => Number(p.user_id) === uid);
  if (!part) return res.status(403).json({ error: "not_participant" });

  db.prepare(`UPDATE meeting_participants SET rsvp = ? WHERE meeting_id = ? AND user_id = ?`).run(
    rsvp,
    meeting.id,
    uid
  );
  const updated = getMeeting(meeting.id);
  emitToUser(meeting.organizer_id, "meeting:invite", { meeting: updated, rsvpFrom: uid });
  res.json({ meeting: updated });
});

app.get("/api/meetings/:id/ics", authMiddleware, (req, res) => {
  const meeting = getMeeting(req.params.id);
  if (!meeting || !userCanSee(meeting, req.user.id)) {
    return res.status(404).json({ error: "not_found" });
  }
  const ics = buildIcs(meeting);
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="meeting-${meeting.id}.ics"`);
  res.send(ics);
});

function runReminderJob() {
  try {
    const now = Date.now();
    const windowStart = new Date(now).toISOString();
    const windowEnd = new Date(now + 15 * 60 * 1000 + 30 * 1000).toISOString();
    // Remind when start is between now and now+15m (approx), once per participant
    const due = db
      .prepare(
        `SELECT m.*, p.user_id AS participant_id, p.rsvp
         FROM meetings m
         JOIN meeting_participants p ON p.meeting_id = m.id
         WHERE m.status = 'scheduled'
           AND p.rsvp != 'declined'
           AND p.reminded_at IS NULL
           AND IFNULL(m.remind_15, 1) = 1
           AND m.start_at > ?
           AND m.start_at <= ?`
      )
      .all(windowStart, windowEnd);

    for (const row of due) {
      const meeting = getMeeting(row.id);
      if (!meeting) continue;
      const minutesLeft = Math.max(0, Math.round((new Date(meeting.start_at).getTime() - now) / 60000));
      const payload = {
        meeting,
        minutesLeft,
        at: nowIso()
      };
      db.prepare(
        `UPDATE meeting_participants SET reminded_at = datetime('now')
         WHERE meeting_id = ? AND user_id = ?`
      ).run(meeting.id, row.participant_id);
      emitToUser(row.participant_id, "meeting:reminder", payload);
      notifyCpgChat("meeting:reminder", { ...payload, userId: row.participant_id }).catch(() => {});
    }
  } catch (err) {
    console.warn("reminder job", err?.message || err);
  }
}

setInterval(runReminderJob, 60 * 1000);
setTimeout(runReminderJob, 5 * 1000);

// Serve the production frontend from the same origin as API and Socket.IO.
const webDist = path.join(paths.rootDir, "web", "dist");
app.use("/api", (_req, res) => res.status(404).json({ error: "not_found" }));
app.use(express.static(webDist));
app.get("*", (_req, res) => res.sendFile(path.join(webDist, "index.html")));

server.listen(PORT, HOST, () => {
  console.log(`Server listening on ${HOST}:${PORT}`);
  console.log(`[CPGMeet] DB ${paths.dbPath}`);
  console.log(`[CPGMeet] CPGChat ${CPGCHAT_API_URL}`);
  console.log(`[CPGMeet] Notify -> ${CPGCHAT_API_URL}/api/internal/cpgmeet/notify`);
  console.log(`[CPGMeet] Web URL ${CPGMEET_WEB_URL}`);
  console.log(`[CPGMeet] JWT_SECRET set=${Boolean(process.env.JWT_SECRET)} (default shared with CPGChat)`);
  console.log(`[CPGMeet] CPGMEET_NOTIFY_SECRET set=${Boolean(process.env.CPGMEET_NOTIFY_SECRET)} (default shared)`);
  void SECRET;
});
