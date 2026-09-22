const fs = require("fs");
const path = require("path");
const root = "D:/Projects/cpgmeet";

function read(p) { return fs.readFileSync(p, "utf8"); }
function write(p, s) { fs.writeFileSync(p, s); console.log("wrote", path.relative(root, p), s.length); }

// ========== db.js: companies catalog ==========
const dbPath = path.join(root, "server", "src", "db.js");
let dbjs = read(dbPath);
if (!dbjs.includes("CREATE TABLE IF NOT EXISTS companies")) {
  const anchor = "// Additive: invited companies (subsidiary orgs)";
  const mig = `// Additive: companies catalog (admin-managed)
(function migrateCompaniesCatalog() {
  db.exec(\`
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
\`);
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

`;
  if (dbjs.includes(anchor)) dbjs = dbjs.replace(anchor, mig + anchor);
  else {
    // insert before meeting_companies migrate
    const a2 = "CREATE TABLE IF NOT EXISTS meeting_companies";
    if (!dbjs.includes(a2)) throw new Error("no meeting_companies");
    dbjs = dbjs.replace("// Additive: invited companies", mig + "// Additive: invited companies");
  }
  write(dbPath, dbjs);
} else console.log("companies catalog migration exists");

// ========== server index.js ==========
const serverPath = path.join(root, "server", "src", "index.js");
let server = read(serverPath);

// Expand requireAdmin
const oldReq = `function requireAdmin(req, res, next) {
  if (String(req.user?.role || "") !== "admin") {
    return res.status(403).json({ error: "forbidden" });
  }
  next();
}`;
const newReq = `function isMeetAdmin(user) {
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
}`;
if (server.includes(oldReq)) server = server.replace(oldReq, newReq);
else if (server.includes(oldReq.replace(/\n/g, "\r\n"))) server = server.replace(oldReq.replace(/\n/g, "\r\n"), newReq.replace(/\n/g, "\r\n"));
else if (!server.includes("isMeetAdmin")) {
  console.error("requireAdmin block not found exactly");
  const i = server.indexOf("function requireAdmin");
  console.error(JSON.stringify(server.slice(i, i + 200)));
  process.exit(1);
}

// Replace hardcoded MEETING_COMPANIES with DB-backed helpers
if (server.includes("const MEETING_COMPANIES = [")) {
  const start = server.indexOf("const MEETING_COMPANIES = [");
  const endMarker = "function normalizeCompanyIds(raw) {";
  const end = server.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error("MEETING_COMPANIES block bounds");
  const replacement = `function listActiveCompanies() {
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
    .replace(/\\s+/g, "_")
    .replace(/[^a-z0-9_\\u0600-\\u06FF-]+/g, "")
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

`;
  // keep normalizeCompanyIds but change to use DB
  server = server.slice(0, start) + replacement + server.slice(end);
}

// Fix normalizeCompanyIds + companiesFor to use DB
const oldNorm = `function normalizeCompanyIds(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const x of raw) {
    const id = String(x || "").trim();
    if (MEETING_COMPANY_IDS.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

function companiesFor(meetingId) {
  const rows = db
    .prepare(
      \`SELECT company_id FROM meeting_companies WHERE meeting_id = ? ORDER BY company_id\`
    )
    .all(Number(meetingId));
  return rows
    .map((r) => MEETING_COMPANIES.find((c) => c.id === r.company_id))
    .filter(Boolean);
}`;

const newNorm = `function normalizeCompanyIds(raw) {
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
}`;

if (server.includes("MEETING_COMPANY_IDS")) {
  // replace old normalize if still present
  if (server.includes("MEETING_COMPANY_IDS.has")) {
    // try LF and CRLF
    let replaced = false;
    for (const [a, b] of [[oldNorm, newNorm], [oldNorm.replace(/\n/g,"\r\n"), newNorm.replace(/\n/g,"\r\n")]]) {
      if (server.includes(a)) { server = server.replace(a, b); replaced = true; break; }
    }
    if (!replaced) {
      // broader: kill MEETING_COMPANY_IDS line remnants
      server = server.replace(/const MEETING_COMPANY_IDS = new Set\([^\n]+\n?/, "");
      console.log("warn: normalize replace soft");
    }
  }
}

// Fix /api/companies route to use listActiveCompanies
server = server.replace(
  'res.json({ companies: MEETING_COMPANIES });',
  'res.json({ companies: listActiveCompanies() });'
);

// Admin company + people proxy routes — insert before delegates admin GET
const delGet = 'app.get("/api/admin/delegates", authMiddleware, requireAdmin, (_req, res) => {';
if (!server.includes("/api/admin/companies") && server.includes(delGet)) {
  const routes = `app.get("/api/admin/companies", authMiddleware, requireAdmin, (_req, res) => {
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

app.get("/api/admin/people", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const upstream = await forwardJson("/api/admin/users", { token: req.token });
    return res.status(upstream.status).json(upstream.data);
  } catch (err) {
    return res.status(502).json({ error: "cpgchat_unreachable", message: String(err?.message || err) });
  }
});

app.post("/api/admin/people", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const upstream = await forwardJson("/api/admin/users", {
      method: "POST",
      token: req.token,
      body: req.body
    });
    return res.status(upstream.status).json(upstream.data);
  } catch (err) {
    return res.status(502).json({ error: "cpgchat_unreachable", message: String(err?.message || err) });
  }
});

app.patch("/api/admin/people/:id", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const upstream = await forwardJson("/api/admin/users/" + encodeURIComponent(req.params.id), {
      method: "PATCH",
      token: req.token,
      body: req.body
    });
    return res.status(upstream.status).json(upstream.data);
  } catch (err) {
    return res.status(502).json({ error: "cpgchat_unreachable", message: String(err?.message || err) });
  }
});

app.delete("/api/admin/people/:id", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const upstream = await forwardJson("/api/admin/users/" + encodeURIComponent(req.params.id), {
      method: "DELETE",
      token: req.token
    });
    return res.status(upstream.status).json(upstream.data);
  } catch (err) {
    return res.status(502).json({ error: "cpgchat_unreachable", message: String(err?.message || err) });
  }
});

app.get("/api/me", authMiddleware, (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    role: req.user.role,
    is_admin: isMeetAdmin(req.user)
  });
});

`;
  server = server.replace(delGet, routes + delGet);
}

// Check forwardJson supports method/body
if (!server.includes("async function forwardJson")) {
  console.log("warn: forwardJson not found by name");
} else {
  const fi = server.indexOf("async function forwardJson");
  console.log("forwardJson snippet", JSON.stringify(server.slice(fi, fi + 350)));
}

write(serverPath, server);
console.log("server done");
