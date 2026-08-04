// Backup — turns the company's live data into spreadsheet files.
//
// A word on what a browser can and cannot do here, because it shapes all of it:
// nothing runs while the app is closed, so there is no such thing as a truly
// scheduled backup without a server. What is possible is
//
//   * a reminder, so a backup is never quietly forgotten, and
//   * on Chrome or Edge on a computer, writing straight into a folder the user
//     picked once, with no download prompt each time.
//
// On Safari and on phones the folder option does not exist, so those fall back
// to an ordinary download. The Settings page says plainly which mode applies, so
// nobody is left believing they are protected when they are not.

import { state, bookingCarLabel, rentalDays, rateFor, rentalTotal,
         advancePaid, balanceFor, settledOn, bookingRef,
         deliveryCost, insuranceCost, otherCost, invoiceTotal,
         loadPref, savePref } from "./store.js";

export const CATEGORIES = [
  { key: "bookings",  label: "Bookings & invoices" },
  { key: "customers", label: "Customers" },
  { key: "cars",      label: "Cars & rates" },
  { key: "tasks",     label: "Tasks" },
  { key: "service",   label: "Service history" },
  { key: "expenses",  label: "Staff expenses" }
];

export const INTERVALS = [
  { key: "off",     label: "Don't remind me", days: 0 },
  { key: "weekly",  label: "Every week",      days: 7 },
  { key: "biweekly",label: "Every 2 weeks",   days: 14 },
  { key: "monthly", label: "Every month",     days: 30 }
];

// ---------- Preferences ----------
// Kept on the device rather than in the database, because the folder a backup
// writes to is a property of this computer and cannot be shared with anyone.
//
// Namespaced by company: two companies signing in on the same device must not
// share a backup clock — otherwise company B is told "backed up yesterday"
// because company A was, and with the folder shared, B's data would even be
// written into A's folder. Every key carries the company id.

function pkey(k) {
  return `backup:${state.ctx?.companyId || "none"}:${k}`;
}

export function backupPrefs() {
  return {
    categories: loadPref(pkey("categories"), CATEGORIES.map(c => c.key)),
    interval: loadPref(pkey("interval"), "weekly"),
    lastRun: loadPref(pkey("lastRun"), null),
    auto: loadPref(pkey("auto"), false)
  };
}

export function saveBackupPrefs(patch) {
  const p = { ...backupPrefs(), ...patch };
  savePref(pkey("categories"), p.categories);
  savePref(pkey("interval"), p.interval);
  savePref(pkey("lastRun"), p.lastRun);
  savePref(pkey("auto"), p.auto);
  return p;
}

export function daysSinceBackup() {
  const { lastRun } = backupPrefs();
  if (!lastRun) return null;                       // never backed up
  const then = new Date(lastRun);
  if (isNaN(then)) return null;
  return Math.floor((Date.now() - then.getTime()) / 86400000);
}

export function backupDue() {
  const { interval } = backupPrefs();
  const cfg = INTERVALS.find(i => i.key === interval);
  if (!cfg || cfg.days === 0) return false;
  const since = daysSinceBackup();
  return since === null || since >= cfg.days;
}

// ---------- Building the data ----------
// One table per category. Headers first so the file reads as a spreadsheet
// rather than a data dump.

function bookingRows() {
  return [
    ["Reference","Customer","Phone","Car","Pick-up","Pick-up time","Return","Return time",
     "Days","Daily rate","Rental total","Delivery","Insurance","Other","Invoice total",
     "Currency","Total (foreign)","Advance (foreign)","Security (foreign)",
     "Delivery (foreign)","Insurance (foreign)","Other (foreign)",
     "Advance paid","Balance",
     "Security deposit","Deposit status","Paid","Settled on","Status",
     "Pick-up place","Drop-off place","Broker","Managed by","Delivered by","Recovered by","Notes"],
    ...state.bookings.slice()
      .sort((a, b) => (b.startDate || "").localeCompare(a.startDate || ""))
      .map(b => [
        bookingRef(b), b.renter || "", b.phone || "", bookingCarLabel(b),
        b.startDate || "", b.startTime || "", b.endDate || "", b.endTime || "",
        rentalDays(b), rateFor(b), rentalTotal(b),
        deliveryCost(b), insuranceCost(b), otherCost(b), invoiceTotal(b),
        b.fxCurrency || "", b.fxTotal || "", b.fxAdvance || "", b.fxSecurity || "",
        b.fxDelivery || "", b.fxInsurance || "", b.fxOther || "",
        advancePaid(b), balanceFor(b),
        b.securityDeposit || 0, b.securityStatus || "",
        b.paid ? "Yes" : "No", b.paid ? settledOn(b) : "",
        b.status === "completed" ? "Completed" : "Open",
        b.pickupLocation || "", b.dropoffLocation || "",
        b.broker || "", b.managedBy || "", b.deliveredBy || "", b.recoveredBy || "", b.notes || ""
      ])
  ];
}

function customerRows() {
  return [
    ["Name","Phone","Email","License","Notes","Rentals","Added"],
    ...state.customers.slice()
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
      .map(c => [
        c.name || "", c.phone || "", c.email || "", c.license || "", c.notes || "",
        state.bookings.filter(b => b.customerId === c.id).length,
        (c.createdAt || "").slice(0, 10)
      ])
  ];
}

function carRows() {
  return [
    ["Year","Make","Model","Plate","Category","Daily rate","Weekly rate","Monthly rate",
     "Mileage","Next service","Service at (km)","Out of service","Maintenance notes",
     "Registration date","Licence expiry","Road tax expiry","Insurance expiry","Fitness expiry","Lease expiry"],
    ...state.cars.slice()
      .sort((a, b) => (a.make + a.model).localeCompare(b.make + b.model))
      .map(c => [
        c.year || "", c.make || "", c.model || "", c.plate || "", c.category || "",
        c.dailyRate || 0, c.weeklyRate || 0, c.monthlyRate || 0,
        c.mileage || "", c.nextServiceDate || "", c.serviceMileage || "",
        c.outOfService ? "Yes" : "No", c.notes_maint || "",
        c.regDate || "", c.licenceExpiry || "", c.roadTaxExpiry || "",
        c.insuranceExpiry || "", c.fitnessExpiry || "", c.leaseExpiry || ""
      ])
  ];
}

function taskRows() {
  return [
    ["Date","Time","Task","Assigned to","Done"],
    ...(state.tasks || []).slice()
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""))
      .map(t => [
        t.date || "", t.time || "", t.text || "", t.staff || "", t.done ? "Yes" : "No"
      ])
  ];
}

const BUILDERS = {
  bookings: { sheet: "Bookings", rows: bookingRows },
  customers:{ sheet: "Customers", rows: customerRows },
  cars:     { sheet: "Cars", rows: carRows },
  tasks:    { sheet: "Tasks", rows: taskRows },
  service:  { sheet: "Service history", rows: serviceRows },
  expenses: { sheet: "Staff expenses", rows: expenseRows }
};

function expenseRows() {
  const carName = id => {
    const c = state.cars.find(v => v.id === id);
    return c ? `${c.make} ${c.model} (${c.plate || ""})` : "";
  };
  return [
    ["Date", "Amount", "Category", "Spent by", "Car", "Note", "Refunded", "Recorded by"],
    ...state.expenses.slice()
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .map(x => [x.date || "", x.amount || 0, x.category || "", x.staff || "",
        carName(x.carId), x.note || "", x.done ? "Yes" : "", x.by || ""])
  ];
}

function serviceRows() {
  const rows = [["Car", "Plate", "Service date", "Mileage (km)", "Work done", "Next service set to", "Logged by"]];
  state.cars.slice()
    .sort((a, b) => (a.make + a.model).localeCompare(b.make + b.model))
    .forEach(c => {
      (Array.isArray(c.serviceHistory) ? c.serviceHistory : [])
        .slice().sort((a, b) => String(a.at).localeCompare(String(b.at)))
        .forEach(hh => rows.push([
          `${c.year || ""} ${c.make || ""} ${c.model || ""}`.trim(), c.plate || "",
          hh.at || "", hh.mileage || "", hh.notes || "", hh.nextDate || "", hh.by || ""
        ]));
    });
  return rows;
}

// ---------- File formats ----------

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(rows) {
  return rows.map(r => r.map(csvCell).join(",")).join("\n");
}

// SheetJS is fetched only when a backup actually runs, so it costs nothing on a
// normal visit. If it cannot be reached — offline, or a blocked CDN — the caller
// falls back to CSV rather than failing.
let xlsxLib = null;
export async function loadXlsx() {
  if (xlsxLib) return xlsxLib;
  xlsxLib = await import("https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs");
  return xlsxLib;
}

// One workbook, one tab per category — easier to keep and to hand to an
// accountant than a scatter of separate files.
async function buildXlsx(categories) {
  const XLSX = await loadXlsx();
  const wb = XLSX.utils.book_new();
  categories.forEach(key => {
    const b = BUILDERS[key];
    if (!b) return;
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(b.rows()), b.sheet);
  });
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return new Blob([out], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
}

function safeName() {
  const n = state.settings?.companyName || state.ctx?.companyName || "company";
  return n.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "");
}

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- The chosen folder (Chrome and Edge on a computer) ----------
// A folder handle survives a restart, but only if it is stored — and it cannot
// be put in localStorage, which holds text only. IndexedDB can hold the handle
// object itself, so this is a very small wrapper around one record.

const DB_NAME = "fleet-backup";
const STORE = "handles";

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readonly");
    const r = tx.objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => resolve(null);
  });
}

export function folderSupported() {
  return typeof window.showDirectoryPicker === "function";
}

// The stored folder is per company too, for the same reason as the preferences.
function folderKey() {
  return `folder:${state.ctx?.companyId || "none"}`;
}

// Asks for a folder. Must be called straight from a click — the browser refuses
// otherwise, by design.
export async function chooseFolder() {
  if (!folderSupported()) throw new Error("This browser cannot save to a folder.");
  const handle = await window.showDirectoryPicker({ mode: "readwrite" });
  await idbPut(folderKey(), handle);
  return handle.name;
}

export async function forgetFolder() {
  await idbPut(folderKey(), null);
}

// Permission is not permanent: the browser may ask again after a restart, and it
// will only ask during a click. So a silent check is separated from a prompting
// one, and the automatic path uses the silent version.
export async function folderStatus() {
  if (!folderSupported()) return { supported: false, name: null, ready: false };
  const handle = await idbGet(folderKey());
  if (!handle) return { supported: true, name: null, ready: false };
  let perm = "prompt";
  try { perm = await handle.queryPermission({ mode: "readwrite" }); } catch {}
  return { supported: true, name: handle.name, ready: perm === "granted" };
}

async function folderForWriting({ mayPrompt }) {
  const handle = await idbGet(folderKey());
  if (!handle) return null;
  let perm = "prompt";
  try { perm = await handle.queryPermission({ mode: "readwrite" }); } catch {}
  if (perm !== "granted" && mayPrompt) {
    try { perm = await handle.requestPermission({ mode: "readwrite" }); } catch {}
  }
  return perm === "granted" ? handle : null;
}

// ---------- Running a backup ----------

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function writeToFolder(handle, filename, blob) {
  const file = await handle.getFileHandle(filename, { create: true });
  const w = await file.createWritable();
  await w.write(blob);
  await w.close();
}

/**
 * Runs a backup and reports exactly what happened, so the caller can tell the
 * user the truth rather than a generic "done".
 *
 * mayPrompt: false for the automatic run on opening the app — a permission
 * dialog out of nowhere is startling, and the browser would block it anyway.
 */
export async function runBackup({ mayPrompt = true } = {}) {
  const prefs = backupPrefs();
  const categories = CATEGORIES
    .map(c => c.key)
    .filter(k => prefs.categories.includes(k));

  if (categories.length === 0) {
    return { ok: false, reason: "Nothing is selected to back up." };
  }

  // Build the file. xlsx if the library loads, CSV if it does not.
  let blob, ext, format;
  try {
    blob = await buildXlsx(categories);
    ext = "xlsx"; format = "Excel workbook";
  } catch {
    const parts = categories.map(k =>
      `--- ${BUILDERS[k].sheet} ---\n${toCsv(BUILDERS[k].rows())}`);
    blob = new Blob([parts.join("\n\n")], { type: "text/csv;charset=utf-8;" });
    ext = "csv"; format = "CSV (the Excel library could not be reached)";
  }

  const filename = `fleet-backup-${safeName()}-${stamp()}.${ext}`;

  let where;
  const handle = prefs.auto ? await folderForWriting({ mayPrompt }) : null;
  if (handle) {
    try {
      await writeToFolder(handle, filename, blob);
      where = `saved to your ${handle.name} folder`;
    } catch (e) {
      downloadBlob(filename, blob);
      where = `downloaded — writing to the folder failed (${e.name || e.message})`;
    }
  } else {
    downloadBlob(filename, blob);
    where = prefs.auto && !mayPrompt
      ? "downloaded — the folder needs permission again, open Settings to confirm it"
      : "downloaded to this device";
  }

  saveBackupPrefs({ lastRun: new Date().toISOString() });
  return { ok: true, filename, format, where, categories: categories.length };
}
