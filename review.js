// VeFlow — operator review page (review.html). One person's tool: reads the
// activity log of every company and shows one digest. Requires the signed-in
// account's users document to carry operator: true, set only from the
// Firebase console; the server rules enforce it, this page merely reports
// what the server allows.
import { auth, db, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "./firebase-init.js";
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { classifyEntries, fetchEntriesSince } from "./audit.js";

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const MARKER_KEY = "veflowOperatorReview";
function markers() {
  try { return JSON.parse(localStorage.getItem(MARKER_KEY) || "{}"); } catch { return {}; }
}
function sinceFor(cid) {
  return markers()[cid] || new Date(Date.now() - 86400000).toISOString();
}
function markAll(cids) {
  const m = markers();
  const now = new Date().toISOString();
  cids.forEach(c => { m[c] = now; });
  localStorage.setItem(MARKER_KEY, JSON.stringify(m));
}

function showLogin(msg) {
  $("report").style.display = "none";
  $("login").style.display = "flex";
  const err = $("login-error");
  if (msg) { err.textContent = msg; err.classList.add("show"); } else { err.classList.remove("show"); }
  $("login-btn").disabled = false; $("login-btn").textContent = "Sign in";
}

let companies = [];   // { id, name }

async function loadCompanies() {
  // Company list = the settings collection, which the rules open to the
  // operator flag (and to nobody else beyond their own document).
  const snap = await getDocs(collection(db, "settings"));
  companies = snap.docs
    .map(d => ({ id: d.id, name: d.data().companyName || d.id }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const p2 = n => String(n).padStart(2, "0");
const fmt = d => `${p2(d.getDate())}/${p2(d.getMonth() + 1)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;

async function runReview() {
  const list = $("op-list");
  list.innerHTML = `<div class="empty">Checking ${companies.length} compan${companies.length === 1 ? "y" : "ies"}\u2026</div>`;
  const blocks = [];
  let totalWarn = 0;
  for (const c of companies) {
    let entries = [];
    let error = "";
    try { entries = await fetchEntriesSince(c.id, sinceFor(c.id)); }
    catch (e) { error = e?.code || e?.message || String(e); }
    const findings = error ? [] : classifyEntries(entries, null);
    totalWarn += findings.filter(f => f.level === "warn").length;
    const rows = error
      ? `<div class="op-row">Couldn't read this company's log (${esc(error)}).</div>`
      : findings.length === 0
        ? `<div class="op-quiet">Quiet \u2014 ${entries.length} action${entries.length === 1 ? "" : "s"}, none on the watch list (since ${esc(fmt(new Date(sinceFor(c.id))))}).</div>`
        : findings.slice(0, 20).map(f => `
            <div class="op-row"><span class="op-when">${esc(fmt(f.at))}</span>${f.level === "warn" ? "<strong>Look:</strong> " : ""}${esc(f.text)} <span class="op-quiet">\u2014 ${esc(f.why)}</span></div>`).join("")
          + (findings.length > 20 ? `<div class="op-quiet">+ ${findings.length - 20} more \u2014 open that company's Settings \u2192 Activity log.</div>` : "");
    blocks.push(`<div class="op-company"><h3>${esc(c.name)}</h3>${rows}</div>`);
  }
  $("op-range").textContent = totalWarn
    ? `${totalWarn} item${totalWarn === 1 ? "" : "s"} to look at`
    : "All quiet";
  list.innerHTML = blocks.join("") || `<div class="empty">No companies found.</div>`;
}

async function start(user) {
  $("login").style.display = "none";
  $("report").style.display = "block";
  try {
    // A first, cheap probe with a clear answer: can this account see beyond
    // its own company? If not, say why instead of listing nine errors.
    await loadCompanies();
    if (companies.length <= 1) {
      $("op-list").innerHTML = `<div class="empty">This account can see ${companies.length} company. The operator flag is probably missing: in the Firebase console, open Firestore \u2192 users \u2192 the document named after this account's UID, and add a field <strong>operator</strong> (boolean) = <strong>true</strong>. Then press Check again.</div>`;
      $("op-range").textContent = "";
      return;
    }
    await runReview();
  } catch (e) {
    const code = e?.code || e?.message || String(e);
    $("op-list").innerHTML = /permission/.test(code)
      ? `<div class="empty">The server refused (${esc(code)}). Either the operator flag is missing on this account's users document, or the pilot-38 rules are not published yet.</div>`
      : `<div class="empty">Couldn't load (${esc(code)}).</div>`;
  }
}

$("login-btn").addEventListener("click", async () => {
  const btn = $("login-btn");
  btn.disabled = true; btn.textContent = "Signing in...";
  try {
    await signInWithEmailAndPassword(auth, $("login-email").value.trim(), $("login-password").value);
  } catch (e) {
    showLogin("Couldn't sign in (" + (e.code || e.message) + ").");
  }
});
$("login-password").addEventListener("keydown", e => { if (e.key === "Enter") $("login-btn").click(); });

$("op-refresh").addEventListener("click", runReview);
$("op-mark").addEventListener("click", () => { markAll(companies.map(c => c.id)); runReview(); });
$("op-signout").addEventListener("click", async () => { await signOut(auth); location.reload(); });

onAuthStateChanged(auth, user => {
  if (user) start(user);
  else showLogin();
});
