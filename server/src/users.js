import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function hashPassword(password) {
  return bcrypt.hashSync(String(password || ""), 10);
}

export function verifyPassword(password, hash) {
  if (!hash) return false;
  try {
    return bcrypt.compareSync(String(password || ""), String(hash));
  } catch {
    return false;
  }
}

export function publicUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: String(row.name || ""),
    email: String(row.email || ""),
    role: String(row.role || "user"),
    active: Number(row.active) ? 1 : 0
  };
}

export function ensureMeetUsers(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS meet_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_meet_users_email ON meet_users(email);
`);

  let seededAdmin = false;
  const adminEmail = "m.yavari@cpg-pars.com";
  const admin = db.prepare("SELECT id, role FROM meet_users WHERE lower(email) = ?").get(adminEmail);
  if (!admin) {
    const adminPassword = process.env.MEET_ADMIN_PASSWORD || "MeetAdmin1405!";
    const hash = hashPassword(adminPassword);
    db.prepare(
      `INSERT INTO meet_users (name, email, password_hash, role, active)
       VALUES (?, ?, ?, 'admin', 1)`
    ).run("محمد یاوری", adminEmail, hash);
    seededAdmin = true;
  } else if (String(admin.role) !== "admin") {
    db.prepare("UPDATE meet_users SET role = 'admin', updated_at = datetime('now') WHERE id = ?").run(admin.id);
  }

  let seededPeopleCount = 0;
  const seedPath = path.join(__dirname, "..", "seed-people.json");
  if (fs.existsSync(seedPath)) {
    let people = [];
    try {
      people = JSON.parse(fs.readFileSync(seedPath, "utf8"));
    } catch (err) {
      console.error("[CPGMeet] Failed to parse seed-people.json:", err?.message || err);
      people = [];
    }
    if (Array.isArray(people)) {
      const userPassword = process.env.MEET_USER_TEMP_PASSWORD || "ChangeMe1405!";
      const insert = db.prepare(
        `INSERT INTO meet_users (name, email, password_hash, role, active)
         VALUES (?, ?, ?, 'user', 1)`
      );
      const find = db.prepare("SELECT id FROM meet_users WHERE lower(email) = ?");
      for (const entry of people) {
        const email = String(entry?.email || "").trim().toLowerCase();
        const name = String(entry?.name || "").trim();
        if (!email || !name) continue;
        const existing = find.get(email);
        if (existing) continue;
        insert.run(name, email, hashPassword(userPassword));
        seededPeopleCount += 1;
      }
    }
  }

  return { seededAdmin, seededPeopleCount };
}

export function listActiveUsers(db) {
  return db
    .prepare(
      `SELECT id, name, email, role, active FROM meet_users
       WHERE active = 1 ORDER BY name COLLATE NOCASE`
    )
    .all()
    .map(publicUser);
}

export function listAllUsers(db) {
  return db
    .prepare(
      `SELECT id, name, email, role, active, created_at, updated_at FROM meet_users
       ORDER BY name COLLATE NOCASE`
    )
    .all()
    .map((r) => ({ ...publicUser(r), created_at: r.created_at, updated_at: r.updated_at }));
}

export function findUserByEmail(db, email) {
  return db
    .prepare("SELECT * FROM meet_users WHERE lower(email) = ?")
    .get(String(email || "").trim().toLowerCase());
}

export function findUserById(db, id) {
  return db.prepare("SELECT * FROM meet_users WHERE id = ?").get(Number(id));
}
