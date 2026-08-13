/**
 * "LegacyCU" — a deliberately hostile mock of a legacy credit-union back-office app.
 * Stand-in for a vendor core-banking UI: server-rendered, table-based layout,
 * no test IDs, ASP.NET-style control ids, nested tables, framesets vibes.
 *
 * Injectable runtime conditions (for demos of error handling):
 *   - member 99999            -> "No member found" (business outcome)
 *   - member 55555            -> "Access denied" on detail (permission denial)
 *   - deposit < 25            -> validation error on sub-account form
 *   - ?inject=interstitial    -> one-time maintenance notice dialog on next page
 *   - ?inject=slow            -> 4s delay on the next search
 *   - ?inject=expire          -> session expires after the next page load
 */
import express from "express";
import { pathToFileURL } from "node:url";

const app = express();
app.use(express.urlencoded({ extended: false }));

export const PORT = 4173;

// ---------- state ----------
interface Session {
  user: string;
  // one-shot chaos flags
  interstitial: boolean;
  slow: boolean;
  expireNext: boolean;
  expired: boolean;
  pendingSubAccount?: { memberId: string; type: string; nickname: string; deposit: string };
}
const sessions = new Map<string, Session>();
let sidCounter = 1;

interface Member {
  id: string;
  name: string;
  savings: string;
  checking: string;
  since: string;
  subAccounts: { num: string; type: string; nickname: string; balance: string }[];
}
const members = new Map<string, Member>([
  ["12345", { id: "12345", name: "MARGARET T HOLLOWAY", savings: "$4,382.19", checking: "$1,027.55", since: "03/14/1998", subAccounts: [] }],
  ["23456", { id: "23456", name: "DEREK A OYELARAN", savings: "$912.03", checking: "$3,441.87", since: "11/02/2007", subAccounts: [] }],
  ["34567", { id: "34567", name: "LUCIA F BRANDT", savings: "$18,204.66", checking: "$254.10", since: "06/21/2015", subAccounts: [] }],
  // restricted record: searchable, but detail access is denied (permission demo)
  ["55555", { id: "55555", name: "RESTRICTED — BOARD MEMBER", savings: "$0.00", checking: "$0.00", since: "01/01/1990", subAccounts: [] }],
]);
let acctCounter = 7001;

// ---------- helpers ----------
function getSession(req: express.Request): Session | undefined {
  const m = /sid=(\w+)/.exec(req.headers.cookie ?? "");
  return m ? sessions.get(m[1]!) : undefined;
}

function absorbInject(req: express.Request, s: Session) {
  const inj = req.query.inject;
  if (inj === "interstitial") s.interstitial = true;
  if (inj === "slow") s.slow = true;
  if (inj === "expire") s.expireNext = true;
}

/** Legacy chrome: nested tables, inline styles, no semantics. */
function page(title: string, body: string, opts?: { notice?: boolean }) {
  const notice = opts?.notice
    ? `<div id="sysNotice" style="position:absolute;top:120px;left:30%;width:380px;border:2px outset #808080;background:#ffffe1;padding:8px;z-index:9;font-size:11px;">
        <table width="100%" cellpadding="2" cellspacing="0"><tr><td><b>SYSTEM NOTICE</b></td></tr>
        <tr><td>Scheduled maintenance window Sunday 02:00–04:00 CT. Batch postings may be delayed.</td></tr>
        <tr><td align="center"><form method="get" action=""><input type="submit" value="OK"></form></td></tr></table>
      </div>`
    : "";
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">
<html><head><title>LegacyCU :: ${title}</title>
<style>body{font-family:Tahoma,Arial,sans-serif;font-size:11px;background:#d4d0c8;margin:0}
a{color:#003399} td{font-size:11px} .hdr{background:#003366;color:#fff;font-weight:bold;padding:4px 8px}
.box{border:2px inset #808080;background:#fff;padding:6px} .errbox{border:1px solid #cc0000;background:#fff0f0;color:#cc0000;padding:4px;margin:4px 0}
input,select{font-size:11px} .btn{border:2px outset #d4d0c8;background:#d4d0c8;padding:1px 10px}</style></head>
<body>${notice}
<table width="100%" cellpadding="0" cellspacing="0"><tr><td class="hdr">LegacyCU Core Banking System v6.2.14 &nbsp;&nbsp;|&nbsp;&nbsp; ${title}</td></tr></table>
<table width="100%" cellpadding="8" cellspacing="0"><tr>
<td width="140" valign="top"><table cellpadding="2" cellspacing="0" class="box" width="100%">
<tr><td><a href="/">Teller Desk</a></td></tr><tr><td><a href="/members">Member Search</a></td></tr>
<tr><td><a href="/reports">Reports</a></td></tr><tr><td><a href="/logout">Sign Off</a></td></tr></table></td>
<td valign="top">${body}</td></tr></table>
<table width="100%" cellpadding="4"><tr><td align="center" style="color:#666">CONFIDENTIAL — For authorized institution personnel only</td></tr></table>
</body></html>`;
}

/** Guard: session + chaos handling. Returns session or sends redirect/expiry page. */
function requireSession(req: express.Request, res: express.Response): Session | undefined {
  const s = getSession(req);
  if (!s || s.expired) {
    if (s?.expired) {
      res.status(440).send(page("Signed Off", `<div class="box"><b>Session expired.</b> Your session has timed out due to inactivity.<br><br><a href="/login">Return to sign-on</a></div>`));
    } else {
      res.redirect("/login");
    }
    return undefined;
  }
  absorbInject(req, s);
  if (s.expireNext) { s.expireNext = false; s.expired = true; }
  return s;
}

function popNotice(s: Session): boolean {
  if (s.interstitial) { s.interstitial = false; return true; }
  return false;
}

// ---------- routes ----------
// inject requested before sign-on (no session yet): apply to the next session
let pendingInject: string | undefined;

app.get("/login", (req, res) => {
  if (typeof req.query.inject === "string") pendingInject = req.query.inject;
  res.send(page("Sign On", `
<table cellpadding="0" cellspacing="0" width="420"><tr><td class="box">
<form method="post" action="/login">
<table cellpadding="4" cellspacing="0">
<tr><td colspan="2"><b>Operator Sign-On</b></td></tr>
<tr><td>Operator ID:</td><td><input type="text" name="txtUser" id="ctl00_main_txt1" size="18"></td></tr>
<tr><td>Password:</td><td><input type="password" name="txtPass" id="ctl00_main_txt2" size="18"></td></tr>
<tr><td></td><td><input type="submit" class="btn" value="Sign On" id="ctl00_main_btn1"></td></tr>
</table></form></td></tr></table>`));
});

app.post("/login", (req, res) => {
  const { txtUser, txtPass } = req.body;
  if (txtUser === "demo" && txtPass === "demo123") {
    const sid = `s${sidCounter++}${Math.floor(Math.random() * 1e6)}`;
    const sess: Session = { user: txtUser, interstitial: false, slow: false, expireNext: false, expired: false };
    if (pendingInject === "interstitial") sess.interstitial = true;
    if (pendingInject === "slow") sess.slow = true;
    if (pendingInject === "expire") sess.expireNext = true;
    pendingInject = undefined;
    sessions.set(sid, sess);
    res.setHeader("Set-Cookie", `sid=${sid}; HttpOnly`);
    res.redirect("/");
  } else {
    res.send(page("Sign On", `<div class="errbox">Invalid operator ID or password.</div><a href="/login">Try again</a>`));
  }
});

app.get("/logout", (req, res) => {
  const m = /sid=(\w+)/.exec(req.headers.cookie ?? "");
  if (m) sessions.delete(m[1]!);
  res.redirect("/login");
});

app.get("/", (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  res.send(page("Teller Desk", `
<div class="box"><b>Welcome, operator ${s.user.toUpperCase()}.</b><br><br>
<table cellpadding="3" cellspacing="0">
<tr><td>&raquo;</td><td><a href="/members">Member Search</a> — locate a member record</td></tr>
<tr><td>&raquo;</td><td><a href="/reports">Daily Reports</a></td></tr>
</table></div>`, { notice: popNotice(s) }));
});

app.get("/reports", (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  res.send(page("Reports", `<div class="box">Report generation is available between 06:00 and 20:00 CT at the branch console only.</div>`, { notice: popNotice(s) }));
});

app.get("/members", (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  res.send(page("Member Search", `
<table cellpadding="0" cellspacing="0" width="520"><tr><td class="box">
<form method="post" action="/members/search">
<table cellpadding="4" cellspacing="0">
<tr><td colspan="3"><b>Member Inquiry</b></td></tr>
<tr><td>Member Number:</td><td><input type="text" name="q" id="ctl00_cph_txtMbr" size="14"></td>
<td><input type="submit" class="btn" value="Search" id="ctl00_cph_btnGo"></td></tr>
</table></form></td></tr></table>`, { notice: popNotice(s) }));
});

app.post("/members/search", async (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  if (s.slow) { s.slow = false; await new Promise(r => setTimeout(r, 4000)); }
  const q = String(req.body.q ?? "").trim();
  const m = members.get(q);
  if (!m) {
    res.send(page("Member Search", `
<table cellpadding="0" cellspacing="0" width="520"><tr><td class="box">
<b>Member Inquiry</b><div class="errbox">No member found for number "${q.replace(/</g, "&lt;")}". Verify the member number and try again.</div>
<a href="/members">New search</a></td></tr></table>`, { notice: popNotice(s) }));
    return;
  }
  res.send(page("Member Search", `
<table cellpadding="0" cellspacing="0" width="560"><tr><td class="box">
<b>Search Results</b><br><br>
<table width="100%" cellpadding="3" cellspacing="1" bgcolor="#808080">
<tr bgcolor="#c0c0c0"><td><b>Member #</b></td><td><b>Name</b></td><td><b>Member Since</b></td><td></td></tr>
<tr bgcolor="#ffffff"><td>${m.id}</td><td>${m.name}</td><td>${m.since}</td>
<td><a href="/member/${m.id}">View</a></td></tr>
</table></td></tr></table>`, { notice: popNotice(s) }));
});

app.get("/member/:id", (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  const id = req.params.id;
  if (id === "55555") {
    res.status(403).send(page("Member Detail", `<div class="errbox"><b>Access denied.</b> Your operator role does not permit viewing restricted membership records. Contact a supervisor.</div>`));
    return;
  }
  const m = members.get(id!);
  if (!m) {
    res.send(page("Member Detail", `<div class="errbox">No member found for number "${id}".</div>`));
    return;
  }
  const subs = m.subAccounts.length
    ? m.subAccounts.map(a => `<tr bgcolor="#ffffff"><td>${a.num}</td><td>${a.type}</td><td>${a.nickname}</td><td align="right">${a.balance}</td></tr>`).join("")
    : `<tr bgcolor="#ffffff"><td colspan="4" align="center">(none)</td></tr>`;
  res.send(page("Member Detail", `
<table cellpadding="0" cellspacing="0" width="620"><tr><td class="box">
<b>Member Record — ${m.id}</b><br><br>
<table width="100%" cellpadding="3" cellspacing="1" bgcolor="#808080">
<tr bgcolor="#c0c0c0"><td width="160"><b>Name</b></td><td>${m.name}</td></tr>
<tr bgcolor="#ffffff"><td><b>Member Since</b></td><td>${m.since}</td></tr>
<tr bgcolor="#ffffff"><td><b>Savings Balance</b></td><td id="ctl00_cph_lblSav">${m.savings}</td></tr>
<tr bgcolor="#ffffff"><td><b>Checking Balance</b></td><td>${m.checking}</td></tr>
</table><br>
<b>Sub-Accounts</b>
<table width="100%" cellpadding="3" cellspacing="1" bgcolor="#808080">
<tr bgcolor="#c0c0c0"><td><b>Acct #</b></td><td><b>Type</b></td><td><b>Nickname</b></td><td align="right"><b>Balance</b></td></tr>
${subs}
</table><br>
<a href="/member/${m.id}/subaccount/new">Open New Sub-Account</a> &nbsp;|&nbsp; <a href="/members">Back to search</a>
</td></tr></table>`, { notice: popNotice(s) }));
});

app.get("/member/:id/subaccount/new", (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  const m = members.get(req.params.id!); if (!m) { res.redirect("/members"); return; }
  res.send(page("New Sub-Account", subAccountForm(m, {}, "")));
});

function subAccountForm(m: Member, vals: Record<string, string>, err: string) {
  return `
<table cellpadding="0" cellspacing="0" width="560"><tr><td class="box">
<b>Open Sub-Account — Member ${m.id} (${m.name})</b>
${err ? `<div class="errbox">${err}</div>` : ""}
<form method="post" action="/member/${m.id}/subaccount/new">
<table cellpadding="4" cellspacing="0">
<tr><td>Account Type:</td><td><select name="ddlType" id="ctl00_cph_ddlType">
<option value="">-- select --</option>
<option value="SAV"${vals.ddlType === "SAV" ? " selected" : ""}>Secondary Savings</option>
<option value="CLB"${vals.ddlType === "CLB" ? " selected" : ""}>Holiday Club</option>
<option value="MMA"${vals.ddlType === "MMA" ? " selected" : ""}>Money Market</option>
</select></td></tr>
<tr><td>Nickname:</td><td><input type="text" name="txtNick" id="ctl00_cph_txtNick" size="24" value="${vals.txtNick ?? ""}"></td></tr>
<tr><td>Initial Deposit ($):</td><td><input type="text" name="txtDep" id="ctl00_cph_txtDep" size="10" value="${vals.txtDep ?? ""}"> <span style="color:#666">(minimum $25.00)</span></td></tr>
<tr><td></td><td><input type="submit" class="btn" value="Continue" id="ctl00_cph_btnCont"></td></tr>
</table></form></td></tr></table>`;
}

app.post("/member/:id/subaccount/new", (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  const m = members.get(req.params.id!); if (!m) { res.redirect("/members"); return; }
  const { ddlType, txtNick, txtDep } = req.body;
  const dep = parseFloat(String(txtDep));
  let err = "";
  if (!ddlType) err = "Account Type is required.";
  else if (!txtNick || String(txtNick).trim().length < 2) err = "Nickname is required (2+ characters).";
  else if (!(dep >= 25)) err = "Initial deposit must be at least $25.00.";
  if (err) { res.send(page("New Sub-Account", subAccountForm(m, req.body, err), { notice: popNotice(s) })); return; }
  s.pendingSubAccount = { memberId: m.id, type: ddlType, nickname: txtNick, deposit: dep.toFixed(2) };
  res.redirect(`/member/${m.id}/subaccount/confirm`);
});

app.get("/member/:id/subaccount/confirm", (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  const p = s.pendingSubAccount;
  if (!p || p.memberId !== req.params.id) { res.redirect("/members"); return; }
  const typeNames: Record<string, string> = { SAV: "Secondary Savings", CLB: "Holiday Club", MMA: "Money Market" };
  res.send(page("Confirm Sub-Account", `
<table cellpadding="0" cellspacing="0" width="560"><tr><td class="box">
<b>Confirm New Sub-Account</b><br><br>
<table width="100%" cellpadding="3" cellspacing="1" bgcolor="#808080">
<tr bgcolor="#ffffff"><td width="160"><b>Member</b></td><td>${p.memberId}</td></tr>
<tr bgcolor="#ffffff"><td><b>Type</b></td><td>${typeNames[p.type] ?? p.type}</td></tr>
<tr bgcolor="#ffffff"><td><b>Nickname</b></td><td>${p.nickname}</td></tr>
<tr bgcolor="#ffffff"><td><b>Initial Deposit</b></td><td>$${p.deposit}</td></tr>
</table><br>
<b>This action will create a new account record and cannot be undone from this console.</b><br><br>
<form method="post" action="/member/${p.memberId}/subaccount/confirm" style="display:inline">
<input type="submit" class="btn" value="Create Account" id="ctl00_cph_btnCreate"></form>
&nbsp; <a href="/member/${p.memberId}/subaccount/new">Go back</a>
</td></tr></table>`, { notice: popNotice(s) }));
});

app.post("/member/:id/subaccount/confirm", (req, res) => {
  const s = requireSession(req, res); if (!s) return;
  const p = s.pendingSubAccount;
  if (!p || p.memberId !== req.params.id) { res.redirect("/members"); return; }
  const m = members.get(p.memberId)!;
  const num = `${m.id}-S${acctCounter++}`;
  const typeNames: Record<string, string> = { SAV: "Secondary Savings", CLB: "Holiday Club", MMA: "Money Market" };
  m.subAccounts.push({ num, type: typeNames[p.type] ?? p.type, nickname: p.nickname, balance: `$${p.deposit}` });
  s.pendingSubAccount = undefined;
  res.send(page("Sub-Account Created", `
<table cellpadding="0" cellspacing="0" width="560"><tr><td class="box">
<b>Sub-Account Created Successfully</b><br><br>
New account number: <b id="ctl00_cph_lblAcct">${num}</b><br><br>
<a href="/member/${m.id}">Return to member record</a>
</td></tr></table>`, { notice: popNotice(s) }));
});

/** Start the app; resolves once listening. Exported so tests can host it in-process. */
export function startTargetApp(): Promise<import("node:http").Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(PORT, () => {
      console.log(`LegacyCU running at http://localhost:${PORT}  (sign on: demo / demo123)`);
      resolve(server);
    });
    server.on("error", reject);
  });
}

// auto-start only when run directly (npm run target-app), not when imported
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startTargetApp().catch((e) => { console.error(e); process.exit(1); });
}
