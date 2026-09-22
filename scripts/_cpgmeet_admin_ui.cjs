const fs = require("fs");
const appPath = "web/src/App.jsx";
let app = fs.readFileSync(appPath, "utf8");
const nl = app.includes("\r\n") ? "\r\n" : "\n";

function ensure(label, cond) {
  if (!cond) {
    console.error("FAIL", label);
    process.exit(1);
  }
}

// helper isMeetAdminClient near top after MEETING_COMPANIES or replace MEETING_COMPANIES usage
if (!app.includes("function isMeetAdminClient")) {
  const insertAt = app.indexOf("const MEETING_COMPANIES");
  ensure("MEETING_COMPANIES", insertAt >= 0);
  const helper =
    `function isMeetAdminClient(user) {
  if (!user) return false;
  if (String(user.role || "") === "admin") return true;
  return String(user.email || "").trim().toLowerCase() === "m.yavari@cpg-pars.com";
}

`;
  app = app.slice(0, insertAt) + helper + app.slice(insertAt);
}

// MeetingForm: accept companies prop, use instead of MEETING_COMPANIES constant for picker
if (!app.includes("function MeetingForm({ users, principals, currentUser, initial, onSave, onCancel, busy, companies")) {
  app = app.replace(
    "function MeetingForm({ users, principals, currentUser, initial, onSave, onCancel, busy }) {",
    "function MeetingForm({ users, principals, currentUser, initial, onSave, onCancel, busy, companies = [] }) {"
  );
}

// Replace MEETING_COMPANIES references inside MeetingForm helpers with `companies`
app = app.replace(
  /selectedCompanies\s*\n\s*\.map\(\(id\) => MEETING_COMPANIES\.find\(\(c\) => c\.id === id\)\)/g,
  "selectedCompanies\n        .map((id) => companies.find((c) => c.id === id))"
);
// also single-line variants
app = app.replace(
  ".map((id) => MEETING_COMPANIES.find((c) => c.id === id))",
  ".map((id) => companies.find((c) => c.id === id))"
);
app = app.replace(
  "[selectedCompanies]\n  );",
  "[selectedCompanies, companies]\n  );"
);
app = app.replace(
  "if (!q) return MEETING_COMPANIES;\n    return MEETING_COMPANIES.filter",
  "if (!q) return companies;\n    return companies.filter"
);
app = app.replace(
  "}, [companyQuery]);",
  "}, [companyQuery, companies]);"
);

// AdminDirectory component before DelegatesAdmin
if (!app.includes("function AdminDirectory")) {
  const marker = "function DelegatesAdmin({ users, busy, setBusy }) {";
  ensure("DelegatesAdmin", app.includes(marker));
  const comp = `function AdminDirectory({ busy, setBusy, onPeopleChanged }) {
  const [tab, setTab] = useState("people");
  const [companies, setCompanies] = useState([]);
  const [people, setPeople] = useState([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [newCompany, setNewCompany] = useState("");
  const [personName, setPersonName] = useState("");
  const [personEmail, setPersonEmail] = useState("");
  const [personPassword, setPersonPassword] = useState("");

  async function loadCompanies() {
    const data = await api("/api/admin/companies");
    setCompanies(data.companies || []);
  }
  async function loadPeople() {
    const data = await api("/api/admin/people");
    setPeople(Array.isArray(data) ? data : data?.users || []);
  }

  useEffect(() => {
    Promise.all([loadCompanies(), loadPeople()]).catch((e) =>
      setError(e?.data?.error || e.message || "خطا در بارگذاری")
    );
  }, []);

  async function addCompany(e) {
    e.preventDefault();
    setError("");
    setMsg("");
    setBusy(true);
    try {
      await api("/api/admin/companies", { method: "POST", body: { name: newCompany.trim() } });
      setNewCompany("");
      setMsg("شرکت اضافه شد.");
      await loadCompanies();
    } catch (err) {
      setError(err?.data?.error || err.message || "خطا");
    } finally {
      setBusy(false);
    }
  }

  async function removeCompany(id) {
    if (!confirm("حذف این شرکت؟")) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/admin/companies/" + encodeURIComponent(id), { method: "DELETE", body: {} });
      await loadCompanies();
    } catch (err) {
      setError(err?.data?.error || err.message || "خطا");
    } finally {
      setBusy(false);
    }
  }

  async function addPerson(e) {
    e.preventDefault();
    setError("");
    setMsg("");
    setBusy(true);
    try {
      await api("/api/admin/people", {
        method: "POST",
        body: {
          name: personName.trim(),
          email: personEmail.trim(),
          password: personPassword,
          role: "user",
          locale: "fa"
        }
      });
      setPersonName("");
      setPersonEmail("");
      setPersonPassword("");
      setMsg("کاربر اضافه شد.");
      await loadPeople();
      onPeopleChanged?.();
    } catch (err) {
      const code = err?.data?.error || err.message;
      setError(
        code === "email_taken"
          ? "این ایمیل قبلاً ثبت شده."
          : code === "password_short"
            ? "رمز حداقل ۸ کاراکتر باشد."
            : code === "cpgchat_unreachable"
              ? "سرور CPGChat در دسترس نیست."
              : code || "خطا"
      );
    } finally {
      setBusy(false);
    }
  }

  async function removePerson(id) {
    if (!confirm("حذف این کاربر؟")) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/admin/people/" + encodeURIComponent(id), { method: "DELETE", body: {} });
      await loadPeople();
      onPeopleChanged?.();
    } catch (err) {
      setError(err?.data?.error || err.message || "خطا");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel admin-directory">
      <h2>مدیریت افراد و شرکت‌ها</h2>
      <div className="row" style={{ marginBottom: "0.75rem", gap: "0.5rem" }}>
        <button type="button" className={"btn" + (tab === "people" ? "" : " secondary")} onClick={() => setTab("people")}>
          افراد
        </button>
        <button type="button" className={"btn" + (tab === "companies" ? "" : " secondary")} onClick={() => setTab("companies")}>
          شرکت‌ها
        </button>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {msg ? <div className="muted">{msg}</div> : null}

      {tab === "companies" ? (
        <div>
          <form className="row" onSubmit={addCompany} style={{ flexWrap: "wrap", gap: "0.5rem", marginBottom: "1rem" }}>
            <input
              value={newCompany}
              onChange={(e) => setNewCompany(e.target.value)}
              placeholder="نام شرکت جدید"
              required
              style={{ flex: "1 1 220px" }}
            />
            <button className="btn" type="submit" disabled={busy}>
              افزودن شرکت
            </button>
          </form>
          <ul className="file-list">
            {companies.map((c) => (
              <li key={c.id} className="file-card" style={{ justifyContent: "space-between" }}>
                <span>
                  {c.name}{" "}
                  <span className="muted" dir="ltr">
                    ({c.id})
                  </span>
                  {!Number(c.active) ? <span className="badge">غیرفعال</span> : null}
                </span>
                <button type="button" className="btn ghost" disabled={busy} onClick={() => removeCompany(c.id)}>
                  حذف
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div>
          <form
            onSubmit={addPerson}
            style={{ display: "grid", gap: "0.5rem", marginBottom: "1rem", maxWidth: 420 }}
          >
            <input value={personName} onChange={(e) => setPersonName(e.target.value)} placeholder="نام" required />
            <input
              value={personEmail}
              onChange={(e) => setPersonEmail(e.target.value)}
              placeholder="ایمیل"
              type="email"
              required
              dir="ltr"
            />
            <input
              value={personPassword}
              onChange={(e) => setPersonPassword(e.target.value)}
              placeholder="رمز عبور (حداقل ۸ کاراکتر)"
              type="password"
              required
              dir="ltr"
            />
            <button className="btn" type="submit" disabled={busy}>
              افزودن فرد
            </button>
          </form>
          <ul className="file-list">
            {people.map((u) => (
              <li key={u.id} className="file-card" style={{ justifyContent: "space-between" }}>
                <span>
                  {u.name || u.email}{" "}
                  <span className="muted" dir="ltr">
                    {u.email}
                  </span>
                  {u.role === "admin" ? <span className="badge">admin</span> : null}
                </span>
                <button type="button" className="btn ghost" disabled={busy} onClick={() => removePerson(u.id)}>
                  حذف
                </button>
              </li>
            ))}
          </ul>
          <p className="muted">کاربران در CPGChat ذخیره می‌شوند و در لیست دعوت جلسه دیده می‌شوند.</p>
        </div>
      )}

      <hr style={{ margin: "1.25rem 0" }} />
      <h3>تفویض جلسه</h3>
    </div>
  );
}

`;
  app = app.replace(marker, comp.replace(/\n/g, nl) + marker);
}

// Main app: companyCatalog state + loadCompanies + pass to MeetingForm + admin UI
if (!app.includes("companyCatalog")) {
  app = app.replace(
    "const [users, setUsers] = useState([]);",
    "const [users, setUsers] = useState([]);\n  const [companyCatalog, setCompanyCatalog] = useState(MEETING_COMPANIES);"
  );
}

if (!app.includes("loadCompaniesCatalog")) {
  const loadUsersBlock = `  const loadUsers = useCallback(async () => {
    if (!token) return;
    try {
      const data = await api("/api/users");
      setUsers(Array.isArray(data) ? data : data?.users || []);
    } catch {
      setUsers([]);
    }
  }, [token]);`;
  const withLoad = `  const loadUsers = useCallback(async () => {
    if (!token) return;
    try {
      const data = await api("/api/users");
      setUsers(Array.isArray(data) ? data : data?.users || []);
    } catch {
      setUsers([]);
    }
  }, [token]);

  const loadCompaniesCatalog = useCallback(async () => {
    if (!token) return;
    try {
      const data = await api("/api/companies");
      const list = data?.companies || [];
      if (list.length) setCompanyCatalog(list);
    } catch {
      /* keep fallback MEETING_COMPANIES */
    }
  }, [token]);`;
  if (app.includes(loadUsersBlock)) app = app.replace(loadUsersBlock, withLoad);
  else {
    const a = loadUsersBlock.replace(/\n/g, "\r\n");
    const b = withLoad.replace(/\n/g, "\r\n");
    if (app.includes(a)) app = app.replace(a, b);
    else console.error("loadUsers block missing");
  }
}

if (!app.includes("loadCompaniesCatalog().catch")) {
  app = app.replace(
    "loadUsers().catch(() => {});",
    "loadUsers().catch(() => {});\n    loadCompaniesCatalog().catch(() => {});"
  );
  app = app.replace(
    "[token, loadMeetings, loadUsers, loadPrincipals]",
    "[token, loadMeetings, loadUsers, loadCompaniesCatalog, loadPrincipals]"
  );
}

// MeetingForm companies= prop
if (!app.includes("companies={companyCatalog}")) {
  app = app.replace(
    /<MeetingForm\s*\n\s*users=\{users\}/,
    "<MeetingForm\n              users={users}\n              companies={companyCatalog}"
  );
  // if already one line
  if (!app.includes("companies={companyCatalog}")) {
    app = app.replace("<MeetingForm", "<MeetingForm companies={companyCatalog}");
  }
}

// Admin nav and view: use isMeetAdminClient
app = app.replace(/user\.role === "admin"/g, "isMeetAdminClient(user)");

// Admin view content: wrap with AdminDirectory before DelegatesAdmin
if (!app.includes("<AdminDirectory")) {
  const adminView = `{view === VIEWS.admin && isMeetAdminClient(user) ? (
          <DelegatesAdmin users={users} busy={busy} setBusy={setBusy} />
        ) : null}`;
  // after replace role checks, the condition might already be isMeetAdminClient
  const variants = [
    `{view === VIEWS.admin && isMeetAdminClient(user) ? (
          <DelegatesAdmin users={users} busy={busy} setBusy={setBusy} />
        ) : null}`,
    `{view === VIEWS.admin && user.role === "admin" ? (
          <DelegatesAdmin users={users} busy={busy} setBusy={setBusy} />
        ) : null}`
  ];
  const replacement = `{view === VIEWS.admin && isMeetAdminClient(user) ? (
          <>
            <AdminDirectory busy={busy} setBusy={setBusy} onPeopleChanged={() => loadUsers().catch(() => {})} />
            <DelegatesAdmin users={users} busy={busy} setBusy={setBusy} />
          </>
        ) : null}`;
  let done = false;
  for (const v of variants) {
    if (app.includes(v)) {
      app = app.replace(v, replacement);
      done = true;
      break;
    }
    const vc = v.replace(/\n/g, "\r\n");
    if (app.includes(vc)) {
      app = app.replace(vc, replacement.replace(/\n/g, "\r\n"));
      done = true;
      break;
    }
  }
  if (!done) {
    // softer: find DelegatesAdmin in admin view
    const i = app.indexOf("<DelegatesAdmin users={users}");
    if (i > 0 && !app.includes("<AdminDirectory")) {
      app =
        app.slice(0, i) +
        `<AdminDirectory busy={busy} setBusy={setBusy} onPeopleChanged={() => loadUsers().catch(() => {})} />` +
        nl +
        "            " +
        app.slice(i);
    } else console.error("admin view inject failed");
  }
}

// Empty people message improve
app = app.replace(
  "لیست کاربران خالی است (CPGChat را چک کنید).",
  "لیست کاربران خالی است. سرور CPGChat باید روشن باشد؛ اگر ادمین هستید از بخش مدیریت افراد اضافه کنید."
);

fs.writeFileSync(appPath, app);
console.log("app ok", app.length);
console.log("has AdminDirectory", app.includes("function AdminDirectory"));
console.log("has isMeetAdminClient", app.includes("isMeetAdminClient"));
console.log("has companies prop", app.includes("companies={companyCatalog}"));
