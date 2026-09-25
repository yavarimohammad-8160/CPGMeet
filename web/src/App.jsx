import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import { API_BASE, api, clearSession, downloadIcs, getStoredUser, getToken, setSession, uploadMeetingFile, downloadMeetingFile } from "./api.js";

import jalaali from "jalaali-js";

const VIEWS = { week: "week", list: "list", form: "form", detail: "detail", admin: "admin", delegates: "delegates" };

const NAV_ICON_PATHS = {
  week: "M20 3h-1V1h-2v2H7V1H5v2H4c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 18H4V8h16v13zM6 10h3v3H6zm4.5 0h3v3h-3zm4.5 0h3v3h-3z",
  list: "M17 10H7v2h10v-2zm2-7h-1V1h-2v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11zm-5-5H7v2h7v-2z",
  form: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z",
  delegates: "M16.5 12c1.38 0 2.49-1.12 2.49-2.5S17.88 7 16.5 7C15.12 7 14 8.12 14 9.5s1.12 2.5 2.5 2.5zM9 11c1.66 0 2.99-1.34 2.99-3S10.66 5 9 5C7.34 5 6 6.34 6 8s1.34 3 3 3zm7.5 3c-1.83 0-5.5.92-5.5 2.75V19h11v-2.25c0-1.83-3.67-2.75-5.5-2.75zM9 13c-2.33 0-7 1.17-7 3.5V19h7v-2.25c0-.85.33-2.34 2.37-3.47C10.5 13.1 9.66 13 9 13z",
  admin: "M12 7V3H2v18h20V7H12zM6 19H4v-2h2v2zm0-4H4v-2h2v2zm0-4H4V9h2v2zm0-4H4V5h2v2zm4 12H8v-2h2v2zm0-4H8v-2h2v2zm0-4H8V9h2v2zm0-4H8V5h2v2zm10 12h-8v-2h2v-2h-2v-2h2v-2h-2V9h8v10zm-2-8h-2v2h2v-2zm0 4h-2v2h2v-2z",
  bell: "M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z",
  logout: "M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"
};

function NavIcon({ name }) {
  return (
    <svg className={`nav-icon nav-icon-${name}`} width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d={NAV_ICON_PATHS[name]} />
    </svg>
  );
}

function notifPermission() {
  return typeof Notification !== "undefined" ? Notification.permission : "unsupported";
}

function startOfWeek(d) {
  const x = new Date(d);
  const day = (x.getDay() + 1) % 7; // Saturday=0 for FA week feel; still show Sun-Sat via offset
  // Use Monday-start ISO-ish: JS getDay Sun=0
  const mondayOffset = (x.getDay() + 6) % 7;
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - mondayOffset);
  return x;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

/** Local Asia/Tehran-ish datetime-local value from Date (browser local = typically Tehran on LAN PCs). */
function toLocalInputValue(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputToIso(localValue) {
  if (!localValue) return "";
  const d = new Date(localValue);
  return d.toISOString();
}

function toLocalDatePart(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toLocalTimePart(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Combine date (YYYY-MM-DD) + time (HH:MM) into ISO via local datetime. */
function combineDateTimeToIso(datePart, timePart) {
  if (!datePart) return "";
  const t = timePart && timePart.length >= 4 ? timePart : "00:00";
  return localInputToIso(`${datePart}T${t}`);
}

function splitLocalInput(localValue) {
  if (!localValue || !String(localValue).includes("T")) {
    return { date: "", time: "09:00" };
  }
  const [date, rest] = String(localValue).split("T");
  const time = (rest || "09:00").slice(0, 5);
  return { date, time };
}

const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
function toFaDigits(str) {
  return String(str).replace(/\d/g, (d) => FA_DIGITS[Number(d)]);
}

const JALALI_WEEKDAYS = ["شنبه", "یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه"];
const JALALI_MONTHS = [
  "فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
  "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"
];

function tehranParts(date) {
  const d = date instanceof Date ? date : new Date(date);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short"
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).filter((x) => x.type !== "literal").map((x) => [x.type, x.value]));
  return {
    gy: Number(parts.year),
    gm: Number(parts.month),
    gd: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  };
}

function gregorianToJalaliParts(date) {
  const t = tehranParts(date);
  const j = jalaali.toJalaali(t.gy, t.gm, t.gd);
  return { ...j, hour: t.hour, minute: t.minute };
}

function formatFa(iso) {
  try {
    const j = gregorianToJalaliParts(iso);
    const date = `${j.jy}/${String(j.jm).padStart(2, "0")}/${String(j.jd).padStart(2, "0")}`;
    const time = `${String(j.hour).padStart(2, "0")}:${String(j.minute).padStart(2, "0")}`;
    return toFaDigits(`${date} ${time}`);
  } catch {
    return String(iso);
  }
}

/** 24-hour Persian digits, e.g. ۱۴:۳۰ — never AM/PM */
function formatTimeFa(iso) {
  try {
    const j = gregorianToJalaliParts(iso);
    return toFaDigits(`${String(j.hour).padStart(2, "0")}:${String(j.minute).padStart(2, "0")}`);
  } catch {
    return "";
  }
}

function dayLabel(d) {
  try {
    const j = gregorianToJalaliParts(d);
    // JS getDay: Sun=0 … Sat=6 → map to FA week starting Sat
    const wd = (d.getDay() + 1) % 7; // Sat=0
    return toFaDigits(`${JALALI_WEEKDAYS[wd]} ${j.jd} ${JALALI_MONTHS[j.jm - 1]}`);
  } catch {
    return d.toDateString();
  }
}

function isMeetAdminClient(user) {
  if (!user) return false;
  if (String(user.role || "") === "admin") return true;
  return String(user.email || "").trim().toLowerCase() === "m.yavari@cpg-pars.com";
}

const MEETING_COMPANIES = [
  { id: "arzesh_afarinan", name: "ارزش آفرینان" },
  { id: "sarir_logistics", name: "سریر لجستیک" },
  { id: "napco", name: "ناپکو" }
];

const LOCATION_OPTIONS = [
  { key: "room_gf", label: "اتاق جلسات همکف" },
  { key: "room_1", label: "اتاق جلسات طبقه اول" },
  { key: "room_2", label: "اتاق جلسات طبقه دوم" },
  { key: "room_3", label: "اتاق جلسات طبقه سوم" },
  { key: "room_4", label: "اتاق جلسات طبقه چهارم" },
  { key: "room_5", label: "اتاق جلسات طبقه پنجم" },
  { key: "room_6", label: "اتاق جلسات طبقه ششم" },
  { key: "deputy_planning", label: "دفتر معاونت برنامه‌ریزی و توسعه" },
  { key: "external", label: "خارج از سازمان" }
];

function jalaliSelectYears(aroundJy) {
  const y = aroundJy || jalaali.toJalaali(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate()).jy;
  const out = [];
  for (let i = y - 2; i <= y + 3; i++) out.push(i);
  return out;
}

function daysInJalaliMonth(jy, jm) {
  return jalaali.jalaaliMonthLength(jy, jm);
}

function localDateFromJalali(jy, jm, jd) {
  const g = jalaali.toGregorian(Number(jy), Number(jm), Number(jd));
  return `${g.gy}-${String(g.gm).padStart(2, "0")}-${String(g.gd).padStart(2, "0")}`;
}

function jalaliFromLocalDate(datePart) {
  if (!datePart) {
    const n = new Date();
    return jalaali.toJalaali(n.getFullYear(), n.getMonth() + 1, n.getDate());
  }
  const [y, m, d] = datePart.split("-").map(Number);
  return jalaali.toJalaali(y, m, d);
}

function hourOptions() {
  return Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
}
function minuteOptions() {
  return ["00", "15", "30", "45"];
}

function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function myRsvp(meeting, userId) {
  const p = (meeting.participants || []).find((x) => Number(x.user_id) === Number(userId));
  return p?.rsvp || "pending";
}

function rsvpLabel(r) {
  return (
    { accepted: "قبول", declined: "رد", maybe: "شاید", pending: "در انتظار" }[r] || r
  );
}


function ForcePasswordModal({ token, user, onDone }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (pw.length < 8) {
      setError("رمز حداقل ۸ کاراکتر باشد");
      return;
    }
    if (pw !== pw2) {
      setError("رمز جدید و تکرار آن یکی نیستند");
      return;
    }
    setBusy(true);
    try {
      const data = await api("/api/auth/change-password", {
        method: "POST",
        body: { newPassword: pw },
        token
      });
      const next = data.user || { ...user, must_change_password: 0 };
      setSession(token, next);
      onDone(next);
    } catch (err) {
      const code = err?.data?.error;
      setError(
        code === "password_short"
          ? "رمز حداقل ۸ کاراکتر باشد"
          : code === "wrong_password"
            ? "رمز فعلی نادرست است"
            : err?.data?.message || err.message || "خطا در تغییر رمز"
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="force-pw-overlay" role="dialog" aria-modal="true">
      <form className="login-card force-pw-card" onSubmit={submit}>
        <h1>لطفاً رمز عبور خود را عوض کنید</h1>
        <p className="muted">برای ادامه باید رمز موقت را عوض کنید. این پنجره بسته نمی‌شود تا رمز جدید ذخیره شود.</p>
        {error ? <div className="error">{error}</div> : null}
        <label>رمز جدید</label>
        <input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} minLength={8} required dir="ltr" />
        <label>تکرار رمز جدید</label>
        <input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} minLength={8} required dir="ltr" />
        <div className="row" style={{ marginTop: "1.25rem" }}>
          <button className="btn" type="submit" disabled={busy}>{busy ? "..." : "تغییر رمز"}</button>
        </div>
      </form>
    </div>
  );
}

function Login({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await api("/api/auth/login", {
        method: "POST",
        body: { email, password },
        token: ""
      });
      setSession(data.token, data.user);
      onLogin(data.user, data.token);
    } catch (err) {
      const msg =

        err?.message === "Failed to fetch" || err?.status >= 500 || err?.data?.error === "bad_json"
          ? "سرور CPGMeet در دسترس نیست. لطفاً اتصال اینترنت خود را بررسی کرده و صفحه را مجدداً بارگذاری کنید."
          : err?.data?.error === "cpgchat_unreachable"
            ? "سرور CPGChat در دسترس نیست. ابتدا چت را روشن کنید."
            : err?.data?.error === "invalid_credentials" || err?.status === 401

              ? "ایمیل یا رمز اشتباه است."
              : err?.data?.message || err?.data?.error || err.message || "خطا در ورود";
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <h1>CPGMeet</h1>
        <p className="muted">ورود با حساب CPGMeet</p>
        {error ? <div className="error">{error}</div> : null}
        <label>ایمیل</label>
        <input
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          dir="ltr"
        />
        <label>رمز عبور</label>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          dir="ltr"
        />
        <div className="row" style={{ marginTop: "1.25rem" }}>
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "..." : "ورود"}
          </button>
        </div>
      </form>
    </div>
  );
}

function userLabel(u) {
  if (!u) return "";
  return u.name || u.email || `کاربر #${u.id}`;
}

function canManageMeetingUi(meeting, user, principals) {
  if (!meeting || !user) return false;
  if (meeting.can_manage != null) return Boolean(meeting.can_manage);
  const uid = Number(user.id);
  if (Number(meeting.organizer_id) === uid) return true;
  if (meeting.created_by_id != null && Number(meeting.created_by_id) === uid) return true;
  // Still delegated to act as this organizer (principals list always includes self)
  if ((principals || []).some((p) => Number(p.id) === Number(meeting.organizer_id) && Number(p.id) !== uid)) {
    return true;
  }
  return false;
}

/** Cancel only for creator (created_by_id, else organizer_id). */
function canCancelMeetingUi(meeting, user) {
  if (!meeting || !user) return false;
  if (meeting.can_cancel != null) return Boolean(meeting.can_cancel);
  const uid = Number(user.id);
  const creator =
    meeting.created_by_id != null && meeting.created_by_id !== ""
      ? Number(meeting.created_by_id)
      : Number(meeting.organizer_id);
  return creator === uid;
}

function MeetingForm({ users, principals, currentUser, initial, onSave, onCancel, busy, companies = [] }) {
  const isEdit = Boolean(initial?.id);
  const selfId = Number(currentUser?.id);
  const defaultStart = initial?.start_at ? new Date(initial.start_at) : new Date(Date.now() + 3600000);
  const defaultEnd = initial?.end_at ? new Date(initial.end_at) : new Date(Date.now() + 7200000);
  const startLocal = toLocalInputValue(defaultStart);
  const endLocal = toLocalInputValue(defaultEnd);
  const startSplit = splitLocalInput(startLocal);
  const endSplit = splitLocalInput(endLocal);
  const startJ0 = jalaliFromLocalDate(startSplit.date);
  const endJ0 = jalaliFromLocalDate(endSplit.date);

  const [title, setTitle] = useState(initial?.title || "");
  const [body, setBody] = useState(initial?.body || "");
  const [locationKey, setLocationKey] = useState(initial?.location_key || "room_gf");
  const [locationDetail, setLocationDetail] = useState(initial?.location_detail || "");
  const [startJy, setStartJy] = useState(startJ0.jy);
  const [startJm, setStartJm] = useState(startJ0.jm);
  const [startJd, setStartJd] = useState(startJ0.jd);
  const [endJy, setEndJy] = useState(endJ0.jy);
  const [endJm, setEndJm] = useState(endJ0.jm);
  const [endJd, setEndJd] = useState(endJ0.jd);
  const [startHour, setStartHour] = useState(startSplit.time.slice(0, 2) || "09");
  const [startMin, setStartMin] = useState(
    minuteOptions().includes(startSplit.time.slice(3, 5)) ? startSplit.time.slice(3, 5) : "00"
  );
  const [endHour, setEndHour] = useState(endSplit.time.slice(0, 2) || "10");
  const [endMin, setEndMin] = useState(
    minuteOptions().includes(endSplit.time.slice(3, 5)) ? endSplit.time.slice(3, 5) : "00"
  );
  const [selected, setSelected] = useState(
    () =>
      initial?.participants?.map((p) => Number(p.user_id)) ||
      (selfId ? [selfId] : [])
  );
  const [selectedCompanies, setSelectedCompanies] = useState(() =>
    (initial?.companies || []).map((c) => c.id || c.company_id).filter(Boolean)
  );
  const [companyPickerOpen, setCompanyPickerOpen] = useState(false);
  const [companyQuery, setCompanyQuery] = useState("");
  const [organizerId, setOrganizerId] = useState(
    () => Number(initial?.organizer_id) || selfId
  );
  const [remind15, setRemind15] = useState(
    initial?.remind_15 == null ? true : Boolean(Number(initial.remind_15))
  );
  const [needsCatering, setNeedsCatering] = useState(Boolean(Number(initial?.needs_catering)));
  const [cateringTea, setCateringTea] = useState(Boolean(Number(initial?.catering_tea)));
  const [cateringCoffee, setCateringCoffee] = useState(Boolean(Number(initial?.catering_coffee)));
  const [cateringSweets, setCateringSweets] = useState(Boolean(Number(initial?.catering_sweets)));
  const [pendingFiles, setPendingFiles] = useState([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attendeeQuery, setAttendeeQuery] = useState("");
  const [error, setError] = useState("");

  const principalOptions = useMemo(() => {
    const list = Array.isArray(principals) && principals.length ? principals : [];
    const hasSelf = list.some((p) => Number(p.id) === selfId);
    if (!hasSelf && currentUser) {
      return [
        { id: selfId, name: currentUser.name || currentUser.email, email: currentUser.email },
        ...list
      ];
    }
    return list.length ? list : [{ id: selfId, name: currentUser?.name || currentUser?.email, email: currentUser?.email }];
  }, [principals, currentUser, selfId]);

  const selectedUsers = useMemo(
    () => selected.map((id) => users.find((u) => Number(u.id) === Number(id))).filter(Boolean),
    [selected, users]
  );

  const filteredUsers = useMemo(() => {
    const q = attendeeQuery.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => {
      const label = `${u.name || ""} ${u.email || ""}`.toLowerCase();
      return label.includes(q);
    });
  }, [users, attendeeQuery]);

  function toggleUser(id) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }
  function removeUser(id) {
    setSelected((prev) => prev.filter((x) => x !== id));
  }

  const selectedCompanyObjs = useMemo(
    () =>
      selectedCompanies
        .map((id) => companies.find((c) => c.id === id))
        .filter(Boolean),
    [selectedCompanies, companies]
  );

  const filteredCompanies = useMemo(() => {
    const q = companyQuery.trim().toLowerCase();
    if (!q) return companies;
    return companies.filter((c) => String(c.name || "").toLowerCase().includes(q));
  }, [companyQuery, companies]);

  function toggleCompany(id) {
    setSelectedCompanies((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }
  function removeCompany(id) {
    setSelectedCompanies((prev) => prev.filter((x) => x !== id));
  }

  function clampDay(jy, jm, jd) {
    const max = daysInJalaliMonth(jy, jm);
    return Math.min(jd, max);
  }

  async function maybeRequestNotif() {
    if (!remind15 || typeof Notification === "undefined") return;
    if (Notification.permission === "default") {
      try {
        await Notification.requestPermission();
      } catch {
        /* ignore */
      }
    }
  }

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (locationKey === "external" && !locationDetail.trim()) {
      setError("برای «خارج از سازمان» آدرس یا نام مکان الزامی است.");
      return;
    }
    try {
      await maybeRequestNotif();
      const startDate = localDateFromJalali(startJy, startJm, clampDay(startJy, startJm, startJd));
      const endDate = localDateFromJalali(endJy, endJm, clampDay(endJy, endJm, endJd));
      const payload = {
        title,
        body,
        location_key: locationKey,
        location_detail: locationKey === "external" ? locationDetail.trim() : "",
        start_at: combineDateTimeToIso(startDate, `${startHour}:${startMin}`),
        end_at: combineDateTimeToIso(endDate, `${endHour}:${endMin}`),
        participant_ids: selected,
        company_ids: selectedCompanies,
        remind_15: remind15 ? 1 : 0,
        needs_catering: needsCatering ? 1 : 0,
        catering_tea: needsCatering && cateringTea ? 1 : 0,
        catering_coffee: needsCatering && cateringCoffee ? 1 : 0,
        catering_sweets: needsCatering && cateringSweets ? 1 : 0
      };
      if (!isEdit) {
        payload.organizer_id = Number(organizerId) || selfId;
      }
      await onSave(payload, pendingFiles);
      setPendingFiles([]);
    } catch (err) {
      const code = err?.data?.error || err.message || "خطا";
      setError(
        code === "not_delegated"
          ? "اجازه ثبت جلسه از طرف این شخص را ندارید."
          : code === "location_detail_required"
            ? "آدرس مکان خارجی الزامی است."
            : code
      );
    }
  }

  const organizer = principalOptions.find((p) => Number(p.id) === Number(organizerId));
  const startDayMax = daysInJalaliMonth(startJy, startJm);
  const endDayMax = daysInJalaliMonth(endJy, endJm);

  return (
    <form className="outlook-compose panel" onSubmit={submit}>
      <div className="compose-toolbar">
        <button className="compose-send" type="submit" disabled={busy} title={isEdit ? "ذخیره" : "ارسال"}>
          <span className="compose-send-icon" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </span>
          <span className="compose-send-label">{isEdit ? "ذخیره" : "ارسال"}</span>
        </button>
        <button className="btn secondary compose-discard" type="button" onClick={onCancel}>
          انصراف
        </button>
        <div className="compose-toolbar-spacer" />
        <span className="compose-heading-muted">{isEdit ? "ویرایش رویداد" : ""}</span>
      </div>

      {error ? <div className="error">{error}</div> : null}

      {!isEdit ? (
        <div className="compose-banner" role="status">
          هنوز دعوت ارسال نشده — با کلیک بر روی «ارسال»، جلسه ایجاد و دعوت‌ها فرستاده می‌شود.
        </div>
      ) : null}

      {!isEdit ? (
        <div className="compose-from compose-row">
          <span className="compose-label">از طرف</span>
          <select
            className="compose-from-select"
            value={String(organizerId)}
            onChange={(e) => setOrganizerId(Number(e.target.value))}
            aria-label="از طرف"
          >
            {principalOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {userLabel(p)}
                {Number(p.id) === selfId ? " (خودم)" : ""}
                {p.email ? ` — ${p.email}` : ""}
              </option>
            ))}
          </select>
          {organizer && Number(organizer.id) !== selfId ? (
            <span className="compose-from-hint muted">جلسه به نام این شخص ثبت می‌شود</span>
          ) : null}
        </div>
      ) : (
        <div className="compose-from compose-row">
          <span className="compose-label">از طرف</span>
          <span className="compose-from-static">
            {initial?.organizer_id != null
              ? userLabel(users.find((u) => Number(u.id) === Number(initial.organizer_id))) ||
                `کاربر #${initial.organizer_id}`
              : userLabel(currentUser)}
          </span>
        </div>
      )}

      <div className="compose-title-wrap">
        <input
          className="compose-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="عنوان جلسه را اضافه کنید"
          required
          aria-label="عنوان"
        />
      </div>

      <div className="compose-attendees compose-row">
        <span className="compose-label">الزامی</span>
        <div className="compose-attendees-body">
          <button
            type="button"
            className="compose-add-people-btn"
            onClick={() => setPickerOpen((o) => !o)}
          >
            <span className="compose-add-people-icon" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
              </svg>
            </span>
            {pickerOpen ? "بستن فهرست افراد" : "افزودن افراد"}
          </button>
          <div className="compose-chips">
            {selectedUsers.map((u) => (
              <span className="compose-chip" key={u.id}>
                <span className="compose-chip-text">{userLabel(u)}</span>
                <button
                  type="button"
                  className="compose-chip-remove"
                  onClick={() => removeUser(Number(u.id))}
                  aria-label={`حذف ${userLabel(u)}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          {pickerOpen ? (
            <div className="compose-picker">
              <input
                className="compose-picker-search"
                type="search"
                value={attendeeQuery}
                onChange={(e) => setAttendeeQuery(e.target.value)}
                placeholder="جستجوی نام یا ایمیل…"
                dir="auto"
              />
              <div className="compose-picker-list">
                {users.length === 0 ? (
                  <p className="muted">لیست کاربران خالی است. از بخش مدیریت، افراد را اضافه کنید.</p>
                ) : filteredUsers.length === 0 ? (
                  <p className="muted">نتیجه‌ای نیست.</p>
                ) : (
                  filteredUsers.map((u) => (
                    <label key={u.id} className="compose-picker-item">
                      <input
                        type="checkbox"
                        checked={selected.includes(Number(u.id))}
                        onChange={() => toggleUser(Number(u.id))}
                      />
                      <span className="compose-picker-name">{userLabel(u)}</span>
                      <span className="muted compose-picker-email" dir="ltr">
                        {u.email}
                      </span>
                    </label>
                  ))
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
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
                  aria-label={`حذف ${c.name}`}
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


      <div className="compose-when">
        <div className="compose-when-row compose-jalali-row">
          <span className="compose-label">شروع</span>
          <div className="compose-date-group">
          <select
            className="compose-jalali-select compose-jalali-year"
            value={startJy}
            onChange={(e) => {
              const y = Number(e.target.value);
              setStartJy(y);
              setStartJd(clampDay(y, startJm, startJd));
            }}
            aria-label="سال شمسی شروع"
          >
            {jalaliSelectYears(startJy).map((y) => (
              <option key={y} value={y}>
                {toFaDigits(y)}
              </option>
            ))}
          </select>
          <select
            className="compose-jalali-select compose-jalali-month"
            value={startJm}
            onChange={(e) => {
              const m = Number(e.target.value);
              setStartJm(m);
              setStartJd(clampDay(startJy, m, startJd));
            }}
            aria-label="ماه شمسی شروع"
          >
            {JALALI_MONTHS.map((name, i) => (
              <option key={name} value={i + 1}>
                {name}
              </option>
            ))}
          </select>
          <select
            className="compose-jalali-select compose-jalali-day"
            value={Math.min(startJd, startDayMax)}
            onChange={(e) => setStartJd(Number(e.target.value))}
            aria-label="روز شمسی شروع"
          >
            {Array.from({ length: startDayMax }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {toFaDigits(d)}
              </option>
            ))}
          </select>
          </div>
          <div className="compose-time-group" dir="ltr">
          <select
            className="compose-time-select"
            value={startHour}
            onChange={(e) => setStartHour(e.target.value)}
            aria-label="ساعت شروع"
          >
            {hourOptions().map((h) => (
              <option key={h} value={h}>
                {toFaDigits(h)}
              </option>
            ))}
          </select>
          <span className="compose-time-sep">:</span>
          <select
            className="compose-time-select"
            value={startMin}
            onChange={(e) => setStartMin(e.target.value)}
            aria-label="دقیقه شروع"
          >
            {minuteOptions().map((m) => (
              <option key={m} value={m}>
                {toFaDigits(m)}
              </option>
            ))}
          </select>
          </div>
        </div>
        <div className="compose-when-row compose-jalali-row">
          <span className="compose-label">پایان</span>
          <div className="compose-date-group">
          <select
            className="compose-jalali-select compose-jalali-year"
            value={endJy}
            onChange={(e) => {
              const y = Number(e.target.value);
              setEndJy(y);
              setEndJd(clampDay(y, endJm, endJd));
            }}
            aria-label="سال شمسی پایان"
          >
            {jalaliSelectYears(endJy).map((y) => (
              <option key={y} value={y}>
                {toFaDigits(y)}
              </option>
            ))}
          </select>
          <select
            className="compose-jalali-select compose-jalali-month"
            value={endJm}
            onChange={(e) => {
              const m = Number(e.target.value);
              setEndJm(m);
              setEndJd(clampDay(endJy, m, endJd));
            }}
            aria-label="ماه شمسی پایان"
          >
            {JALALI_MONTHS.map((name, i) => (
              <option key={name} value={i + 1}>
                {name}
              </option>
            ))}
          </select>
          <select
            className="compose-jalali-select compose-jalali-day"
            value={Math.min(endJd, endDayMax)}
            onChange={(e) => setEndJd(Number(e.target.value))}
            aria-label="روز شمسی پایان"
          >
            {Array.from({ length: endDayMax }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {toFaDigits(d)}
              </option>
            ))}
          </select>
          </div>
          <div className="compose-time-group" dir="ltr">
          <select
            className="compose-time-select"
            value={endHour}
            onChange={(e) => setEndHour(e.target.value)}
            aria-label="ساعت پایان"
          >
            {hourOptions().map((h) => (
              <option key={h} value={h}>
                {toFaDigits(h)}
              </option>
            ))}
          </select>
          <span className="compose-time-sep">:</span>
          <select
            className="compose-time-select"
            value={endMin}
            onChange={(e) => setEndMin(e.target.value)}
            aria-label="دقیقه پایان"
          >
            {minuteOptions().map((m) => (
              <option key={m} value={m}>
                {toFaDigits(m)}
              </option>
            ))}
          </select>
          </div>
        </div>
        <div className="compose-when-links" aria-hidden="true">
          <span className="compose-muted-link is-disabled" title="به‌زودی">
            تمام‌روز
          </span>
          <span className="compose-muted-link is-disabled" title="به‌زودی">
            تکرار
          </span>
          <span className="compose-soon">به‌زودی</span>
        </div>
      </div>

      <div className="compose-location compose-row">
        <span className="compose-label">مکان</span>
        <div className="compose-location-fields">
          <select
            className="compose-location-select"
            value={locationKey}
            onChange={(e) => setLocationKey(e.target.value)}
            required
            aria-label="مکان"
          >
            {LOCATION_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
          {locationKey === "external" ? (
            <input
              className="compose-location-input"
              value={locationDetail}
              onChange={(e) => setLocationDetail(e.target.value)}
              placeholder="آدرس یا نام مکان (الزامی)"
              required
            />
          ) : null}
        </div>
      </div>

      <div className="compose-remind compose-row">
        <label className="compose-remind-label">
          <input
            type="checkbox"
            checked={remind15}
            onChange={async (e) => {
              const on = e.target.checked;
              setRemind15(on);
              if (on) await maybeRequestNotif();
            }}
          />
          <span>۱۵ دقیقه قبل از شروع جلسه، یادآوری کن</span>
        </label>
      </div>

      <div className="compose-catering">
        <div className="compose-row">
          <span className="compose-label">پذیرایی</span>
          <div className="compose-catering-ask">
            <span>آیا جلسه نیاز به پذیرایی دارد؟</span>
            <label className="compose-radio">
              <input
                type="radio"
                name="needs_catering"
                checked={needsCatering}
                onChange={() => setNeedsCatering(true)}
              />
              بله
            </label>
            <label className="compose-radio">
              <input
                type="radio"
                name="needs_catering"
                checked={!needsCatering}
                onChange={() => setNeedsCatering(false)}
              />
              خیر
            </label>
          </div>
        </div>
        {needsCatering ? (
          <div className="compose-catering-opts">
            <label>
              <input type="checkbox" checked={cateringTea} onChange={(e) => setCateringTea(e.target.checked)} />
              چای
            </label>
            <label>
              <input
                type="checkbox"
                checked={cateringCoffee}
                onChange={(e) => setCateringCoffee(e.target.checked)}
              />
              قهوه
            </label>
            <label>
              <input
                type="checkbox"
                checked={cateringSweets}
                onChange={(e) => setCateringSweets(e.target.checked)}
              />
              شیرینی
            </label>
          </div>
        ) : null}
      </div>

      <div className="compose-files compose-row">
        <span className="compose-label">پیوست</span>
        <div className="compose-files-body">
          <input
            type="file"
            multiple
            accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.jpg,.jpeg,.png,.gif,.webp,.txt,application/pdf,image/*"
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              setPendingFiles((prev) => [...prev, ...files]);
              e.target.value = "";
            }}
          />
          {pendingFiles.length ? (
            <ul className="compose-file-list">
              {pendingFiles.map((f, i) => (
                <li key={`${f.name}-${i}`}>
                  {f.name}
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => setPendingFiles((prev) => prev.filter((_, j) => j !== i))}
                  >
                    حذف
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">فایل‌های پیوست پس از ذخیره آپلود می‌شوند (حداکثر ۵۰ مگابایت).</p>
          )}
        </div>
      </div>

      <div className="compose-body-wrap">
        <textarea
          className="compose-body"
          rows={8}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="یادداشت یا دستور جلسه را اینجا بنویسید…"
        />
      </div>
    </form>
  );
}


function MeetingFilesSection({ meeting, user, canManage, onChanged }) {
  const [files, setFiles] = useState(meeting?.files || []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setFiles(meeting?.files || []);
  }, [meeting?.id, meeting?.files]);

  async function refresh() {
    const data = await api(`/api/meetings/${meeting.id}/files`);
    setFiles(data.files || []);
  }

  async function onUpload(e, kind) {
    const list = Array.from(e.target.files || []);
    e.target.value = "";
    if (!list.length) return;
    setBusy(true);
    setError("");
    try {
      for (const file of list) {
        await uploadMeetingFile(meeting.id, file, kind);
      }
      await refresh();
      onChanged?.();
    } catch (err) {
      setError(err?.data?.error || err.message || "خطا در آپلود");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(id) {
    if (!confirm("حذف این فایل؟")) return;
    setBusy(true);
    try {
      await api(`/api/files/${id}`, { method: "DELETE", body: {} });
      await refresh();
      onChanged?.();
    } catch (err) {
      setError(err?.data?.error || err.message || "خطا");
    } finally {
      setBusy(false);
    }
  }

  const attachments = files.filter((f) => f.kind !== "minutes");
  const minutes = files.filter((f) => f.kind === "minutes");

  
  function displayFileName(name) {
    const s = String(name || "");
    if (!s) return "فایل";
    if (/[\u0600-\u06FF]/.test(s)) return s;
    try {
      const bytes = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
      const decoded = new TextDecoder("utf-8").decode(bytes);
      if (/[\u0600-\u06FF]/.test(decoded) && !decoded.includes("\uFFFD")) return decoded;
    } catch {}
    return s;
  }

  function fileCoverMeta(name, mime) {
    const n = String(name || "").toLowerCase();
    const m = String(mime || "").toLowerCase();
    if (m.includes("pdf") || n.endsWith(".pdf")) return { label: "PDF", cls: "pdf" };
    if (m.includes("word") || m.includes("msword") || /\.docx?$/.test(n)) return { label: "Word", cls: "word" };
    if (m.includes("excel") || m.includes("spreadsheet") || /\.xlsx?$/.test(n)) return { label: "Excel", cls: "excel" };
    if (m.includes("powerpoint") || m.includes("presentation") || /\.pptx?$/.test(n)) return { label: "PPT", cls: "ppt" };
    if (m.startsWith("image/") || /\.(jpe?g|png|gif|webp)$/.test(n)) return { label: "IMG", cls: "image" };
    if (m.includes("zip") || m.includes("compressed") || n.endsWith(".zip")) return { label: "ZIP", cls: "zip" };
    if (m.startsWith("text/") || n.endsWith(".txt")) return { label: "TXT", cls: "txt" };
    return { label: "FILE", cls: "generic" };
  }
function FileList({ items, title }) {
    return (
      <div className="files-block">
        <h3>{title}</h3>
        {items.length === 0 ? (
          <p className="muted">موردی نیست.</p>
        ) : (
          <ul className="file-list">
            {items.map((f) => {
              const shown = displayFileName(f.name);
              const cover = fileCoverMeta(shown, f.mime);
              return (
                <li key={f.id} className="file-card">
                  <button
                    type="button"
                    className="file-card-main"
                    onClick={() => downloadMeetingFile(f.id, shown)}
                    title={shown}
                  >
                    <span className={`file-cover file-cover-${cover.cls}`} aria-hidden="true">
                      <span className="file-cover-label">{cover.label}</span>
                    </span>
                    <span className="file-card-meta">
                      <span className="file-card-name">{shown}</span>
                      <span className="muted file-card-size">{toFaDigits(Math.round((f.size || 0) / 1024))} کیلوبایت</span>
                    </span>
                  </button>
                  {Number(f.uploader_id) === Number(user.id) || canManage ? (
                    <button type="button" className="btn ghost file-card-delete" disabled={busy} onClick={() => onDelete(f.id)}>
                      حذف
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="meeting-files">
      {error ? <div className="error">{error}</div> : null}
      <FileList items={attachments} title="پیوست‌ها" />
      <label className="btn secondary file-upload-btn">
        افزودن پیوست
        <input
          type="file"
          hidden
          multiple
          disabled={busy}
          onChange={(e) => onUpload(e, "attachment")}
        />
      </label>
      <FileList items={minutes} title="صورتجلسه" />
      <label className="btn secondary file-upload-btn">
        افزودن صورتجلسه / سند مرتبط
        <input type="file" hidden multiple disabled={busy} onChange={(e) => onUpload(e, "minutes")} />
      </label>
    </div>
  );
}


function AdminDirectory({ busy, setBusy, onPeopleChanged, onBackToMeetings }) {
  const [tab, setTab] = useState("people");
  const [companies, setCompanies] = useState([]);
  const [people, setPeople] = useState([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [newCompany, setNewCompany] = useState("");
  const [personName, setPersonName] = useState("");
  const [personEmail, setPersonEmail] = useState("");
  const [personPassword, setPersonPassword] = useState("");
  const [personRole, setPersonRole] = useState("user");

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
    setMsg("");
    try {
      await api("/api/admin/companies/" + encodeURIComponent(id), { method: "DELETE", body: {} });
      setMsg("شرکت حذف شد.");
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
          role: "user"
        }
      });
      setPersonName("");
      setPersonEmail("");
      setPersonPassword("");
      setPersonRole("user");
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
    setMsg("");
    try {
      await api("/api/admin/people/" + encodeURIComponent(id), { method: "DELETE", body: {} });
      setMsg("کاربر حذف شد.");
      await loadPeople();
      onPeopleChanged?.();
    } catch (err) {
      const code = err?.data?.error || err.message;
      setError(
        code === "cannot_delete_self"
          ? "نمی‌توانید خودتان را حذف کنید."
          : code === "last_admin"
            ? "حداقل یک ادمین باید بماند."
            : code || "خطا"
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel admin-directory">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>مدیریت افراد و شرکت‌ها</h2>
        {onBackToMeetings ? (
          <button type="button" className="btn" onClick={onBackToMeetings}>
            بازگشت به جلسات
          </button>
        ) : null}
      </div>
      <div className="row" style={{ marginBottom: "0.75rem", gap: "0.5rem", marginTop: "0.75rem" }}>
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
              <li key={c.id} className="admin-person-row">
                <div className="admin-person-main">
                  <strong>{c.name}</strong>
                  {!Number(c.active) ? <span className="badge">غیرفعال</span> : null}
                </div>
                <div className="admin-person-actions">
                  <button type="button" className="btn danger" disabled={busy} onClick={() => removeCompany(c.id)}>
                    حذف
                  </button>
                </div>
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
              <li key={u.id} className="admin-person-row">
                <div className="admin-person-main">
                  <strong>{u.name || u.email}</strong>
                  <span className="muted" dir="ltr">
                    {u.email}
                  </span>
                  {u.role === "admin" ? <span className="badge">admin</span> : null}
                </div>
                <div className="admin-person-actions">
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={busy}
                    onClick={async () => {
                      const pwd = prompt("رمز جدید (حداقل ۸ کاراکتر):");
                      if (!pwd) return;
                      if (pwd.length < 8) {
                        setError("رمز حداقل ۸ کاراکتر باشد.");
                        return;
                      }
                      setBusy(true);
                      setError("");
                      try {
                        await api("/api/admin/people/" + u.id + "/password", {
                          method: "POST",
                          body: { password: pwd }
                        });
                        setMsg("رمز «" + (u.name || u.email) + "» عوض شد.");
                      } catch (err) {
                        setError(err?.data?.error || err.message || "خطا");
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    تغییر رمز
                  </button>
                  <button type="button" className="btn danger" disabled={busy} onClick={() => removePerson(u.id)}>
                    حذف
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <p className="muted">کاربران فقط در CPGMeet ذخیره می‌شوند (مستقل از چت).</p>
        </div>
      )}

    </div>
  );
}

function DelegatesAdmin({ users, busy, setBusy }) {
  const [principalId, setPrincipalId] = useState("");
  const [assistantIds, setAssistantIds] = useState([]);
  const [pairs, setPairs] = useState([]);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const data = await api("/api/admin/delegates");
    setPairs(data.delegates || []);
  }, []);

  useEffect(() => {
    load().catch((e) => setError(e?.data?.error || e.message || "خطا"));
  }, [load]);

  useEffect(() => {
    if (!principalId) {
      setAssistantIds([]);
      return;
    }
    const pid = Number(principalId);
    setAssistantIds(
      pairs.filter((p) => Number(p.principal_id) === pid).map((p) => Number(p.assistant_id))
    );
  }, [principalId, pairs]);

  function toggleAssistant(id) {
    setAssistantIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  async function save(e) {
    e.preventDefault();
    setError("");
    setMsg("");
    if (!principalId) {
      setError("مدیر / معاون را انتخاب کنید.");
      return;
    }
    setBusy(true);
    try {
      await api("/api/admin/delegates", {
        method: "PUT",
        body: { principal_id: Number(principalId), assistant_ids: assistantIds }
      });
      setMsg("تفویض ذخیره شد.");
      await load();
    } catch (err) {
      setError(err?.data?.error || err.message || "خطا");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel form">
      <h2>تفویض جلسه</h2>
      <p className="muted">
        رئیس دفتر (دستیار) می‌تواند جلسه را از طرف مدیر / معاون ثبت کند — مشابه From در Outlook.
      </p>
      {error ? <div className="error">{error}</div> : null}
      {msg ? (
        <div className="panel" style={{ background: "#ebf8ff", marginBottom: "0.75rem" }}>
          {msg}
        </div>
      ) : null}
      <form onSubmit={save}>
        <label>مدیر / معاون (صاحب جلسه)</label>
        <select value={principalId} onChange={(e) => setPrincipalId(e.target.value)} required>
          <option value="">انتخاب کنید…</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {userLabel(u)}
            </option>
          ))}
        </select>
        <label>دستیاران مجاز (از طرف)</label>
        <div className="users-multi">
          {users
            .filter((u) => Number(u.id) !== Number(principalId || 0))
            .map((u) => (
              <label key={u.id}>
                <input
                  type="checkbox"
                  checked={assistantIds.includes(Number(u.id))}
                  onChange={() => toggleAssistant(Number(u.id))}
                  disabled={!principalId}
                />
                {userLabel(u)}
                <span className="muted" style={{ marginRight: "auto" }} dir="ltr">
                  {u.email}
                </span>
              </label>
            ))}
        </div>
        <div className="row" style={{ marginTop: "1.25rem" }}>
          <button className="btn" type="submit" disabled={busy || !principalId}>
            ذخیره تفویض
          </button>
        </div>
      </form>
      <h3 style={{ marginTop: "1.5rem" }}>تفویض‌های فعلی</h3>
      {pairs.length === 0 ? (
        <p className="muted">موردی ثبت نشده.</p>
      ) : (
        <ul className="delegate-list">
          {pairs.map((p) => {
            const principal = users.find((u) => Number(u.id) === Number(p.principal_id));
            const assistant = users.find((u) => Number(u.id) === Number(p.assistant_id));
            return (
              <li key={`${p.principal_id}-${p.assistant_id}`}>
                <strong>{userLabel(assistant) || `#${p.assistant_id}`}</strong>
                {" از طرف "}
                <strong>{userLabel(principal) || `#${p.principal_id}`}</strong>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(() => getStoredUser());
  const [token, setToken] = useState(() => getToken());
  const [view, setView] = useState(VIEWS.week);
  const [weekAnchor, setWeekAnchor] = useState(() => startOfWeek(new Date()));
  const [listFilter, setListFilter] = useState("all");
  const [meetings, setMeetings] = useState([]);
  const [users, setUsers] = useState([]);
  const [companyCatalog, setCompanyCatalog] = useState(MEETING_COMPANIES);
  const [principals, setPrincipals] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [notifPerm, setNotifPerm] = useState(() => notifPermission());
  const mainRef = useRef(null);

  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [view]);

  const selected = useMemo(
    () => meetings.find((m) => Number(m.id) === Number(selectedId)) || null,
    [meetings, selectedId]
  );

  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekAnchor, i)), [weekAnchor]);

  const loadMeetings = useCallback(async () => {
    if (!token) return;
    const from = addDays(weekAnchor, -14).toISOString();
    const to = addDays(weekAnchor, 45).toISOString();
    const data = await api(`/api/meetings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    setMeetings(data.meetings || []);
  }, [token, weekAnchor]);

  const loadUsers = useCallback(async () => {
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
  }, [token]);

  const loadPrincipals = useCallback(async () => {
    if (!token) return;
    try {
      const data = await api("/api/delegates/principals");
      setPrincipals(data.principals || []);
    } catch {
      setPrincipals(
        user
          ? [{ id: Number(user.id), name: user.name || user.email, email: user.email }]
          : []
      );
    }
  }, [token, user]);

  useEffect(() => {
    if (!token) return;
    loadMeetings().catch((e) => setError(e.message));
    loadUsers().catch(() => {});
    loadCompaniesCatalog().catch(() => {});
    loadPrincipals().catch(() => {});
  }, [token, loadMeetings, loadUsers, loadCompaniesCatalog, loadPrincipals]);

  useEffect(() => {
    if (!token) return;
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Promise.resolve(Notification.requestPermission())
        .catch(() => {})
        .finally(() => setNotifPerm(notifPermission()));
    }
    const socket = io(API_BASE || "https://meet-api.cpg-pars.ir", {

      path: "/socket.io",
      auth: { token },
      transports: ["websocket", "polling"]
    });
    socket.on("meeting:reminder", (payload) => {
      const title = payload?.meeting?.title || "یادآوری جلسه";
      const body = `حدود ${payload?.minutesLeft ?? 15} دقیقه تا شروع`;
      setToast(`${title} — ${body}`);
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        try {
          new Notification(title, { body, tag: `meet-rem-${payload?.meeting?.id}` });
        } catch {
          /* ignore */
        }
      }
      loadMeetings().catch(() => {});
    });
    socket.on("meeting:invite", () => {
      loadMeetings().catch(() => {});
    });
    return () => socket.disconnect();
  }, [token, loadMeetings]);

  function logout() {
    clearSession();
    setUser(null);
    setToken("");
  }

  async function openDetail(id) {
    setSelectedId(id);
    setView(VIEWS.detail);
    try {
      const data = await api(`/api/meetings/${id}`);
      if (data?.meeting) {
        setMeetings((prev) => {
          const others = prev.filter((m) => Number(m.id) !== Number(id));
          return [...others, data.meeting];
        });
      }
    } catch {
      /* keep list copy */
    }
  }

  async function saveMeeting(fields, pendingFiles = []) {
    setBusy(true);
    try {
      let meetingId = editing?.id;
      if (editing?.id) {
        await api(`/api/meetings/${editing.id}`, { method: "PATCH", body: fields });
      } else {
        const created = await api("/api/meetings", { method: "POST", body: fields });
        meetingId = created?.meeting?.id;
      }
      if (meetingId && pendingFiles?.length) {
        for (const file of pendingFiles) {
          try {
            await uploadMeetingFile(meetingId, file, "attachment");
          } catch (err) {
            console.warn("upload failed", err);
            setToast(`آپلود «${file.name}» ناموفق بود`);
          }
        }
      }
      setEditing(null);
      await loadMeetings();
      if (meetingId) {
        setSelectedId(meetingId);
        setView(VIEWS.detail);
      } else {
        setView(VIEWS.week);
      }
    } finally {
      setBusy(false);
    }
  }

  async function cancelMeeting(id) {
    if (!confirm("لغو این جلسه؟")) return;
    await api(`/api/meetings/${id}/cancel`, { method: "POST", body: {} });
    await loadMeetings();
  }

  async function sendRsvp(id, rsvp) {
    await api(`/api/meetings/${id}/rsvp`, { method: "POST", body: { rsvp } });
    await loadMeetings();
  }

  const myList = useMemo(() => {
    const now = Date.now();
    const uid = user?.id;
    let rows = [...meetings].map((m) => ({
      ...m,
      _mine: myRsvp(m, uid),
      _upcoming: new Date(m.start_at).getTime() >= now,
      _past: new Date(m.end_at || m.start_at).getTime() < now
    }));
    if (listFilter === "upcoming") {
      rows = rows.filter((m) => m.status !== "cancelled" && m._upcoming);
    } else if (listFilter === "past") {
      rows = rows.filter((m) => m.status !== "cancelled" && m._past);
    } else if (listFilter === "cancelled") {
      rows = rows.filter((m) => m.status === "cancelled");
    }
    // Default همه: upcoming first then past, each by start_at desc within group… use start_at desc overall
    rows.sort((a, b) => new Date(b.start_at) - new Date(a.start_at));
    return rows;
  }, [meetings, user, listFilter]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api("/api/me", { token })
      .then((u) => {
        if (cancelled) return;
        setUser(u);
        setSession(token, u);
      })
      .catch(() => {
        if (cancelled) return;
        clearSession();
        setToken("");
        setUser(null);
      });
    return () => { cancelled = true; };
  }, [token]);

  if (!token || !user) {
    return (
      <Login
        onLogin={(u, t) => {
          setUser(u);
          setToken(t);
        }}
      />
    );
  }

  if (Number(user.must_change_password) === 1) {
    return (
      <ForcePasswordModal
        token={token}
        user={user}
        onDone={(u) => setUser(u)}
      />
    );
  }

  const isAdmin = isMeetAdminClient(user);
  const navItems = [
    { id: VIEWS.week, icon: "week", label: "هفته" },
    { id: VIEWS.list, icon: "list", label: "جلسات من" },
    { id: VIEWS.form, icon: "form", label: "جلسه جدید", onClick: () => setEditing(null) },
    ...(isAdmin
      ? [
          { id: VIEWS.delegates, icon: "delegates", label: "تفویض جلسه" },
          { id: VIEWS.admin, icon: "admin", label: "افراد و شرکت‌ها" }
        ]
      : [])
  ];
  const displayName = user.name || user.email || "";

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="منوی اصلی">
        <div className="brand" title="CPGMeet — جلسات سازمانی">
          <img className="brand-logo" src="/icons/icon-64.png" alt="CPGMeet" width="40" height="40" />
          <div className="brand-text">
            <strong>CPGMeet</strong>
            <span>جلسات سازمانی</span>
          </div>
        </div>
        <nav className="nav-list">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-btn ${view === item.id ? "active" : ""}`}
              aria-current={view === item.id ? "page" : undefined}
              onClick={() => {
                item.onClick?.();
                setView(item.id);
              }}
            >
              <NavIcon name={item.icon} />
              <span className="nav-label">{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <div className="sidebar-foot">
          {notifPerm === "default" ? (
            <button
              className="nav-btn nav-btn-notif"
              type="button"
              onClick={async () => {
                try {
                  await Notification.requestPermission();
                } catch {
                  /* ignore */
                }
                setNotifPerm(notifPermission());
              }}
            >
              <NavIcon name="bell" />
              <span className="nav-label">اجازه نوتیف</span>
            </button>
          ) : null}
          <div className="user-chip" title={displayName}>
            <span className="user-avatar" aria-hidden="true">
              {displayName.trim().charAt(0) || "?"}
            </span>
            <span className="user-name">{displayName}</span>
          </div>
          <button className="nav-btn nav-btn-logout" type="button" onClick={logout}>
            <NavIcon name="logout" />
            <span className="nav-label">خروج</span>
          </button>
        </div>
      </aside>

      <main className="main" ref={mainRef}>
        {toast ? (
          <div className="panel" style={{ marginBottom: "1rem", background: "#ebf8ff" }}>
            {toast}
            <button className="btn secondary" style={{ marginRight: "0.75rem" }} onClick={() => setToast("")}>
              بستن
            </button>
          </div>
        ) : null}
        {error ? <div className="error">{error}</div> : null}

        {view === VIEWS.week && (
          <div className="panel">
            <div className="week-nav">
              <button className="btn secondary week-prev" onClick={() => setWeekAnchor(addDays(weekAnchor, -7))}>
                هفته قبل
              </button>
              <h2 className="week-title" style={{ margin: 0 }}>تقویم هفتگی</h2>
              <button className="btn secondary week-next" onClick={() => setWeekAnchor(addDays(weekAnchor, 7))}>
                هفته بعد
              </button>
              <button className="btn secondary week-today" onClick={() => setWeekAnchor(startOfWeek(new Date()))}>
                امروز
              </button>
            </div>
            <div className="week-grid">
              {weekDays.map((day) => {
                const items = meetings.filter((m) => {
                  const s = new Date(m.start_at);
                  return sameDay(s, day);
                });
                return (
                  <div key={day.toISOString()} className={`day-col ${sameDay(day, new Date()) ? "today" : ""}`}>
                    <div className="day-head">{dayLabel(day)}</div>
                    {items.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        className={`meeting-chip ${m.status === "cancelled" ? "cancelled" : ""}`}
                        onClick={() => openDetail(m.id)}
                      >
                        {m.title}
                        <small>
                          {formatTimeFa(m.start_at)} — {formatTimeFa(m.end_at)}
                        </small>
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {view === VIEWS.list && (
          <div className="panel">
            <h2>جلسات من</h2>
            <div className="list-filters">
              {[
                { id: "all", label: "همه" },
                { id: "upcoming", label: "آینده" },
                { id: "past", label: "گذشته" },
                { id: "cancelled", label: "لغو شده" }
              ].map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={`chip-filter ${listFilter === f.id ? "active" : ""}`}
                  onClick={() => setListFilter(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className="list">
              {myList.length === 0 ? (
                <p className="muted">جلسه‌ای نیست.</p>
              ) : (
                myList.map((m) => (
                    <button key={m.id} type="button" className="list-item" onClick={() => openDetail(m.id)}>
                      <h3>
                        {m.title}
                        {m.status === "cancelled" ? (
                          <span className="badge cancelled">لغو شده</span>
                        ) : (
                          <span className={`badge ${m._mine}`}>{rsvpLabel(m._mine)}</span>
                        )}
                      </h3>
                      <div className="muted">{formatFa(m.start_at)}</div>
                      {m.location ? <div className="muted">{m.location}</div> : null}
                    </button>
                  ))
              )}
            </div>
          </div>
        )}

        {view === VIEWS.form && (
          <MeetingForm
              users={users}
              companies={companyCatalog}
            principals={principals}
            currentUser={user}
            initial={editing}
            busy={busy}
            onCancel={() => setView(VIEWS.week)}
            onSave={saveMeeting}
          />
        )}

        {view === VIEWS.admin && isAdmin ? (
          <AdminDirectory busy={busy} setBusy={setBusy} onPeopleChanged={() => loadUsers().catch(() => {})} onBackToMeetings={() => setView(VIEWS.week)} />
        ) : null}

        {view === VIEWS.delegates && isAdmin ? (
          <DelegatesAdmin users={users} busy={busy} setBusy={setBusy} />
        ) : null}

        {view === VIEWS.detail && selected && (
          <div className="panel detail">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2 style={{ margin: 0 }}>{selected.title}</h2>
              {selected.status === "cancelled" ? <span className="badge cancelled">لغو شده</span> : null}
            </div>
            <dl>
              <dt>برگزارکننده</dt>
              <dd>
                {(() => {
                  const org = users.find((x) => Number(x.id) === Number(selected.organizer_id));
                  const creator =
                    selected.created_by_id != null
                      ? users.find((x) => Number(x.id) === Number(selected.created_by_id))
                      : null;
                  const orgName = org ? userLabel(org) : `کاربر #${selected.organizer_id}`;
                  const creatorName = creator
                    ? userLabel(creator)
                    : selected.created_by_id != null
                      ? `کاربر #${selected.created_by_id}`
                      : "";
                  if (
                    selected.on_behalf ||
                    (selected.created_by_id != null &&
                      Number(selected.created_by_id) !== Number(selected.organizer_id))
                  ) {
                    return (
                      <>
                        {orgName}
                        <div className="muted" style={{ marginTop: "0.25rem" }}>
                          ثبت‌شده توسط {creatorName} از طرف {orgName}
                        </div>
                      </>
                    );
                  }
                  return orgName;
                })()}
              </dd>
              <dt>شروع</dt>
              <dd>{formatFa(selected.start_at)}</dd>
              <dt>پایان</dt>
              <dd>{formatFa(selected.end_at)}</dd>
              <dt>مکان</dt>
              <dd>{selected.location || "—"}</dd>
              <dt>پذیرایی</dt>
              <dd>
                {Number(selected.needs_catering)
                  ? [
                      Number(selected.catering_tea) ? "چای" : null,
                      Number(selected.catering_coffee) ? "قهوه" : null,
                      Number(selected.catering_sweets) ? "شیرینی" : null
                    ]
                      .filter(Boolean)
                      .join("، ") || "بله"
                  : "خیر"}
              </dd>
              <dt>توضیحات</dt>
              <dd style={{ whiteSpace: "pre-wrap" }}>{selected.body || "—"}</dd>
              <dt>RSVP شما</dt>
              <dd>
                <span className={`badge ${myRsvp(selected, user.id)}`}>
                  {rsvpLabel(myRsvp(selected, user.id))}
                </span>
              </dd>
              <dt>شرکت‌کنندگان</dt>
              <dd>
                {(selected.participants || []).map((p) => {
                  const u = users.find((x) => Number(x.id) === Number(p.user_id));
                  return (
                    <div key={p.user_id}>
                      {u?.name || u?.email || `کاربر #${p.user_id}`}{" "}
                      <span className={`badge ${p.rsvp}`}>{rsvpLabel(p.rsvp)}</span>
                    </div>
                  );
                })}
              </dd>
              <dt>شرکت‌ها</dt>
              <dd>
                {(selected.companies || []).length === 0 ? (
                  <span className="muted">—</span>
                ) : (
                  (selected.companies || []).map((c) => (
                    <div key={c.id || c.company_id}>{c.name || c.id}</div>
                  ))
                )}
              </dd>
            </dl>

            <MeetingFilesSection
              meeting={selected}
              user={user}
              canManage={canManageMeetingUi(selected, user, principals)}
              onChanged={() => openDetail(selected.id)}
            />

            {selected.status !== "cancelled" ? (
              <div className="row" style={{ marginBottom: "0.75rem" }}>
                <button className="btn" onClick={() => sendRsvp(selected.id, "accepted")}>
                  قبول
                </button>
                <button className="btn secondary" onClick={() => sendRsvp(selected.id, "maybe")}>
                  شاید
                </button>
                <button className="btn danger" onClick={() => sendRsvp(selected.id, "declined")}>
                  رد
                </button>
              </div>
            ) : null}
            <div className="row">
              <button className="btn secondary" onClick={() => downloadIcs(selected.id)}>
                دانلود ICS
              </button>
              {canManageMeetingUi(selected, user, principals) && selected.status !== "cancelled" ? (
                <button
                  className="btn secondary"
                  onClick={() => {
                    setEditing(selected);
                    setView(VIEWS.form);
                  }}
                >
                  ویرایش
                </button>
              ) : null}
              {canCancelMeetingUi(selected, user) && selected.status !== "cancelled" ? (
                <button className="btn danger" onClick={() => cancelMeeting(selected.id)}>
                  لغو جلسه
                </button>
              ) : null}
              <button className="btn secondary" onClick={() => setView(VIEWS.week)}>
                بازگشت
              </button>
            </div>
          </div>
        )}

        {view === VIEWS.detail && !selected ? (
          <div className="panel">
            <p className="muted">جلسه پیدا نشد.</p>
            <button className="btn secondary" onClick={() => setView(VIEWS.week)}>
              بازگشت
            </button>
          </div>
        ) : null}
      </main>
    </div>
  );
}
