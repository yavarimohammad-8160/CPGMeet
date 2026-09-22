const fs = require("fs");
const path = require("path");

const root = process.cwd();

function read(p) {
  return fs.readFileSync(p, "utf8");
}
function write(p, s) {
  fs.writeFileSync(p, s);
  console.log("wrote", p, s.length);
}

const serverPath = path.join(root, "server", "src", "index.js");
let server = read(serverPath);

if (!server.includes("function decodeMulterFilename")) {
  const insertAfter = "const upload = multer({";
  if (!server.includes(insertAfter)) throw new Error("upload anchor missing");
  const helper = [
    "",
    "function decodeMulterFilename(name) {",
    '  const raw = String(name || "file");',
    "  if (/[\\u0600-\\u06FF]/.test(raw)) return raw;",
    "  try {",
    '    const decoded = Buffer.from(raw, "latin1").toString("utf8");',
    '    if (decoded.includes("\\uFFFD")) return raw;',
    "    if (/[\\u0600-\\u06FF]/.test(decoded)) return decoded;",
    "    if (/[^\\x00-\\x7F]/.test(raw) && decoded !== raw) return decoded;",
    "    return raw;",
    "  } catch {",
    "    return raw;",
    "  }",
    "}",
    "",
    "function contentDispositionAttachment(filename) {",
    '  const fallback = String(filename || "file")',
    "    .replace(/[^\\x20-\\x7E]+/g, \"_\")",
    '    .replace(/["\\\\]/g, "_") || "file";',
    '  const encoded = encodeURIComponent(String(filename || "file")).replace(/[\'()]/g, escape);',
    "  return 'attachment; filename=\"' + fallback + '\"; filename*=UTF-8\\'\\'' + encoded;",
    "}",
    "",
  ].join("\n");
  server = server.replace(insertAfter, helper + insertAfter);
}

const oldSafe = 'const safe = String(file.originalname || "file").replace(/[^a-zA-Z0-9._\\u0600-\\u06FF-]+/g, "_").slice(0, 80);';
const newSafe = 'const safe = String(decodeMulterFilename(file.originalname) || "file").replace(/[^a-zA-Z0-9._\\u0600-\\u06FF-]+/g, "_").slice(0, 80);';
if (server.includes(oldSafe)) server = server.replace(oldSafe, newSafe);

const oldInsertName = "req.file.originalname || req.file.filename,";
const newInsertName = "decodeMulterFilename(req.file.originalname) || req.file.filename,";
if (server.includes(oldInsertName) && !server.includes(newInsertName)) {
  server = server.replace(oldInsertName, newInsertName);
}

const oldDownload = "  res.download(abs, file.name);";
const newDownload = [
  '  res.setHeader("Content-Disposition", contentDispositionAttachment(file.name));',
  "  res.sendFile(abs);",
].join("\n");
if (server.includes(oldDownload)) server = server.replace(oldDownload, newDownload);

write(serverPath, server);

const appPath = path.join(root, "web", "src", "App.jsx");
let app = read(appPath);

if (!app.includes("function displayFileName(")) {
  const marker = "function FileList({ items, title }) {";
  if (!app.includes(marker)) throw new Error("FileList missing");
  const helpers = [
    "",
    "  function displayFileName(name) {",
    '    const s = String(name || "");',
    '    if (!s) return "فایل";',
    "    if (/[\\u0600-\\u06FF]/.test(s)) return s;",
    "    try {",
    "      const bytes = new Uint8Array(s.length);",
    "      for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;",
    '      const decoded = new TextDecoder("utf-8").decode(bytes);',
    '      if (/[\\u0600-\\u06FF]/.test(decoded) && !decoded.includes("\\uFFFD")) return decoded;',
    "    } catch {}",
    "    return s;",
    "  }",
    "",
    "  function fileCoverMeta(name, mime) {",
    '    const n = String(name || "").toLowerCase();',
    '    const m = String(mime || "").toLowerCase();',
    '    if (m.includes("pdf") || n.endsWith(".pdf")) return { label: "PDF", cls: "pdf" };',
    '    if (m.includes("word") || m.includes("msword") || /\\.docx?$/.test(n)) return { label: "Word", cls: "word" };',
    '    if (m.includes("excel") || m.includes("spreadsheet") || /\\.xlsx?$/.test(n)) return { label: "Excel", cls: "excel" };',
    '    if (m.includes("powerpoint") || m.includes("presentation") || /\\.pptx?$/.test(n)) return { label: "PPT", cls: "ppt" };',
    '    if (m.startsWith("image/") || /\\.(jpe?g|png|gif|webp)$/.test(n)) return { label: "IMG", cls: "image" };',
    '    if (m.includes("zip") || m.includes("compressed") || n.endsWith(".zip")) return { label: "ZIP", cls: "zip" };',
    '    if (m.startsWith("text/") || n.endsWith(".txt")) return { label: "TXT", cls: "txt" };',
    '    return { label: "FILE", cls: "generic" };',
    "  }",
    "",
  ].join("\n");
  app = app.replace(marker, helpers + marker);
}

function findFileListBlock(src) {
  const startKey = '<ul className="file-list">';
  const start = src.indexOf(startKey);
  if (start < 0) return null;
  // only the first FileList (attachments/minutes share same component body once)
  const endKey = "</ul>";
  const end = src.indexOf(endKey, start);
  if (end < 0) return null;
  return { start, end: end + endKey.length, text: src.slice(start, end + endKey.length) };
}

if (!app.includes("file-card-main")) {
  const block = findFileListBlock(app);
  if (!block) {
    console.error("file-list block missing");
    process.exit(1);
  }
  const newList = [
    '<ul className="file-list">',
    "            {items.map((f) => {",
    "              const shown = displayFileName(f.name);",
    "              const cover = fileCoverMeta(shown, f.mime);",
    "              return (",
    '                <li key={f.id} className="file-card">',
    "                  <button",
    '                    type="button"',
    '                    className="file-card-main"',
    "                    onClick={() => downloadMeetingFile(f.id, shown)}",
    "                    title={shown}",
    "                  >",
    "                    <span className={`file-cover file-cover-${cover.cls}`} aria-hidden=\"true\">",
    '                      <span className="file-cover-label">{cover.label}</span>',
    "                    </span>",
    '                    <span className="file-card-meta">',
    '                      <span className="file-card-name">{shown}</span>',
    '                      <span className="muted file-card-size">{toFaDigits(Math.round((f.size || 0) / 1024))} کیلوبایت</span>',
    "                    </span>",
    "                  </button>",
    "                  {Number(f.uploader_id) === Number(user.id) || canManage ? (",
    '                    <button type="button" className="btn ghost file-card-delete" disabled={busy} onClick={() => onDelete(f.id)}>',
    "                      حذف",
    "                    </button>",
    "                  ) : null}",
    "                </li>",
    "              );",
    "            })}",
    "          </ul>",
  ].join("\n");
  // Detect line ending of original
  const nl = block.text.includes("\r\n") ? "\r\n" : "\n";
  const replacement = newList.replace(/\n/g, nl);
  app = app.slice(0, block.start) + replacement + app.slice(block.end);
}

write(appPath, app);

const cssPath = path.join(root, "web", "src", "styles.css");
let css = read(cssPath);
if (!css.includes(".file-cover")) {
  css += `

/* Meeting attachment cards with type covers */
.file-list li.file-card {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.55rem 0.25rem;
  border-bottom: 1px solid #eee;
}
.file-card-main {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex: 1;
  min-width: 0;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  text-align: start;
  font: inherit;
  color: inherit;
}
.file-card-main:hover .file-card-name {
  color: #0f6cbd;
}
.file-cover {
  width: 44px;
  height: 52px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  box-shadow: 0 1px 3px rgba(0,0,0,0.12);
  position: relative;
  color: #fff;
  font-weight: 800;
  font-size: 11px;
  letter-spacing: 0.02em;
}
.file-cover::before {
  content: "";
  position: absolute;
  top: 0;
  inset-inline-end: 0;
  width: 12px;
  height: 12px;
  background: linear-gradient(135deg, rgba(255,255,255,0.55) 50%, transparent 50%);
  border-radius: 0 6px 0 0;
}
.file-cover-label {
  position: relative;
  z-index: 1;
  padding: 0 2px;
  text-align: center;
  line-height: 1.1;
}
.file-cover-pdf { background: linear-gradient(160deg, #e53935, #b71c1c); }
.file-cover-word { background: linear-gradient(160deg, #2b579a, #1a365d); }
.file-cover-excel { background: linear-gradient(160deg, #217346, #0f5132); }
.file-cover-ppt { background: linear-gradient(160deg, #c43e1c, #8b2500); }
.file-cover-image { background: linear-gradient(160deg, #7b1fa2, #4a148c); }
.file-cover-zip { background: linear-gradient(160deg, #6d4c41, #3e2723); }
.file-cover-txt { background: linear-gradient(160deg, #607d8b, #37474f); }
.file-cover-generic { background: linear-gradient(160deg, #546e7a, #263238); }
.file-card-meta {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}
.file-card-name {
  font-weight: 600;
  color: #242424;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
  direction: rtl;
  text-align: right;
  unicode-bidi: plaintext;
}
.file-card-size { font-size: 0.85rem; }
.file-card-delete { flex-shrink: 0; }
`;
  write(cssPath, css);
} else {
  console.log("css already has file-cover");
}

async function repairDbNames() {
  const dbPath = path.join(root, "data", "cpgmeet.db");
  if (!fs.existsSync(dbPath)) {
    console.log("no db at", dbPath);
    return;
  }
  const initSqlJs = require(path.join(root, "server", "node_modules", "sql.js"));
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(root, "server", "node_modules", "sql.js", "dist", file)
  });
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const res = db.exec("SELECT id, name FROM meeting_files");
  let fixed = 0;
  if (res[0]) {
    const cols = res[0].columns;
    const idIdx = cols.indexOf("id");
    const nameIdx = cols.indexOf("name");
    for (const row of res[0].values) {
      const id = row[idIdx];
      const raw = String(row[nameIdx] || "");
      if (/[\u0600-\u06FF]/.test(raw)) continue;
      try {
        const decoded = Buffer.from(raw, "latin1").toString("utf8");
        if (/[\u0600-\u06FF]/.test(decoded) && !decoded.includes("\uFFFD") && decoded !== raw) {
          const stmt = db.prepare("UPDATE meeting_files SET name = ? WHERE id = ?");
          stmt.run([decoded, id]);
          stmt.free();
          fixed += 1;
          console.log("repaired", id, "->", decoded);
        }
      } catch (e) {
        console.log("skip", id, e.message);
      }
    }
  }
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
  db.close();
  console.log("db repaired", fixed);
}

repairDbNames()
  .then(() => console.log("done"))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
