// VeFlow — activity log (audit trail).
//
// Every view imports its Firestore write functions from here instead of from
// the Firebase CDN. The names and signatures are identical, so the views did
// not change; the difference is that each write is followed by one small
// record in audit/{companyId}/entries saying who did what, to which document,
// and which fields moved. Sign-ins, printed documents, messages and backups
// are recorded through logEvent() by the modules that perform them.
//
// Design rules (OWASP A09, Logging Cheat Sheet):
//   * The log never blocks the user. A save is awaited as before; the log
//     entry is written afterwards and a failure to log is reported to the
//     console, never to the person saving. Offline, the entry queues with
//     the write it describes and lands when the connection returns.
//   * Personal data is not copied into the log. Field NAMES are recorded for
//     every change; old and new VALUES only for numbers, booleans and
//     YYYY-MM-DD dates (money, dates, flags). Free text — names, phones,
//     emails, passport numbers, notes, signatures — is never written here.
//   * Entries are append-only. The Firestore rules refuse update and delete
//     on this collection, so nobody signed in to the app can edit history.
//   * Failures are logged too: a write the server refused is a record worth
//     keeping (a permission-denied on a legitimate action is exactly the
//     event an administrator wants to see).
//
// What the log cannot do on the free plan: a person who bypasses the app and
// writes to the database directly with their own credentials could skip the
// log entry. The server-side layer that closes that gap is Google's own
// Firestore audit logging (console, no code) — see the security notes.

import * as fs from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { db, auth } from "./firebase-init.js";
import { state, bookingRef, APP_VERSION } from "./store.js";

// Everything the views import that is not a write passes straight through:
// doc, collection, arrayUnion, deleteField, query, where, and the rest.
export * from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// How long an entry is kept. Written on the entry so a Firestore
// time-to-live policy on `expireAt` can delete it automatically later.
const RETENTION_MONTHS = 24;

// Firestore's own sentinels (arrayUnion, deleteField, serverTimestamp...) are
// objects, not values; they are recorded as the operation, never as data.
function sentinelName(v) {
  return v && typeof v === "object" && typeof v._methodName === "string" ? v._methodName : "";
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function loggableValue(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === "number" || typeof v === "boolean") return true;
  if (typeof v === "string") return DATE_RE.test(v);
  return false;
}
function same(a, b) {
  if (a === b) return true;
  if (a === undefined && b === null) return true;
  if (a === null && b === undefined) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

// ---------- Who and what ----------
function actor() {
  const u = state.ctx?.user || auth.currentUser;
  return { uid: u?.uid || "", email: u?.email || "" };
}
function listFor(col) {
  switch (col) {
    case "cars": return state.cars;
    case "bookings": return state.bookings;
    case "customers": return state.customers;
    case "tasks": return state.tasks;
    case "expenses": return state.expenses;
    default: return null;
  }
}
function existing(col, id) {
  if (col === "settings") return state.settings || null;
  const list = listFor(col);
  return list ? list.find(x => x.id === id) || null : null;
}
function trunc(s, n) {
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
}
// A short human label for the document, built from the record itself
// (before the change) or, for a brand-new one, from what is being written.
function labelFor(col, id, data) {
  const d = Object.assign({}, existing(col, id) || {}, data || {});
  switch (col) {
    case "cars":
      return trunc(`${d.year || ""} ${d.make || ""} ${d.model || ""} (${d.plate || "no plate"})`, 60);
    case "bookings": {
      const ref = (() => { try { return bookingRef(Object.assign({ id }, d)); } catch { return ""; } })();
      return trunc(`Booking ${ref || id} \u2014 ${d.renter || ""}`, 70);
    }
    case "customers":
      return trunc(`Customer ${d.name || id}`, 60);
    case "tasks":
      return trunc(`Task: ${d.text || id}`, 60);
    case "expenses":
      return trunc(`Expense ${d.category || ""} ${d.amount ?? ""} on ${d.date || ""}`, 60);
    case "settings":
      return "Company settings";
    default:
      return trunc(`${col}/${id}`, 60);
  }
}
// Field names that changed, and old→new only where the value is safe to keep.
function diffFor(col, id, data) {
  const prev = existing(col, id);
  const fields = [];
  const changes = {};
  for (const [k, v] of Object.entries(data || {})) {
    const op = sentinelName(v);
    if (op) { fields.push(k); changes[k] = { op }; continue; }
    const before = prev ? prev[k] : undefined;
    if (prev && same(before, v)) continue;
    fields.push(k);
    if (loggableValue(before) && loggableValue(v)) {
      changes[k] = { from: before === undefined ? null : before, to: v === undefined ? null : v };
    }
  }
  return { fields, changes };
}
function pathOf(ref) {
  // DocumentReference or CollectionReference from the Firestore SDK
  const path = String(ref?.path || "");
  const parts = path.split("/");
  if (parts.length >= 2) return { col: parts[parts.length - 2], docId: parts[parts.length - 1] };
  return { col: parts[0] || "", docId: "" };
}

// ---------- Writing the entry ----------
export function logEvent(action, info = {}) {
  const cid = state.ctx?.companyId;
  const { uid, email } = actor();
  if (!cid || !uid) return Promise.resolve();
  const expire = new Date();
  expire.setMonth(expire.getMonth() + RETENTION_MONTHS);
  const entry = {
    companyId: cid,
    uid,
    email,
    action: String(action || ""),
    col: String(info.col || ""),
    docId: String(info.docId || ""),
    label: String(info.label || ""),
    fields: Array.isArray(info.fields) ? info.fields.slice(0, 60) : [],
    changes: info.changes && typeof info.changes === "object" ? info.changes : {},
    error: info.error ? String(info.error).slice(0, 120) : "",
    at: fs.serverTimestamp(),
    ts: new Date().toISOString(),
    app: APP_VERSION,
    expireAt: fs.Timestamp.fromDate(expire)
  };
  return fs.addDoc(fs.collection(db, "audit", cid, "entries"), entry)
    .then(() => {}, e => { console.warn("Activity log entry not saved:", e?.code || e); });
}

function record(action, ref, data, error) {
  const { col, docId } = pathOf(ref);
  const info = { col, docId, label: labelFor(col, docId, data) };
  if (action === "update") Object.assign(info, diffFor(col, docId, data));
  else if (action === "create" || action === "set") info.fields = Object.keys(data || {}).slice(0, 60);
  if (error) info.error = error;
  return info;
}
// Several entries from one batch or transaction, written after it commits.
// A large batch touching one collection (e.g. re-ordering every car) becomes
// a single summary entry rather than one per document.
function flush(pending) {
  if (!pending.length) return;
  if (pending.length > 5) {
    const byCol = {};
    pending.forEach(p => { (byCol[p.col] = byCol[p.col] || []).push(p); });
    for (const [col, items] of Object.entries(byCol)) {
      if (items.length > 5) {
        const fields = [...new Set(items.flatMap(i => i.fields || []))];
        logEvent(items[0].action, { col, docId: "", label: `${items.length} ${col} in one batch`, fields });
      } else {
        items.forEach(i => logEvent(i.action, i));
      }
    }
    return;
  }
  pending.forEach(i => logEvent(i.action, i));
}

// ---------- Wrapped writes — same names and signatures as the SDK ----------
export async function addDoc(colRef, data) {
  try {
    const ref = await fs.addDoc(colRef, data);
    logEvent("create", record("create", ref, data));
    return ref;
  } catch (e) {
    logEvent("failed", Object.assign(record("create", colRef, data), { error: "create: " + (e?.code || e?.message || e) }));
    throw e;
  }
}
export async function setDoc(ref, data, options) {
  const action = existing(pathOf(ref).col, pathOf(ref).docId) ? "update" : "set";
  try {
    const r = await fs.setDoc(ref, data, options);
    logEvent(action, record(action, ref, data));
    return r;
  } catch (e) {
    logEvent("failed", Object.assign(record(action, ref, data), { error: "set: " + (e?.code || e?.message || e) }));
    throw e;
  }
}
export async function updateDoc(ref, data) {
  const info = record("update", ref, data);   // diff against the pre-change record
  try {
    const r = await fs.updateDoc(ref, data);
    logEvent("update", info);
    return r;
  } catch (e) {
    logEvent("failed", Object.assign(info, { error: "update: " + (e?.code || e?.message || e) }));
    throw e;
  }
}
export async function deleteDoc(ref) {
  const info = record("delete", ref, null);
  try {
    const r = await fs.deleteDoc(ref);
    logEvent("delete", info);
    return r;
  } catch (e) {
    logEvent("failed", Object.assign(info, { error: "delete: " + (e?.code || e?.message || e) }));
    throw e;
  }
}
export function writeBatch(dbArg) {
  const real = fs.writeBatch(dbArg);
  const pending = [];
  const w = {
    set(ref, data, options) {
      const action = existing(pathOf(ref).col, pathOf(ref).docId) ? "update" : "create";
      pending.push(Object.assign({ action }, record(action, ref, data)));
      real.set(ref, data, options); return w;
    },
    update(ref, data) {
      pending.push(Object.assign({ action: "update" }, record("update", ref, data)));
      real.update(ref, data); return w;
    },
    delete(ref) {
      pending.push(Object.assign({ action: "delete" }, record("delete", ref, null)));
      real.delete(ref); return w;
    },
    async commit() {
      try { await real.commit(); }
      catch (e) {
        logEvent("failed", { col: pending[0]?.col || "", label: `batch of ${pending.length}`, error: "batch: " + (e?.code || e?.message || e) });
        throw e;
      }
      flush(pending);
    }
  };
  return w;
}
export function runTransaction(dbArg, fn, options) {
  let pending = [];
  return fs.runTransaction(dbArg, (tx) => {
    pending = [];   // the SDK may retry; only the attempt that commits counts
    const w = {
      get: (...a) => tx.get(...a),
      set(ref, data, o) {
        const action = existing(pathOf(ref).col, pathOf(ref).docId) ? "update" : "create";
        pending.push(Object.assign({ action }, record(action, ref, data)));
        tx.set(ref, data, o); return w;
      },
      update(ref, data) {
        pending.push(Object.assign({ action: "update" }, record("update", ref, data)));
        tx.update(ref, data); return w;
      },
      delete(ref) {
        pending.push(Object.assign({ action: "delete" }, record("delete", ref, null)));
        tx.delete(ref); return w;
      }
    };
    return fn(w);
  }, options).then(
    result => { flush(pending); return result; },
    e => {
      logEvent("failed", { col: pending[0]?.col || "", label: pending[0]?.label || "transaction", error: "transaction: " + (e?.code || e?.message || e) });
      throw e;
    }
  );
}

// ---------- The daily check (Dashboard) ----------
// Reads everything recorded since the given moment and pulls out the entries
// an administrator should glance at. Rules, not judgement: deletions, writes
// the server refused, sign-ins outside working hours, data leaving the
// system, and money or dates changed on a booking after its receipt or
// invoice was issued. Everything else stays quiet.
const REVIEW_HOURS = { from: 6, to: 22 };   // sign-ins outside these hours are flagged
const MONEY_DATE_FIELDS = ["dailyRate", "startDate", "endDate", "advancePaid", "securityDeposit", "total", "bankChargePct"];

function hasIssuedDoc(b) { return !!(b && (b.receiptNo || b.invoiceNo)); }

// The watch list itself, as a pure function so the operator review page can
// run the same rules across companies. `issuedDoc(docId)` answers whether a
// booking has a receipt or invoice; pass null when that cannot be known (the
// operator page has no read access to bookings, by design) and the rule is
// skipped rather than guessed.
export function classifyEntries(entries, issuedDoc) {
  const findings = [];
  const flag = (e, why, level) => findings.push({
    at: e.atDate, level, why,
    text: describeEntry({ ...e, at: e.atDate.toISOString() })
  });
  for (const e of entries) {
    if (e.action === "delete") { flag(e, "deleted", "warn"); continue; }
    if (e.action === "failed") { flag(e, "refused by the server", "warn"); continue; }
    if (e.action === "sign-in" || e.action === "session") {
      const h = e.atDate.getHours();
      if (h < REVIEW_HOURS.from || h >= REVIEW_HOURS.to) flag(e, "outside working hours", "warn");
      continue;
    }
    if (e.action === "export") { flag(e, "data left the system", "info"); continue; }
    if (issuedDoc && e.action === "update" && e.col === "bookings" && issuedDoc(e.docId)) {
      const touched = (e.fields || []).filter(f => MONEY_DATE_FIELDS.includes(f));
      if (touched.length) flag(e, "money or dates changed after a receipt or invoice was issued", "warn");
      continue;
    }
  }
  findings.sort((a, b) => (a.level === b.level ? b.at - a.at : a.level === "warn" ? -1 : 1));
  return findings;
}

// Fetches a company's entries newer than `sinceIso`. Exported for the
// operator review page; the app's own Daily check wraps it below.
export async function fetchEntriesSince(companyId, sinceIso, limitN = 500) {
  const since = new Date(sinceIso);
  const q = fs.query(
    fs.collection(db, "audit", companyId, "entries"),
    fs.where("at", ">", fs.Timestamp.fromDate(isNaN(since) ? new Date(Date.now() - 86400000) : since)),
    fs.orderBy("at", "desc"),
    fs.limit(limitN)
  );
  const snap = await fs.getDocs(q);
  return snap.docs.map(d => {
    const x = d.data();
    const at = x.at && typeof x.at.toDate === "function" ? x.at.toDate() : new Date(x.ts || 0);
    return { id: d.id, ...x, atDate: at };
  });
}

export async function reviewActivity(sinceIso) {
  const cid = state.ctx?.companyId;
  if (!cid) return { checked: 0, findings: [] };
  const entries = await fetchEntriesSince(cid, sinceIso);
  const findings = classifyEntries(entries, (docId) => hasIssuedDoc(state.bookings.find(b => b.id === docId)));
  return { checked: entries.length, findings };
}

// ---------- Reading the log (Settings → Activity) ----------
export async function recentActivity(limitN = 200) {
  const cid = state.ctx?.companyId;
  if (!cid) return [];
  const q = fs.query(
    fs.collection(db, "audit", cid, "entries"),
    fs.orderBy("at", "desc"),
    fs.limit(Math.max(1, Math.min(500, limitN)))
  );
  const snap = await fs.getDocs(q);
  return snap.docs.map(d => {
    const x = d.data();
    const at = x.at && typeof x.at.toDate === "function" ? x.at.toDate().toISOString() : (x.ts || "");
    return { id: d.id, ...x, at };
  });
}

// One line of plain text per entry, shared by the screen and the CSV.
export function describeEntry(e) {
  const who = e.email || e.uid || "someone";
  const what = e.label || (e.col ? `${e.col}/${e.docId}` : "");
  const fields = (e.fields || []).length ? ` \u2014 ${e.fields.join(", ")}` : "";
  const changes = Object.entries(e.changes || {})
    .filter(([, c]) => c && ("from" in c || "to" in c))
    .map(([k, c]) => `${k}: ${c.from ?? "\u2014"} \u2192 ${c.to ?? "\u2014"}`)
    .join("; ");
  switch (e.action) {
    case "sign-in": return `${who} signed in`;
    case "session": return `${who} opened the app`;
    case "sign-out": return `${who} signed out`;
    case "create": return `${who} added ${what}`;
    case "set": return `${who} saved ${what}`;
    case "update": return `${who} changed ${what}${fields}${changes ? ` (${changes})` : ""}`;
    case "delete": return `${who} deleted ${what}`;
    case "print": return `${who} opened ${what} for printing`;
    case "share": return `${who} sent ${what}`;
    case "export": return `${who} exported ${what}`;
    case "failed": return `${who}: the server refused ${what}${e.error ? ` (${e.error})` : ""}`;
    default: return `${who}: ${e.action} ${what}${fields}`;
  }
}
