const fs = require("fs");
const path = require("path");
const root = process.cwd();

function read(p) { return fs.readFileSync(p, "utf8"); }
function write(p, s) { fs.writeFileSync(p, s); console.log("wrote", p); }

// ---- db migration ----
const dbPath = path.join(root, "server", "src", "db.js");
let dbjs = read(dbPath);
if (!dbjs.includes("meeting_companies")) {
  const anchor = "// Additive: meeting file attachments / minutes";
  if (!dbjs.includes(anchor)) throw new Error("db migrate anchor missing");
  const mig = `// Additive: invited companies (subsidiary orgs)
(function migrateMeetingCompanies() {
  db.exec(\`
CREATE TABLE IF NOT EXISTS meeting_companies (
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL,
  PRIMARY KEY (meeting_id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_meeting_companies_meeting ON meeting_companies(meeting_id);
\`);
})();

`;
  dbjs = dbjs.replace(anchor, mig + anchor);
  write(dbPath, dbjs);
} else console.log("db already has meeting_companies");

// ---- server helpers + API ----
const serverPath = path.join(root, "server", "src", "index.js");
let server = read(serverPath);

if (!server.includes("MEETING_COMPANIES")) {
  const insertAfter = "function participantsFor(meetingId) {";
  if (!server.includes(insertAfter)) throw new Error("participantsFor missing");
  const block = `const MEETING_COMPANIES = [
  { id: "arzesh_afarinan", name: "ارزش آفرینان" },
  { id: "sarir_logistics", name: "سریر لجستیک" },
  { id: "napco", name: "ناپکو" }
];
const MEETING_COMPANY_IDS = new Set(MEETING_COMPANIES.map((c) => c.id));

function normalizeCompanyIds(raw) {
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

`;
  server = server.replace(insertAfter, block + insertAfter);
}

// presentMeeting: add companies
if (!server.includes("companies: meeting.companies")) {
  const oldPart = "participants: meeting.participants || participantsFor(meeting.id)\n  };";
  const newPart = "participants: meeting.participants || participantsFor(meeting.id),\n    companies: meeting.companies || companiesFor(meeting.id)\n  };";
  if (!server.includes(oldPart)) {
    // try CRLF
    const oldC = oldPart.replace(/\n/g, "\r\n");
    const newC = newPart.replace(/\n/g, "\r\n");
    if (server.includes(oldC)) server = server.replace(oldC, newC);
    else throw new Error("presentMeeting participants line missing");
  } else server = server.replace(oldPart, newPart);
}

// getMeeting include companies
if (!server.includes("companies: companiesFor(meeting.id)")) {
  const gOld = "return presentMeeting({ ...meeting, participants: participantsFor(meeting.id) });";
  const gNew = "return presentMeeting({ ...meeting, participants: participantsFor(meeting.id), companies: companiesFor(meeting.id) });";
  if (server.includes(gOld)) server = server.replace(gOld, gNew);
  // also list meetings map may only use participantsFor - getMeeting is enough if list uses getMeeting pattern
}

// list meetings: rows.map presentMeeting with participants - need companies too
const listOld = "const meetings = rows.map((m) => presentMeeting({ ...m, participants: participantsFor(m.id) }));";
const listNew = "const meetings = rows.map((m) => presentMeeting({ ...m, participants: participantsFor(m.id), companies: companiesFor(m.id) }));";
if (server.includes(listOld)) server = server.replace(listOld, listNew);

// CREATE: after participant insert, set companies
if (!server.includes("setMeetingCompanies(meetingId")) {
  const afterCreate = `  for (const pid of participantIds) {
    const rsvp = pid === organizerId || pid === createdById ? "accepted" : "pending";
    insertP.run(meetingId, pid, rsvp);
  }

  const meeting = getMeeting(meetingId);`;
  const withCompanies = `  for (const pid of participantIds) {
    const rsvp = pid === organizerId || pid === createdById ? "accepted" : "pending";
    insertP.run(meetingId, pid, rsvp);
  }

  setMeetingCompanies(meetingId, req.body?.company_ids);

  const meeting = getMeeting(meetingId);`;
  if (server.includes(afterCreate)) server = server.replace(afterCreate, withCompanies);
  else {
    const afterC = afterCreate.replace(/\n/g, "\r\n");
    const withC = withCompanies.replace(/\n/g, "\r\n");
    if (server.includes(afterC)) server = server.replace(afterC, withC);
    else throw new Error("create meeting insert block missing");
  }
}

// PATCH: after participant_ids block, handle company_ids
if (!server.includes("req.body?.company_ids")) {
  // add after the participant sync closing, before `const updated = getMeeting`
  const patchAnchor = "  const updated = getMeeting(meeting.id);\n  for (const p of updated.participants) {\n    emitToUser(p.user_id, \"meeting:invite\", { meeting: updated, updated: true });";
  const patchInsert = `  if (Array.isArray(req.body?.company_ids)) {
    setMeetingCompanies(meeting.id, req.body.company_ids);
  }

  const updated = getMeeting(meeting.id);
  for (const p of updated.participants) {
    emitToUser(p.user_id, "meeting:invite", { meeting: updated, updated: true });`;
  if (server.includes(patchAnchor)) server = server.replace(patchAnchor, patchInsert);
  else {
    const a = patchAnchor.replace(/\n/g, "\r\n");
    const b = patchInsert.replace(/\n/g, "\r\n");
    if (server.includes(a)) server = server.replace(a, b);
    else throw new Error("patch updated anchor missing");
  }
}

// API list companies
if (!server.includes('app.get("/api/companies"')) {
  const usersRoute = 'app.get("/api/users"';
  // find a good place - after auth helpers, before meetings list - use first app.get meetings
  const meetList = 'app.get("/api/meetings"';
  if (!server.includes(meetList)) throw new Error("meetings route missing");
  const route = `app.get("/api/companies", authMiddleware, (_req, res) => {
  res.json({ companies: MEETING_COMPANIES });
});

`;
  server = server.replace(meetList, route + meetList);
}

write(serverPath, server);

// ---- App.jsx ----
const appPath = path.join(root, "web", "src", "App.jsx");
let app = read(appPath);

if (!app.includes("MEETING_COMPANIES")) {
  // insert near top after imports / constants - find LOCATION or similar
  const loc = "const LOCATION_OPTIONS";
  const idx = app.indexOf(loc);
  if (idx < 0) {
    // try after QUICK or first const
    const marker = "function MeetingForm(";
    if (!app.includes(marker)) throw new Error("MeetingForm missing");
    app = app.replace(
      marker,
      `const MEETING_COMPANIES = [
  { id: "arzesh_afarinan", name: "ارزش آفرینان" },
  { id: "sarir_logistics", name: "سریر لجستیک" },
  { id: "napco", name: "ناپکو" }
];

` + marker
    );
  } else {
    app = app.slice(0, idx) + `const MEETING_COMPANIES = [
  { id: "arzesh_afarinan", name: "ارزش آفرینان" },
  { id: "sarir_logistics", name: "سریر لجستیک" },
  { id: "napco", name: "ناپکو" }
];

` + app.slice(idx);
  }
}

// state for companies in MeetingForm
if (!app.includes("selectedCompanies")) {
  const selState = `  const [selected, setSelected] = useState(
    () =>
      initial?.participants?.map((p) => Number(p.user_id)) ||
      (selfId ? [selfId] : [])
  );`;
  const withCo = `  const [selected, setSelected] = useState(
    () =>
      initial?.participants?.map((p) => Number(p.user_id)) ||
      (selfId ? [selfId] : [])
  );
  const [selectedCompanies, setSelectedCompanies] = useState(() =>
    (initial?.companies || []).map((c) => c.id || c.company_id).filter(Boolean)
  );
  const [companyPickerOpen, setCompanyPickerOpen] = useState(false);
  const [companyQuery, setCompanyQuery] = useState("");`;
  if (app.includes(selState)) app = app.replace(selState, withCo);
  else {
    const a = selState.replace(/\n/g, "\r\n");
    const b = withCo.replace(/\n/g, "\r\n");
    if (app.includes(a)) app = app.replace(a, b);
    else throw new Error("selected state missing");
  }
}

if (!app.includes("toggleCompany")) {
  const afterRemove = `  function removeUser(id) {
    setSelected((prev) => prev.filter((x) => x !== id));
  }`;
  const extra = `  function removeUser(id) {
    setSelected((prev) => prev.filter((x) => x !== id));
  }

  const selectedCompanyObjs = useMemo(
    () =>
      selectedCompanies
        .map((id) => MEETING_COMPANIES.find((c) => c.id === id))
        .filter(Boolean),
    [selectedCompanies]
  );

  const filteredCompanies = useMemo(() => {
    const q = companyQuery.trim().toLowerCase();
    if (!q) return MEETING_COMPANIES;
    return MEETING_COMPANIES.filter((c) => String(c.name || "").toLowerCase().includes(q));
  }, [companyQuery]);

  function toggleCompany(id) {
    setSelectedCompanies((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }
  function removeCompany(id) {
    setSelectedCompanies((prev) => prev.filter((x) => x !== id));
  }`;
  if (app.includes(afterRemove)) app = app.replace(afterRemove, extra);
  else {
    const a = afterRemove.replace(/\n/g, "\r\n");
    const b = extra.replace(/\n/g, "\r\n");
    if (app.includes(a)) app = app.replace(a, b);
    else throw new Error("removeUser missing");
  }
}

// payload company_ids
if (!app.includes("company_ids: selectedCompanies")) {
  const pay = "        participant_ids: selected,";
  const pay2 = "        participant_ids: selected,\n        company_ids: selectedCompanies,";
  if (app.includes(pay) && !app.includes("company_ids:")) {
    app = app.replace(pay, pay2);
  } else if (!app.includes("company_ids: selectedCompanies")) {
    const p = pay.replace(/\n/g, "\r\n");
    const p2 = pay2.replace(/\n/g, "\r\n");
    if (app.includes(p)) app = app.replace(p, p2);
    else throw new Error("participant_ids payload missing");
  }
}

// UI block after attendees section - find closing of compose-attendees div
if (!app.includes("compose-companies")) {
  const endAttendees = `          ) : null}
        </div>
      </div>
`;
  // This pattern may appear multiple times - find after "افزودن افراد" section uniquely
  const marker = '{pickerOpen ? "بستن فهرست افراد" : "افزودن افراد"}';
  const mi = app.indexOf(marker);
  if (mi < 0) throw new Error("people button missing");
  // find the compose-attendees closing after this marker: after pickerOpen block ends
  // Search for the structure end - next compose-row after attendees
  const afterPeople = app.indexOf("compose-attendees compose-row", 0);
  // Find end of this section: look for next compose-row that is NOT attendees
  const searchFrom = mi;
  const closePattern = `          ) : null}
        </div>
      </div>`;
  let closeAt = app.indexOf(closePattern, searchFrom);
  if (closeAt < 0) {
    const cp = closePattern.replace(/\n/g, "\r\n");
    closeAt = app.indexOf(cp, searchFrom);
    if (closeAt < 0) throw new Error("attendees close missing");
    const insertAt = closeAt + cp.length;
    const companiesUi = `
      <div className="compose-attendees compose-row compose-companies">
        <span className="compose-label">شرکت‌ها</span>
        <div className="compose-attendees-body">
          <button
            type="button"
            className="compose-add-people-btn"
            onClick={() => setCompanyPickerOpen((o) => !o)}
          >
            <span className="compose-add-people-icon" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 7V3H2v18h20V7H12zM6 19H4v-2h2v2zm0-4H4v-2h2v2zm0-4H4V9h2v2zm0-4H4V5h2v2zm4 12H8v-2h2v2zm0-4H8v-2h2v2zm0-4H8V9h2v2zm0-4H8V5h2v2zm10 12h-8v-2h2v-2h-2v-2h2v-2h-2V9h8v10zm-2-8h-2v2h2v-2zm0 4h-2v2h2v-2z" />
              </svg>
            </span>
            {companyPickerOpen ? "بستن فهرست شرکت‌ها" : "افزودن شرکت"}
          </button>
          <div className="compose-chips">
            {selectedCompanyObjs.map((c) => (
              <span className="compose-chip compose-chip-company" key={c.id}>
                <span className="compose-chip-text">{c.name}</span>
                <button
                  type="button"
                  className="compose-chip-remove"
                  onClick={() => removeCompany(c.id)}
                  aria-label={\`حذف \${c.name}\`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          {companyPickerOpen ? (
            <div className="compose-picker">
              <input
                className="compose-picker-search"
                type="search"
                value={companyQuery}
                onChange={(e) => setCompanyQuery(e.target.value)}
                placeholder="جستجوی نام شرکت…"
                dir="auto"
              />
              <div className="compose-picker-list">
                {filteredCompanies.length === 0 ? (
                  <p className="muted">نتیجه‌ای نیست.</p>
                ) : (
                  filteredCompanies.map((c) => (
                    <label key={c.id} className="compose-picker-item">
                      <input
                        type="checkbox"
                        checked={selectedCompanies.includes(c.id)}
                        onChange={() => toggleCompany(c.id)}
                      />
                      <span className="compose-picker-name">{c.name}</span>
                    </label>
                  ))
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
`.replace(/\n/g, "\r\n");
    app = app.slice(0, insertAt) + companiesUi + app.slice(insertAt);
  } else {
    const insertAt = closeAt + closePattern.length;
    const companiesUi = `
      <div className="compose-attendees compose-row compose-companies">
        <span className="compose-label">شرکت‌ها</span>
        <div className="compose-attendees-body">
          <button
            type="button"
            className="compose-add-people-btn"
            onClick={() => setCompanyPickerOpen((o) => !o)}
          >
            <span className="compose-add-people-icon" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 7V3H2v18h20V7H12zM6 19H4v-2h2v2zm0-4H4v-2h2v2zm0-4H4V9h2v2zm0-4H4V5h2v2zm4 12H8v-2h2v2zm0-4H8v-2h2v2zm0-4H8V9h2v2zm0-4H8V5h2v2zm10 12h-8v-2h2v-2h-2v-2h2v-2h-2V9h8v10zm-2-8h-2v2h2v-2zm0 4h-2v2h2v-2z" />
              </svg>
            </span>
            {companyPickerOpen ? "بستن فهرست شرکت‌ها" : "افزودن شرکت"}
          </button>
          <div className="compose-chips">
            {selectedCompanyObjs.map((c) => (
              <span className="compose-chip compose-chip-company" key={c.id}>
                <span className="compose-chip-text">{c.name}</span>
                <button
                  type="button"
                  className="compose-chip-remove"
                  onClick={() => removeCompany(c.id)}
                  aria-label={\`حذف \${c.name}\`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          {companyPickerOpen ? (
            <div className="compose-picker">
              <input
                className="compose-picker-search"
                type="search"
                value={companyQuery}
                onChange={(e) => setCompanyQuery(e.target.value)}
                placeholder="جستجوی نام شرکت…"
                dir="auto"
              />
              <div className="compose-picker-list">
                {filteredCompanies.length === 0 ? (
                  <p className="muted">نتیجه‌ای نیست.</p>
                ) : (
                  filteredCompanies.map((c) => (
                    <label key={c.id} className="compose-picker-item">
                      <input
                        type="checkbox"
                        checked={selectedCompanies.includes(c.id)}
                        onChange={() => toggleCompany(c.id)}
                      />
                      <span className="compose-picker-name">{c.name}</span>
                    </label>
                  ))
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
`;
    app = app.slice(0, insertAt) + companiesUi + app.slice(insertAt);
  }
}

// Detail view: companies after participants
if (!app.includes("شرکت‌های دعوت‌شده") && !app.includes(">شرکت‌ها</dt>")) {
  const partDd = `              <dt>شرکت‌کنندگان</dt>
              <dd>
                {(selected.participants || []).map((p) => {
                  const u = users.find((x) => Number(x.id) === Number(p.user_id));
                  return (
                    <div key={p.user_id}>
                      {u?.name || u?.email || \`کاربر #\${p.user_id}\`}{" "}
                      <span className={\`badge \${p.rsvp}\`}>{rsvpLabel(p.rsvp)}</span>
                    </div>
                  );
                })}
              </dd>`;
  // simpler insert after participants dd closing
  const simple = `<dt>شرکت‌کنندگان</dt>`;
  const si = app.lastIndexOf(simple);
  if (si < 0) throw new Error("detail participants missing");
  const ddEnd = app.indexOf("</dd>", app.indexOf("<dd>", si));
  if (ddEnd < 0) throw new Error("dd end missing");
  const insertAt = ddEnd + 5;
  const companiesDetail = `
              <dt>شرکت‌ها</dt>
              <dd>
                {(selected.companies || []).length === 0 ? (
                  <span className="muted">—</span>
                ) : (
                  (selected.companies || []).map((c) => (
                    <div key={c.id || c.company_id}>{c.name || c.id}</div>
                  ))
                )}
              </dd>`;
  const nl = app.includes("\r\n") ? "\r\n" : "\n";
  app = app.slice(0, insertAt) + companiesDetail.replace(/\n/g, nl) + app.slice(insertAt);
}

write(appPath, app);

// CSS chip company tint
const cssPath = path.join(root, "web", "src", "styles.css");
let css = read(cssPath);
if (!css.includes("compose-chip-company")) {
  css += `

.compose-chip-company {
  background: #e8f4ea;
  border-color: #a7d7b0;
}
.compose-companies .compose-add-people-btn {
  background: #f3f9f4;
}
`;
  write(cssPath, css);
}

console.log("done");
