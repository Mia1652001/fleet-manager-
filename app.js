// VeFlow — main controller.
// Signs the user in, loads all company data once, keeps it live, and switches
// between views without ever reloading the page.

import { db, auth, signInWithEmailAndPassword, signOut, onAuthStateChanged, setSync, sendPasswordResetEmail } from "./firebase-init.js";
import { collection, query, where, onSnapshot, doc, getDoc, getDocFromServer, terminate, clearIndexedDbPersistence } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { state, notifyDataChange, bookingCarLabel, rentalDays, rateFor, rentalTotal, advancePaid, balanceFor, bookingRef, loadPref, savePref, bankCharge, bankChargePct, amountDue, applyTheme, APP_VERSION, esc } from "./store.js";
import { logEvent } from "./audit.js";

import * as fleet from "./view-fleet.js";
import * as bookings from "./view-bookings.js";
import * as customers from "./view-customers.js";
import * as billing from "./view-billing.js";
import * as maintenance from "./view-maintenance.js";
import * as tasks from "./view-tasks.js";
import * as dashboard from "./view-dashboard.js";
import * as settings from "./view-settings.js";
import * as expenses from "./view-expenses.js";
import * as reports from "./view-reports.js";
import { backupDue, backupPrefs, daysSinceBackup, runBackup } from "./backup.js";
import { mountBookingForm, onBookingChange } from "./booking-form.js";

const VIEWS = {
  dashboard: { mod: dashboard, root: null },
  fleet: { mod: fleet, root: null },
  bookings: { mod: bookings, root: null },
  customers: { mod: customers, root: null },
  billing: { mod: billing, root: null },
  reports: { mod: reports, root: null },
  maintenance: { mod: maintenance, root: null },
  tasks: { mod: tasks, root: null },
  expenses: { mod: expenses, root: null },
  settings: { mod: settings, root: null }
};

// True once the interface has been wired up. This must never be set back to
// false: the views stay in the DOM across a sign-out, so wiring them a second
// time would attach a second copy of every click handler.
let wired = false;
let unsubs = [];
// True between pressing "Sign in" and the profile loading, so the activity
// log can tell a real sign-in from the app merely being reopened with a
// remembered session.
let freshLogin = false;

// Which collections have delivered at least once since sign-in. The automatic
// backup must not run before all of them have: 2.5 seconds after opening, a
// fresh device or a slow connection may not have loaded anything yet, and a
// backup built from that would be an empty file that silently replaces the
// reminder to take a real one.
let loadedCollections = new Set();
const ALL_COLLECTIONS = 6; // cars, bookings, customers, tasks, expenses, settings
function allDataLoaded() { return loadedCollections.size >= ALL_COLLECTIONS; }

// ---------- Boot ----------
onAuthStateChanged(auth, async (user) => {
  document.getElementById("boot").style.display = "none";

  if (!user) {
    stopListeners();
    showLogin();
    return;
  }

  try {
    // A known Safari + long-polling quirk can fire the first read before the
    // sign-in token is attached; the server then correctly denies what looks
    // like an anonymous request. One retry with a forcibly refreshed token
    // separates that race from a real denial — and fixes it when it is one.
    // Server-first for the profile: an account created a minute ago exists on
    // the server but not in this device's cache, and the cache once answered
    // "no such profile" for a brand-new company. Cache is only the offline
    // fallback.
    const readProfile = async () => {
      try { return await getDocFromServer(doc(db, "users", user.uid)); }
      catch (e) {
        if ((e.code || "") === "unavailable") return await getDoc(doc(db, "users", user.uid));
        throw e;
      }
    };
    let snap;
    try {
      snap = await readProfile();
    } catch (e1) {
      if ((e1.code || "") !== "permission-denied") throw e1;
      console.warn("First profile read denied — refreshing the sign-in token and retrying once.", e1);
      try { await user.getIdToken(true); } catch {}
      await new Promise(r => setTimeout(r, 900));
      snap = await readProfile();
    }
    if (!snap.exists() || !snap.data().companyId) {
      await signOut(auth);
      showLogin("This account isn't linked to a company yet. Contact your administrator.");
      return;
    }
    state.ctx = {
      user,
      companyId: snap.data().companyId,
      companyName: snap.data().companyName || snap.data().companyId,
      // access level, set per login in the console. Missing = admin, so every
      // existing login keeps exactly the access it has today.
      role: snap.data().role || "admin"
    };
    // Recorded in the company's activity log: a sign-in, or the app being
    // reopened with a remembered session. Never awaited — the log must not
    // delay the screen.
    logEvent(freshLogin ? "sign-in" : "session");
    freshLogin = false;
    startApp();
  } catch (e) {
    // The full error goes to the console too: the on-screen message names the
    // code, but diagnosing a denial needs the whole object — and a swallowed
    // error left the console empty at exactly the moment it was needed.
    console.error("Profile load failed for uid " + (user?.uid || "?") + ":", e);

    // A double denial for a signed-in user with a fresh token means the local
    // Firestore state is poisoned — seen in the wild on Safari: the cached
    // connection presents no credentials however valid the sign-in is. The
    // device-side cure is wiping that state, which users of the installed app
    // cannot do by hand — so the app does it for itself, once, and reloads.
    // The one-shot flag stops any possibility of a reload loop.
    if ((e.code || "") === "permission-denied" && !sessionStorage.getItem("fm-cache-reset")) {
      sessionStorage.setItem("fm-cache-reset", "1");
      console.warn("Clearing local Firestore state and reloading once to recover.");
      try { await terminate(db); await clearIndexedDbPersistence(db); } catch (e2) {
        console.warn("Local state clear failed:", e2);
      }
      location.reload();
      return;
    }
    // Firestore's local database can be left corrupted by a mid-session
    // cache wipe (Safari, 20 Aug 2026). That is repairable: delete our own
    // IndexedDB and reload — once, guarded, so a genuine server error can
    // never cause a reload loop.
    const msg = String(e && (e.code || e.message) || "");
    if (/INTERNAL ASSERTION/i.test(msg) && !sessionStorage.getItem("fsRepaired")) {
      sessionStorage.setItem("fsRepaired", "1");
      try {
        const dbs = (indexedDB.databases ? await indexedDB.databases() : []) || [];
        await Promise.all(dbs
          .filter(d => /firestore/i.test(d.name || ""))
          .map(d => new Promise(res => {
            const rq = indexedDB.deleteDatabase(d.name);
            rq.onsuccess = rq.onerror = rq.onblocked = () => res();
          })));
      } catch (_) { /* the reload is the repair; deletion is best-effort */ }
      location.reload();
      return;
    }
    showLogin("Signed in, but couldn't load your profile (" + msg + ").");
  }
});

function showLogin(msg) {
  document.getElementById("app").style.display = "none";
  document.getElementById("login").style.display = "flex";
  const err = document.getElementById("login-error");
  if (msg) { err.textContent = msg; err.classList.add("show"); }
  else { err.classList.remove("show"); }
  const btn = document.getElementById("login-btn");
  btn.disabled = false; btn.textContent = "Sign in";
}

async function doLogin() {
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const err = document.getElementById("login-error");
  const btn = document.getElementById("login-btn");
  err.classList.remove("show");

  if (!email || !password) {
    err.textContent = "Enter your email and password."; err.classList.add("show"); return;
  }

  btn.disabled = true; btn.textContent = "Signing in...";
  try {
    freshLogin = true;
    await signInWithEmailAndPassword(auth, email, password);
    // onAuthStateChanged takes it from here
  } catch (e) {
    const code = e.code || "";
    err.textContent =
      /wrong-password|user-not-found|invalid-credential|invalid-email/.test(code)
        ? "Incorrect email or password."
        : "Couldn't sign in (" + (code || e.message) + ").";
    err.classList.add("show");
    btn.disabled = false; btn.textContent = "Sign in";
  }
}

document.getElementById("login-btn").addEventListener("click", doLogin);
// Enter works from either field — half of sign-ins stop at the email box.
document.getElementById("login-email").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
document.getElementById("login-password").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });

// ---------- Forgotten password ----------
// Firebase sends the reset email and hosts the page the link opens, so this
// works on the free plan with no server. The one deliberate subtlety: whether
// or not the address has an account, the same message is shown — anything else
// would let a stranger test which emails are registered.
async function doForgotPassword() {
  const email = document.getElementById("login-email").value.trim();
  const err = document.getElementById("login-error");
  const note = document.getElementById("login-note");
  const link = document.getElementById("login-forgot");
  err.classList.remove("show");
  note.classList.remove("show");

  if (!email) {
    err.textContent = "Type your email in the box above first, then press \u201CForgot your password?\u201D again.";
    err.classList.add("show");
    return;
  }

  link.disabled = true;
  const label = link.textContent;
  link.textContent = "Sending...";
  try {
    await sendPasswordResetEmail(auth, email);
  } catch (e) {
    const code = e.code || "";
    if (/invalid-email/.test(code)) {
      err.textContent = "That doesn't look like an email address — check it and try again.";
      err.classList.add("show");
      link.disabled = false; link.textContent = label;
      return;
    }
    if (/network|unavailable|timeout/i.test(code + e.message)) {
      err.textContent = "Couldn't reach the server. Check the connection and try again.";
      err.classList.add("show");
      link.disabled = false; link.textContent = label;
      return;
    }
    // user-not-found and anything else fall through to the same neutral
    // message below, on purpose.
  }
  note.textContent =
    `If an account exists for ${email}, a reset link is on its way. ` +
    `It can take a few minutes and may land in spam — the sender ends in firebaseapp.com. ` +
    `Open the link, choose a new password, then sign in here with it.`;
  note.classList.add("show");
  link.disabled = false; link.textContent = label;
}
document.getElementById("login-forgot").addEventListener("click", doForgotPassword);

// ---------- App start ----------
function startApp() {
  document.getElementById("login").style.display = "none";
  document.getElementById("app").style.display = "block";
  document.getElementById("company-label").textContent = state.ctx.companyName;
  applyRoleNav();
  { const allowed = ROLE_TABS[state.ctx?.role] ?? null;
    if (allowed && !allowed.includes(currentViewFromHash())) showView(allowed[0]); }

  if (!wired) {
    wired = true;
    document.getElementById("logout-btn").addEventListener("click", async () => {
      // The sign-out is recorded while the person is still signed in (the
      // rules would refuse it a moment later). Capped at 1.5 s so a device
      // with no connection is never held on the screen it is trying to leave.
      try {
        await Promise.race([logEvent("sign-out"), new Promise(r => setTimeout(r, 1500))]);
      } catch {}
      stopListeners();
      await signOut(auth);
      // The on-device copy of the company's data (customers' phone numbers
      // and emails included) is deleted at sign-out, so a shared or lost
      // phone holds nothing once the person has signed out. terminate() is
      // the SDK's required step before the cache can be cleared, and the
      // reload below starts a clean Firestore instance — the same sequence
      // the recovery path above already uses. The in-memory resets that
      // follow still run first, so the sign-in screen never shows the
      // previous company's pixels even for the instant before the reload.
      const wipeLocalCopy = async () => {
        try { await terminate(db); await clearIndexedDbPersistence(db); } catch (e) {
          console.warn("Local data clear at sign-out failed:", e);
        }
        location.replace(location.pathname);
      };
      setTimeout(wipeLocalCopy, 0);
      // Everything, settings included: leaving the settings behind meant the
      // next person to sign in on this device briefly saw the previous
      // company's currency, logo and name until their own snapshot arrived.
      state.ctx = null; state.cars = []; state.bookings = []; state.customers = []; state.tasks = []; state.expenses = []; state.settings = {};
      // Repaint immediately: the views keep their drawn content otherwise, and
      // the next person to sign in would briefly see the previous company's
      // screen — not their data (the rules forbid that), but their pixels,
      // which looks identical to a breach and must never happen.
      notifyDataChange();
      state.settings = {};
      loadedCollections = new Set();
      // The theme belongs to the company that just left, exactly like its
      // pixels: the sign-in screen and the next person start on the factory
      // cream, not the previous company's colours.
      applyTheme(null);
      document.title = "VeFlow";
      const logo = document.getElementById("company-logo");
      if (logo) { logo.innerHTML = ""; logo.style.display = "none"; }
    });

    // The booking form is shared, so it is mounted once for the whole app
    mountBookingForm();
    // Saving from any planner should refresh whatever view is on screen
    onBookingChange(() => notifyDataChange());

    // Mount every view once. They stay in the DOM; navigation just shows/hides.
    for (const [name, v] of Object.entries(VIEWS)) {
      v.root = document.getElementById("view-" + name);
      v.mod.mount(v.root);
    }

    guardNumberFields();
    injectModalCloseButtons();
    // The deployment question, answered by looking: Settings shows the build,
    // the console logs it, the wordmark's tooltip carries it.
    {
      const v = document.getElementById("app-version");
      if (v) v.textContent = "VeFlow " + APP_VERSION;
      const h1 = document.querySelector("header h1");
      if (h1) h1.title = APP_VERSION;
      console.log("VeFlow", APP_VERSION);
    }
    wireBackupBanner();
    applyTabOrder();
    wireTabDragging();
    wireExport();
    wireNav();
  }

  // Runs on every sign-in, not just the first: if a second person signs in on
  // the same device without reloading, the screen has to be redrawn from their
  // company's data rather than left showing the previous person's.
  //
  // That includes any dialog left open at sign-out: a modal keeps its "open"
  // flag through the hidden login screen, and would otherwise reappear — with
  // the previous company's half-filled form in it — the moment the next person
  // signs in.
  document.querySelectorAll(".overlay.open").forEach(o => o.classList.remove("open"));
  showView(currentViewFromHash());

  startListeners();

  // After the listeners, so the check runs against data that has actually loaded.
  backupWaitTries = 0;
  setTimeout(() => { checkBackupDue(); }, 2500);
}

// ---------- Live data ----------
function startListeners() {
  stopListeners();
  loadedCollections = new Set();   // fresh sign-in, nothing has arrived yet
  const cid = state.ctx.companyId;

  // Every listener reports "live" once its data has come back. Only the cars one
  // used to, so saving a booking, a customer, a task or the settings left the
  // header reading "Saving" indefinitely — the write had gone through, but
  // nothing was left to say so until somebody happened to edit a car.
  unsubs.push(onSnapshot(query(collection(db, "cars"), where("companyId", "==", cid)), snap => {
    state.cars = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    loadedCollections.add("cars");
    setSync("live");
    notifyDataChange();
  }, () => setSync("error")));

  unsubs.push(onSnapshot(query(collection(db, "bookings"), where("companyId", "==", cid)), snap => {
    state.bookings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    loadedCollections.add("bookings");
    setSync("live");
    notifyDataChange();
  }, () => setSync("error")));

  unsubs.push(onSnapshot(query(collection(db, "customers"), where("companyId", "==", cid)), snap => {
    state.customers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    loadedCollections.add("customers");
    setSync("live");
    notifyDataChange();
  }, () => setSync("error")));

  unsubs.push(onSnapshot(query(collection(db, "tasks"), where("companyId", "==", cid)), snap => {
    state.tasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    loadedCollections.add("tasks");
    setSync("live");
    notifyDataChange();
  }, () => setSync("error")));

  unsubs.push(onSnapshot(query(collection(db, "expenses"), where("companyId", "==", cid)), snap => {
    state.expenses = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    loadedCollections.add("expenses");
    setSync("live");
    notifyDataChange();
  }, () => setSync("error")));

  // One settings document per company, so this watches a single known id rather
  // than running a query. Everything money-shaped reads the currency from here,
  // so a change shows up across the app immediately.
  unsubs.push(onSnapshot(doc(db, "settings", cid), snap => {
    state.settings = snap.exists() ? snap.data() : {};
    loadedCollections.add("settings");
    applyCompanyIdentity();
    setSync("live");
    notifyDataChange();
  }, () => setSync("error")));
}

// The header carries whatever the company set on the Settings page, falling back
// to the name on the user record until that page has been filled in.
function applyCompanyIdentity() {
  const s = state.settings || {};
  applyTheme(s);
  const label = document.getElementById("company-label");
  if (label) label.textContent = s.companyName || state.ctx.companyName;

  const slot = document.getElementById("company-logo");
  if (slot) {
    slot.innerHTML = s.logo ? `<img src="${esc(s.logo)}" alt="">` : "";
    slot.style.display = s.logo ? "block" : "none";
  }
  if (s.companyName) document.title = `${s.companyName} — VeFlow`;
}

function stopListeners() {
  unsubs.forEach(u => { try { u(); } catch {} });
  unsubs = [];
}

// ---------- Navigation ----------
function currentViewFromHash() {
  // The dashboard is the natural landing screen; the tabs can be dragged into
  // a different order if someone prefers to start somewhere else.
  const name = (location.hash || "#dashboard").replace("#", "");
  return VIEWS[name] ? name : "dashboard";
}

function wireNav() {
  document.getElementById("main-nav").addEventListener("click", (e) => {
    const link = e.target.closest("a[data-view]");
    if (!link) return;
    e.preventDefault();
    const name = link.dataset.view;
    location.hash = "#" + name;   // keeps the back button working
    showView(name);
  });

  window.addEventListener("hashchange", () => showView(currentViewFromHash()));
}

// Which tabs each access level sees. Interface-level in this version — it
// hides screens and blocks navigation; data rules underneath come as stage
// two. Admin is the default so existing logins change nothing.
const ROLE_TABS = {
  staff: ["tasks"],
  manager: ["dashboard", "bookings", "tasks", "expenses", "fleet", "customers", "billing", "reports", "maintenance"],
  admin: null   // everything
};
function allowedTabs() {
  return ROLE_TABS[state.ctx?.role] ?? null;
}
export function applyRoleNav() {
  const allowed = allowedTabs();
  document.querySelectorAll("#main-nav a").forEach(a => {
    a.style.display = (!allowed || allowed.includes(a.dataset.view)) ? "" : "none";
  });
}

function showView(name) {
  const allowed = allowedTabs();
  if (allowed && !allowed.includes(name)) name = allowed[0];
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.getElementById("view-" + name).classList.add("active");

  document.querySelectorAll("#main-nav a").forEach(a => {
    a.classList.toggle("active", a.dataset.view === name);
  });

  // Views render from data already in memory — nothing is refetched.
  VIEWS[name].mod.render();
  window.scrollTo(0, 0);
  showActiveTab(name);
}

// Once the strip scrolls, the tab you just landed on can sit off one edge —
// after following a link from the dashboard, for instance. This nudges the strip
// itself, never the page, and only when the tab is actually out of sight.
// Measured with rectangles rather than offsetLeft, which would be relative to
// whichever ancestor happens to be positioned.
function showActiveTab(name) {
  const nav = document.getElementById("main-nav");
  const link = nav.querySelector(`a[data-view="${name}"]`);
  if (!link) return;
  const strip = nav.getBoundingClientRect();
  const tab = link.getBoundingClientRect();
  const pad = 12;
  if (tab.left < strip.left + pad) {
    nav.scrollLeft -= (strip.left + pad) - tab.left;
  } else if (tab.right > strip.right - pad) {
    nav.scrollLeft += tab.right - (strip.right - pad);
  }
}


// ---------- Backup reminder ----------
// A browser cannot run anything while the app is closed, so there is no true
// schedule. What it can do is notice on opening that a backup is overdue, and —
// if the user has granted a folder — quietly write one. Otherwise it says so and
// offers a button, which is the honest version of "automatic".

function wireBackupBanner() {
  document.getElementById("backup-banner-go").addEventListener("click", () => {
    hideBackupBanner();
    location.hash = "#settings";
    showView("settings");
    settings.doBackup();
  });
  document.getElementById("backup-banner-hide").addEventListener("click", () => {
    // Dismissed for this session only. A backup that is still overdue tomorrow
    // should say so again rather than stay quiet for good.
    sessionStorage.setItem("backupBannerHidden", "1");
    hideBackupBanner();
  });
}

function hideBackupBanner() {
  const b = document.getElementById("backup-banner");
  if (b) b.style.display = "none";
}

let backupWaitTries = 0;
const BACKUP_WAIT_MAX = 25;      // × 2s = wait up to ~50s for a slow connection

async function checkBackupDue() {
  // A retry can arrive after a sign-out; there is nobody to back up for then.
  if (!state.ctx) return;
  if (!backupDue()) { hideBackupBanner(); return; }

  // If a folder is already set up and permitted, just do it — silently, without
  // prompting, because an unexpected permission dialog on load is alarming and
  // the browser would refuse it anyway outside a click.
  if (backupPrefs().auto) {
    // Never write a backup before the data has actually arrived. On a fresh
    // device or a slow connection the listeners can still be empty at this
    // point, and a backup taken then would be an empty file that also pushes
    // the next real backup a whole interval into the future. Wait and retry;
    // if the data still has not come, fall through to the visible banner
    // instead of writing anything.
    if (!allDataLoaded()) {
      if (backupWaitTries++ < BACKUP_WAIT_MAX) {
        setTimeout(checkBackupDue, 2000);
        return;
      }
    } else {
      try {
        const r = await runBackup({ mayPrompt: false });
        if (r.ok && /saved to/.test(r.where)) { hideBackupBanner(); return; }
      } catch { /* fall through to the banner */ }
    }
  }

  if (sessionStorage.getItem("backupBannerHidden")) return;

  const since = daysSinceBackup();
  document.getElementById("backup-banner-text").textContent =
    since === null
      ? "Your data has never been backed up. A copy on your own computer takes one click."
      : `Last backup was ${since} day${since === 1 ? "" : "s"} ago.`;
  document.getElementById("backup-banner").style.display = "flex";
}

// ---------- Export / backup ----------
// Everything is built in the browser from data already loaded, so exporting
// costs no extra database reads.

// ---------- Number fields never step ----------
// A focused <input type="number"> answers the mouse wheel and the up/down
// arrow keys as well as its own steppers, so a total could be changed without
// anyone meaning to touch it: the pilot scrolled a booking form with the
// pointer still resting in the total and sent the client a confirmation
// reading Rs 14,498 instead of Rs 14,500. Money is not a value you nudge.
//
// One listener on the document in the capture phase, so it covers every number
// field in the app — including the exchange-rate rows the Settings page builds
// after this runs — and cannot be bypassed by a handler on the field itself.
//
// Wheel: blur rather than preventDefault. The field stops stepping because it
// is no longer focused, and the page keeps scrolling normally, which is what
// the person was trying to do. Killing the scroll instead would trade a
// Every popup gets a close button pinned in its top-right corner, so leaving
// never means scrolling to the bottom for Cancel. Injected once here rather
// than written twenty times in the HTML — a popup added later gets its ×
// automatically, and one that already grew its own is left alone. Closing a
// popup is only ever removing its "open" class (that is all closeModal and
// the click-outside handlers do), so the × needs no per-view wiring.
function injectModalCloseButtons() {
  document.querySelectorAll(".overlay").forEach(o => {
    const m = o.querySelector(".modal");
    if (!m) return;
    // Every popup becomes two parts: a body that scrolls, and the action bar
    // as the popup's true bottom edge. Nothing can ever render below the bar
    // again, on any browser — the previous sticky bar pinned itself to
    // whichever container happened to be scrolling, and on some platforms
    // that was the page, leaving the form visible underneath (pilot,
    // repeatedly, Aug 2026).
    if (!m.querySelector(".modal-body")) {
      const body = document.createElement("div");
      body.className = "modal-body";
      const keep = [...m.childNodes].filter(n =>
        !(n.nodeType === 1 && n.classList.contains("modal-actions")));
      keep.forEach(n => body.appendChild(n));
      m.insertBefore(body, m.firstChild);
    }
    const bodyEl = m.querySelector(".modal-body");
    // The pins row lives in the FRAME, beside the scrolling body, so nothing
    // that scrolls can carry it: sticky-with-negative-margins inside the
    // scroller drifted on iOS (pilot's screenshots, 25 Aug). Any quick-action
    // pill a modal declares (the booking form's \u2713 Paid) is lifted out of
    // the body into the same row, so the pair sit together top-right, frozen.
    let pins = m.querySelector(".modal-pins");
    if (!pins) {
      pins = document.createElement("div");
      pins.className = "modal-pins";
      m.insertBefore(pins, bodyEl);
    }
    const pill = bodyEl.querySelector(".paid-quick");
    if (pill) pins.appendChild(pill);
    if (!m.querySelector(".modal-x")) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "modal-x";
      b.setAttribute("aria-label", "Close");
      b.innerHTML = "&times;";
      b.addEventListener("click", () => o.classList.remove("open"));
      pins.appendChild(b);
    }
  });
}

// dangerous bug for an infuriating one.
function guardNumberFields() {
  document.addEventListener("wheel", e => {
    const t = e.target;
    if (t instanceof HTMLInputElement && t.type === "number" && t === document.activeElement) {
      t.blur();
    }
  }, { capture: true, passive: true });

  document.addEventListener("keydown", e => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    const t = e.target;
    if (t instanceof HTMLInputElement && t.type === "number") e.preventDefault();
  }, true);
}

function wireExport() {
  const modal = document.getElementById("export-modal");
  document.getElementById("export-btn").addEventListener("click", () => modal.classList.add("open"));
  document.getElementById("export-close").addEventListener("click", () => modal.classList.remove("open"));
  modal.addEventListener("click", e => { if (e.target === modal) modal.classList.remove("open"); });

  document.getElementById("export-json").addEventListener("click", exportJson);
  document.getElementById("export-bookings-csv").addEventListener("click", exportBookingsCsv);
  document.getElementById("export-customers-csv").addEventListener("click", exportCustomersCsv);
  document.getElementById("export-cars-csv").addEventListener("click", exportCarsCsv);
}

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime + ";charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeName() {
  return (state.ctx.companyName || "company").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

function exportJson() {
  // Everything, not just the big three. This file is named "fleet-backup" and
  // someone will keep it believing it is one — a backup missing the tasks,
  // the expense ledger and the company settings would betray that belief the
  // day it was needed. (Service history rides along inside each car.)
  const data = {
    exportedAt: new Date().toISOString(),
    company: { id: state.ctx.companyId, name: state.ctx.companyName },
    settings: state.settings,
    cars: state.cars,
    bookings: state.bookings,
    customers: state.customers,
    tasks: state.tasks,
    expenses: state.expenses
  };
  download(`fleet-backup-${safeName()}-${stamp()}.json`, JSON.stringify(data, null, 2), "application/json");
}

// Wraps a value so commas, quotes and line breaks survive in a spreadsheet
function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(headers, rows) {
  return [headers.join(","), ...rows.map(r => r.map(csvCell).join(","))].join("\n");
}

function exportBookingsCsv() {
  const headers = ["Reference","Customer","Phone","Car","Pick-up","Return","Days","Daily rate","Rental total","Bank charge %","Bank charge","Total due","Advance paid","Balance","Security deposit","Deposit status","Paid","Paid on","Status","Broker","Currency","Total (foreign)","Advance (foreign)","Security (foreign)","Delivery (foreign)","Insurance (foreign)","Other (foreign)"];
  const rows = state.bookings
    .slice()
    // Guarded like the same sort in backup.js: one corrupt booking without a
    // start date must not crash the whole export.
    .sort((a,b) => (b.startDate || "").localeCompare(a.startDate || ""))
    .map(b => [
      bookingRef(b), b.renter || "", b.phone || "", bookingCarLabel(b),
      b.startDate || "", b.endDate || "",
      rentalDays(b), rateFor(b), rentalTotal(b),
      bankChargePct(b), bankCharge(b), amountDue(b),
      advancePaid(b), balanceFor(b),
      b.securityDeposit || 0, b.securityStatus || "",
      b.paid ? "Yes" : "No", b.paidAt ? b.paidAt.slice(0,10) : "",
      b.status === "completed" ? "Completed" : "Open",
      b.broker || "",
      b.fxCurrency || "", b.fxTotal || "", b.fxAdvance || "", b.fxSecurity || "",
      b.fxDelivery || "", b.fxInsurance || "", b.fxOther || ""
    ]);
  download(`bookings-${safeName()}-${stamp()}.csv`, toCsv(headers, rows), "text/csv");
}

function exportCustomersCsv() {
  const headers = ["Name","Phone","Email","License","Notes","Rentals"];
  const rows = state.customers
    .slice()
    .sort((a,b) => (a.name || "").localeCompare(b.name || ""))
    .map(c => [
      c.name || "", c.phone || "", c.email || "", c.license || "", c.notes || "",
      state.bookings.filter(b => b.customerId === c.id).length
    ]);
  download(`customers-${safeName()}-${stamp()}.csv`, toCsv(headers, rows), "text/csv");
}

function exportCarsCsv() {
  const headers = ["Year","Make","Model","Plate","Daily rate","Weekly rate","Monthly rate","Mileage","Next service","Service at (km)","Out of service","Maintenance notes"];
  const rows = state.cars
    .slice()
    .sort((a,b) => (a.make + a.model).localeCompare(b.make + b.model))
    .map(c => [
      c.year || "", c.make || "", c.model || "", c.plate || "",
      c.dailyRate || 0, c.weeklyRate || 0, c.monthlyRate || 0,
      c.mileage || "", c.nextServiceDate || "", c.serviceMileage || "",
      c.outOfService ? "Yes" : "No", c.notes_maint || ""
    ]);
  download(`cars-${safeName()}-${stamp()}.csv`, toCsv(headers, rows), "text/csv");
}

// ---------- Tab order ----------
// Which order the tabs appear in is a personal working preference, so it is
// stored on the device rather than shared with the whole company.

function applyTabOrder() {
  const nav = document.getElementById("main-nav");
  const saved = loadPref("tabOrder", null);
  if (!Array.isArray(saved)) return;

  const all = Array.from(nav.querySelectorAll("a[data-view]"));
  const known = new Set(saved);

  // A tab added to the app after someone last dragged their tabs is not in
  // their saved order, and has to be placed somewhere. It used to go on the
  // end. That is not where a new tab belongs: Expenses ships next to Tasks
  // because the two are used together, and on the pilot's phone — which had a
  // saved order from before Expenses existed — it sat past Maintenance,
  // eight tabs from the one it belongs beside. Reordering is mouse-only (a tap
  // slides more than the drag threshold, so touch was excluded), which left him
  // no way to move it there himself.
  //
  // Each unknown tab now lands where the markup puts it: directly after
  // whichever of its markup predecessors is nearest in the saved order. A
  // device whose saved order already knows every tab is untouched.
  const ordered = saved.map(name => all.find(a => a.dataset.view === name)).filter(Boolean);

  all.forEach((link, i) => {
    if (known.has(link.dataset.view)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const seen = ordered.indexOf(all[j]);
      if (seen !== -1) { at = seen + 1; break; }
    }
    ordered.splice(at, 0, link);
  });

  ordered.forEach(link => nav.appendChild(link));
}

function currentTabOrder() {
  return Array.from(document.querySelectorAll("#main-nav a[data-view]"))
    .map(a => a.dataset.view);
}

function wireTabDragging() {
  const nav = document.getElementById("main-nav");
  let dragEl = null, startX = 0, moved = false;
  const THRESHOLD = 6;   // small movements are taps, not drags

  nav.addEventListener("pointerdown", (e) => {
    // On a touchscreen this whole feature does more harm than good. A tap almost
    // always slides more than the six pixels below, so tapping a tab was read as
    // a drag: it reordered the strip and swallowed the click, which is why tabs
    // stopped responding on a phone. Touch is for scrolling the strip and tapping
    // a tab; reordering stays available with a mouse or trackpad.
    if (e.pointerType === "touch") return;
    const link = e.target.closest("a[data-view]");
    if (!link) return;
    dragEl = link; startX = e.clientX; moved = false;
  });

  nav.addEventListener("pointermove", (e) => {
    if (!dragEl) return;
    if (!moved && Math.abs(e.clientX - startX) < THRESHOLD) return;

    if (!moved) {
      moved = true;
      dragEl.classList.add("tab-dragging");
      nav.setPointerCapture(e.pointerId);
    }
    e.preventDefault();

    const over = document.elementFromPoint(e.clientX, e.clientY);
    const target = over && over.closest("#main-nav a[data-view]");
    if (target && target !== dragEl) {
      // Insert before or after depending on which way we are moving
      const rect = target.getBoundingClientRect();
      const after = e.clientX > rect.left + rect.width / 2;
      target.parentNode.insertBefore(dragEl, after ? target.nextSibling : target);
    }
  });

  const end = (e) => {
    if (!dragEl) return;
    const wasDragging = moved;
    dragEl.classList.remove("tab-dragging");
    try { nav.releasePointerCapture(e.pointerId); } catch {}
    dragEl = null; moved = false;
    if (wasDragging) {
      savePref("tabOrder", currentTabOrder());
      // Swallow the click that follows the drag, so the tab does not also switch
      const swallow = ev => { ev.preventDefault(); ev.stopPropagation(); };
      nav.addEventListener("click", swallow, { capture: true, once: true });
    }
  };

  nav.addEventListener("pointerup", end);
  nav.addEventListener("pointercancel", end);
}
