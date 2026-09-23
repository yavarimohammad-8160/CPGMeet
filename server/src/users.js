import bcrypt from "bcryptjs";

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
  const count = db.prepare("SELECT COUNT(*) AS n FROM meet_users").get();
  if (!count || Number(count.n) === 0) {
    const hash = hashPassword("MeetAdmin1405!");
    db.prepare(
      `INSERT INTO meet_users (name, email, password_hash, role, active)
       VALUES (?, ?, ?, 'admin', 1)`
    ).run("محمد یاوری", "m.yavari@cpg-pars.com", hash);
    return { seededAdmin: true, email: "m.yavari@cpg-pars.com", tempPassword: "MeetAdmin1405!" };
  }
  // Ensure known admin email is admin if present
  const admin = db.prepare("SELECT id, role FROM meet_users WHERE lower(email) = ?").get("m.yavari@cpg-pars.com");
  if (admin && String(admin.role) !== "admin") {
    db.prepare("UPDATE meet_users SET role = 'admin', updated_at = datetime('now') WHERE id = ?").run(admin.id);
  }
  return { seededAdmin: false };
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
