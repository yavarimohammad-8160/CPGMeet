import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
const dbPath = process.env.DB_PATH || path.join(rootDir, "data", "cpgmeet.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const SQL = await initSqlJs({
  locateFile: (file) => path.join(path.dirname(require.resolve("sql.js")), file)
});

const raw = fs.existsSync(dbPath)
  ? new SQL.Database(fs.readFileSync(dbPath))
  : new SQL.Database();

function persist() {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, Buffer.from(raw.export()));
}

function coerceValue(v) {
  if (typeof v === "bigint") return Number(v);
  return v;
}

function coerceRow(row) {
  if (!row) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = coerceValue(v);
  return out;
}

function sanitizeBindValue(v) {
  if (v === undefined) return null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

function normalizeParams(args) {
  if (!args.length) return null;
  if (args.length === 1 && Array.isArray(args[0])) {
    return args[0].map(sanitizeBindValue);
  }
  const first = args[0];
  if (
    first &&
    typeof first === "object" &&
    !Array.isArray(first) &&
    !(first instanceof Date) &&
    !Buffer.isBuffer(first)
  ) {
    const mapped = {};
    for (const [k, v] of Object.entries(first)) {
      const key = /^[@:$]/.test(k) ? k : `@${k}`;
      mapped[key] = sanitizeBindValue(v);
    }
    return mapped;
  }
  return args.map(sanitizeBindValue);
}

function bindStmt(stmt, params) {
  if (params == null) return;
  if (Array.isArray(params)) {
    if (params.length) stmt.bind(params);
    return;
  }
  if (Object.keys(params).length) stmt.bind(params);
}

function scalar(sql) {
  const result = raw.exec(sql);
  const v = result[0]?.values?.[0]?.[0];
  return coerceValue(v ?? 0);
}

function prepare(sql) {
  return {
    get(...args) {
      const stmt = raw.prepare(sql);
      try {
        bindStmt(stmt, normalizeParams(args));
        return stmt.step() ? coerceRow(stmt.getAsObject()) : undefined;
      } finally {
        stmt.free();
      }
    },
    all(...args) {
      const stmt = raw.prepare(sql);
      try {
        bindStmt(stmt, normalizeParams(args));
        const rows = [];
        while (stmt.step()) rows.push(coerceRow(stmt.getAsObject()));
        return rows;
      } finally {
        stmt.free();
      }
    },
    run(...args) {
      const stmt = raw.prepare(sql);
      try {
        bindStmt(stmt, normalizeParams(args));
        stmt.step();
      } finally {
        stmt.free();
      }
      const lastInsertRowid = Number(scalar("SELECT last_insert_rowid()"));
      const changes = Number(scalar("SELECT changes()"));
      persist();
      return { lastInsertRowid, changes };
    }
  };
}

export const db = {
  prepare,
  exec(sql) {
    raw.exec(sql);
    persist();
  },
  pragma() {}
};

export const paths = { dbPath, rootDir };

export function flushDb() {
  persist();
  return dbPath;
}

db.exec(`
CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT,
  location TEXT,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  organizer_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS meeting_participants (
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  rsvp TEXT NOT NULL DEFAULT 'pending' CHECK (rsvp IN ('pending','accepted','declined','maybe')),
  reminded_at TEXT,
  invited_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (meeting_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_meetings_start_at ON meetings(start_at);
CREATE INDEX IF NOT EXISTS idx_participants_user ON meeting_participants(user_id);
`);

// Additive migrations: created_by_id + meeting_delegates (Outlook-style on-behalf)
(function migrateDelegates() {
  const cols = db.prepare("PRAGMA table_info(meetings)").all();
  const hasCreatedBy = cols.some((c) => c.name === "created_by_id");
  if (!hasCreatedBy) {
    db.exec("ALTER TABLE meetings ADD COLUMN created_by_id INTEGER");
    db.exec("UPDATE meetings SET created_by_id = organizer_id WHERE created_by_id IS NULL");
  }
  db.exec(`
CREATE TABLE IF NOT EXISTS meeting_delegates (
  principal_id INTEGER NOT NULL,
  assistant_id INTEGER NOT NULL,
  PRIMARY KEY (principal_id, assistant_id)
);
CREATE INDEX IF NOT EXISTS idx_delegates_assistant ON meeting_delegates(assistant_id);
`);
})();

// Additive: remind_15 checkbox (15 min before start)
(function migrateRemind15() {
  const cols = db.prepare("PRAGMA table_info(meetings)").all();
  const hasRemind = cols.some((c) => c.name === "remind_15");
  if (!hasRemind) {
    db.exec("ALTER TABLE meetings ADD COLUMN remind_15 INTEGER NOT NULL DEFAULT 1");
  }
})();


// Additive: location_key/detail + catering flags
(function migrateLocationCatering() {
  const cols = db.prepare("PRAGMA table_info(meetings)").all();
  const names = new Set(cols.map((c) => c.name));
  const add = (name, sql) => {
    if (!names.has(name)) db.exec(sql);
  };
  add("location_key", "ALTER TABLE meetings ADD COLUMN location_key TEXT");
  add("location_detail", "ALTER TABLE meetings ADD COLUMN location_detail TEXT");
  add("needs_catering", "ALTER TABLE meetings ADD COLUMN needs_catering INTEGER NOT NULL DEFAULT 0");
  add("catering_tea", "ALTER TABLE meetings ADD COLUMN catering_tea INTEGER NOT NULL DEFAULT 0");
  add("catering_coffee", "ALTER TABLE meetings ADD COLUMN catering_coffee INTEGER NOT NULL DEFAULT 0");
  add("catering_sweets", "ALTER TABLE meetings ADD COLUMN catering_sweets INTEGER NOT NULL DEFAULT 0");
})();

// Additive: companies catalog (admin-managed)
(function migrateCompaniesCatalog() {
  db.exec(`
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
  const count = db.prepare("SELECT COUNT(*) AS n FROM companies").get();
  if (!count || Number(count.n) === 0) {
    const ins = db.prepare("INSERT INTO companies (id, name, active) VALUES (?, ?, 1)");
    [
      ["arzesh_afarinan", "ارزش آفرینان"],
      ["sarir_logistics", "سریر لجستیک"],
      ["napco", "ناپکو"]
    ].forEach(([id, name]) => ins.run(id, name));
  }
})();

// Additive: invited companies (subsidiary orgs)
(function migrateMeetingCompanies() {
  db.exec(`
CREATE TABLE IF NOT EXISTS meeting_companies (
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL,
  PRIMARY KEY (meeting_id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_meeting_companies_meeting ON meeting_companies(meeting_id);
`);
})();

// Additive: meeting file attachments / minutes
(function migrateMeetingFiles() {
  db.exec(`
CREATE TABLE IF NOT EXISTS meeting_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  uploader_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  mime TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'attachment' CHECK (kind IN ('attachment','minutes')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_meeting_files_meeting ON meeting_files(meeting_id);
`);
})();
