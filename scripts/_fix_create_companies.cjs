const fs = require("fs");
const p = "server/src/index.js";
let s = fs.readFileSync(p, "utf8");
if (!s.includes("setMeetingCompanies(meetingId, req.body")) {
  const needle = `  for (const pid of participantIds) {
    const rsvp = pid === organizerId || pid === createdById ? "accepted" : "pending";
    insertP.run(meetingId, pid, rsvp);
  }

  const meeting = getMeeting(meetingId);`;
  const insert = `  for (const pid of participantIds) {
    const rsvp = pid === organizerId || pid === createdById ? "accepted" : "pending";
    insertP.run(meetingId, pid, rsvp);
  }

  setMeetingCompanies(meetingId, req.body?.company_ids);

  const meeting = getMeeting(meetingId);`;
  const n = needle.replace(/\n/g, "\r\n");
  const i = insert.replace(/\n/g, "\r\n");
  if (s.includes(needle)) s = s.replace(needle, insert);
  else if (s.includes(n)) s = s.replace(n, i);
  else { console.error("create block missing"); process.exit(1); }
  fs.writeFileSync(p, s);
  console.log("create patched");
} else console.log("create already ok");
