// Reports view — the grids the pilot's finance office kept by hand.
//
// Three reports, one on screen at a time: what each car earned, what each car
// cost, and the two set against each other month by month with an occupancy
// figure beside them.
//
// Everything is derived from bookings and expenses already in memory, so the
// page costs no extra database reads and can never disagree with Billing —
// they add up the same records, filed the same way.

import {
  state, onDataChange, esc, formatAmount, formatDate, todayStr,
  revenueByCarMonth, expensesByCarMonth, monthlySummary,
  bookingYears, companyName, bookingCarLabel, bookingRef,
  invoiceTotal, amountDue, vatSplit, balanceFor, paidPatch, paidTotal, hasLedger, hasStarted,
  rentalDays, MONTH_NAMES,
  customerForBooking,
  extraEntities, mainEntity,
  revenueByBrokerMonth,
  loadPref, savePref, el, takeFocus
} from "./store.js";
import { loadXlsx, downloadBlob } from "./backup.js";
import { openVoidedInvoice, openInvoice } from "./agreement.js";
import { openPayModal, openDepositModal, invoiceDetailsHtml, contactByEmail, contactByWhatsApp } from "./view-billing.js";
import { openBookingModal } from "./booking-form.js";
import { db, setSync } from "./firebase-init.js";
import { updateDoc, doc, arrayUnion } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let root = null;
let year = "";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Bare numbers in the grids, with the currency named once beneath. "Rs" on
// every one of 168 cells is noise, and it costs the width that lets a month
// column fit on screen — a finance sheet reads as columns of figures, not as
// columns of sentences.
function money(n) {
  return Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
}
function percent(x) {
  return `${(Number(x || 0) * 100).toFixed(0)}%`;
}

// ---------- Which report is on screen ----------
// A tab rather than three stacked panels. Collapsible blocks were the first
// attempt, and what Arshad asked for — but with three headings on screen and
// one table open it was never obvious which heading owned the table, and no
// report got the width a fifteen-column grid needs. One report at a time,
// chosen the way Billing and Tasks choose a filter, answers both.
//
// The choice is remembered per device: whoever opens this page is usually
// coming back to the same report.
const REPORTS = ["revenue", "expenses", "monthly", "invoices"];
let current = "revenue";

// ---------- Invoices tab state ----------
// Filtered by the day the number was issued, because that is the day the
// document legally exists — and the day the MRA files it under. The default
// window is the current quarter, which is the period the VAT return covers.
let invFrom = "";
let invTo = "";
let invKind = "";   // "" all · "vat" · "normal"
let invScope = "issued";   // "issued" (by issue date) · "all" (every booking, by start date)
// The Billing page's own filters, carried over so Invoices can replace it
// (pilot barely opens Billing, 25 Aug): a search, the paid / unpaid / not
// started split, and a broker. All three work in both scopes.
let invQ = "";             // customer, car or invoice number
let invStatus = "all";     // all · unpaid · paid · upcoming
let invBroker = "*";       // "*" = every broker
// The filter block costs most of a phone screen — six controls and a button
// above a table that is the actual answer. On a phone it collapses behind one
// toggle, closed by default, remembered per device; the search box stays out
// so the commonest action needs no opening. Desktop has the room and is
// untouched (the media query alone decides that, so rotating a phone needs
// no redraw). A plain .btn, so it takes the CONTROL STANDARD sizing with
// no rule of its own; the caret follows the Legend/Summary convention.
let invFiltersOpen = loadPref("reports:invFilters", false);

// ---------- The first column's width ----------
// The same handle the planner puts in its corner, for the same reason: the
// left column is the one people want wider (a long invoice number) or
// narrower (to reach the money columns without scrolling). Drag to resize,
// double-tap to reset, remembered per device — identical behaviour to
// Bookings, so it only has to be learned once.
//
// A table cannot be resized the planner's way (that is a CSS grid template).
// The width travels as a custom property on the scroll wrapper instead, which
// survives the innerHTML redraws the reports do on every change.
const REP_CAR_MIN = 120;
const REP_CAR_MAX = 460;
let repCarW = Number(loadPref("reports:carW", 0)) || 0;

// The header cell of a report's first column. The resize grip is opt-in and
// only the Invoices tables ask for it now: on the by-car and month grids it
// floated over the month headings on a phone and dragging it there did
// nothing useful (pilot's screenshot, 27 Aug 19:00). The drag machinery
// further down is delegated on [data-rep-grip], so a table without the grip
// simply has nothing to grab — no other change needed.
function repCarHead(label, withGrip) {
  const grip = withGrip ? `<span class="tl-colgrip" data-rep-grip
    title="Drag to resize this column \u00b7 double-click to reset">\u22ee\u22ee</span>` : "";
  return `<th class="rep-car">${label}${grip}</th>`;
}

function applyRepCarW(w) {
  const box = el(root, "rep-table");
  if (!box) return;
  if (w) box.style.setProperty("--rep-car-w", w + "px");
  else box.style.removeProperty("--rep-car-w");
}

// Set by a jump from a booking; cleared as soon as the row has been shown.
let revealInvoice = null;

// Everything that has to be true for one invoice to be on screen. Filters are
// widened rather than wiped: a date window that already contains the invoice
// is left alone, so arriving from a booking does not silently throw away the
// month someone was looking at.
function applyInvoiceFocus(id) {
  const b = state.bookings.find(x => x.id === id);
  if (!b) return;

  current = "invoices";
  savePref("reports:tab", current);

  // A search box or a status/broker filter could hide it whatever the dates.
  invQ = "";
  invStatus = "all";
  invBroker = "*";
  invKind = "";

  // The issued scope files a row under its issue DATE, and an invoice raised
  // before the app began recording that date has none — such a row carries an
  // empty date and is dropped by any window at all. So the issued scope is
  // used only when there is a real issue date to file under; everything else
  // goes to the all-bookings scope, which files by start date and lists every
  // booking, invoiced or not. Both scopes show the invoice number.
  const at = String(b.invoiceIssuedAt || "").slice(0, 10);
  const issued = !!b.invoiceNo && at.length === 10;
  invScope = issued ? "issued" : "all";
  const anchor = (issued ? at : "")
    || String(b.startDate || "").slice(0, 10)
    || todayStr();

  if (!invFrom) invFrom = quarterStart(todayStr());
  if (!invTo) invTo = todayStr();
  if (anchor < invFrom) invFrom = anchor;
  if (anchor > invTo) invTo = anchor;

  // Drawn already open, so the breakdown is there the moment it is seen.
  invOpen.add(id);
  revealInvoice = id;
}

// Rows whose reminder panel is open. Same reason as invOpen below: a redraw
// arrives whenever any booking changes, and it must not shut a panel the
// person is reading a phone number off.
const invRemindOpen = new Set();

// Rows whose breakdown is open under them. Module-level so a redraw after
// recording a payment leaves the row the person was working on still open.
const invOpen = new Set();

// Same three-way split as Billing: paid wins, else started = owed now, else
// nothing due yet. One rule, so the counts here match its tabs to the penny.
function invCategory(b) {
  return b.paid ? "paid" : hasStarted(b) ? "unpaid" : "upcoming";
}

function quarterStart(t) {
  const m = Number(t.slice(5, 7));
  const qm = m <= 3 ? "01" : m <= 6 ? "04" : m <= 9 ? "07" : "10";
  return `${t.slice(0, 4)}-${qm}-01`;
}

function issuedInvoices() {
  // "Everything" widens the register to every booking, invoiced or not, so
  // nothing can hide from the money page by never having been invoiced. An
  // uninvoiced booking files under its start date instead of an issue date.
  const everything = invKind === "everything";
  const voidRows = [];
  state.bookings.forEach(b => (b.voidedInvoices || []).forEach(v => voidRows.push({
    b, no: String(v.no || ""), at: String(v.issuedAt || "").slice(0, 10),
    total: Number(v.total) || 0, isVat: v.kind === "vat", split: null,
    entityId: v.entityId || "", received: 0, balance: 0, status: "VOID",
    voided: true, voidedAt: String(v.voidedAt || "").slice(0, 10)
  })));
  const live = state.bookings
    .filter(b => everything || b.invoiceNo)
    .map(b => {
      const at = String(b.invoiceIssuedAt || "").slice(0, 10)
        || (everything ? String(b.startDate || "").slice(0, 10) : "");
      // The figure as invoiced when the snapshot exists (from Aug 2026 on);
      // today's amount due for invoices issued before the snapshot existed.
      const total = typeof b.invoiceTotalAt === "number" ? b.invoiceTotalAt : amountDue(b);
      const isVat = b.invoiceKind === "vat";
      const pct = typeof b.invoiceVatPct === "number" && b.invoiceVatPct > 0 ? b.invoiceVatPct : 15;
      const split = isVat && b.invoiceNo ? vatSplit(total, pct) : null;
      const received = paidTotal(b);
      return { b, no: String(b.invoiceNo || ""), at, isVat, pct, total,
               excl: split ? split.excl : null, vat: split ? split.vat : null,
               received,
               balance: b.paid ? 0 : balanceFor(b),
               status: b.paid ? "Paid" : hasStarted(b) ? "Owed" : "Upcoming" };
    })
    .filter(r => r.at && (!invFrom || r.at >= invFrom) && (!invTo || r.at <= invTo)
      && (everything || !invKind || (invKind === "vat") === r.isVat)
      && (repEntity === "*"
        || (r.no ? (r.b.invoiceEntityId || "") === repEntity
                 : carEntityId(r.b.carId) === repEntity)))
    ;
  // voided numbers obey the same range, kind and company filters as live
  // ones — a register where VOID rows ignore the filters is just noise
  const okVoid = v =>
    v.at && (!invFrom || v.at >= invFrom) && (!invTo || v.at <= invTo)
    && (everything || !invKind || (invKind === "vat") === v.isVat)
    && (repEntity === "*" || (v.entityId || "") === repEntity);
  return live.concat(voidRows.filter(okVoid))
    .sort((a, c) => a.at.localeCompare(c.at) || a.no.localeCompare(c.no));
}

function wireTabs() {
  const box = el(root, "rep-tabs");
  if (!box) return;

  const saved = loadPref("reports:tab", "revenue");
  if (REPORTS.includes(saved)) current = saved;

  box.addEventListener("click", e => {
    const t = e.target.closest(".tab");
    if (!t || !t.dataset.rep) return;
    current = t.dataset.rep;
    savePref("reports:tab", current);
    paintTabs();
    render();
  });
  paintTabs();
}

function paintTabs() {
  const box = el(root, "rep-tabs");
  if (!box) return;
  box.querySelectorAll(".tab").forEach(t =>
    t.classList.toggle("active", t.dataset.rep === current));
}

export function mount(container) {
  root = container;
  wireTabs();

  el(root, "rep-entity").addEventListener("change", () => {
    repEntity = el(root, "rep-entity").value;
    render();
  });
  el(root, "rep-year").addEventListener("change", () => {
    year = el(root, "rep-year").value;
    render();
  });

  el(root, "rep-export").addEventListener("click", exportXlsx);

  // The invoices tab draws its own date filters and export button into the
  // table area, so their events are picked up here by delegation — the
  // elements are recreated on every render.
  el(root, "rep-controls").addEventListener("change", (e) => {
    const inp = e.target.closest("input[data-inv], select[data-inv]");
    if (!inp) return;
    if (inp.dataset.inv === "q") return;   // the search box has its own live handler below
    if (inp.dataset.inv === "from") invFrom = inp.value;
    else if (inp.dataset.inv === "to") invTo = inp.value;
    else if (inp.dataset.inv === "scope") invScope = inp.value;
    else if (inp.dataset.inv === "status") invStatus = inp.value;
    else if (inp.dataset.inv === "broker") invBroker = inp.value;
    else invKind = inp.value;
    render();
  });
  // The search box filters as you type. The controls are NOT rebuilt on each
  // keystroke — that would take the caret away mid-word — only the table
  // below and the counts in the status menu are redrawn.
  el(root, "rep-controls").addEventListener("input", (e) => {
    const inp = e.target.closest('input[data-inv="q"]');
    if (!inp) return;
    invQ = inp.value;
    paintInvoiceTable();
    paintStatusCounts();
    // Searching rebuilds the table, and narrower content means narrower
    // columns — so the frozen heading has to be measured again.
    requestAnimationFrame(syncRepHead);
  });
  el(root, "rep-controls").addEventListener("click", (e) => {
    if (e.target.closest("[data-inv-export]")) { exportInvoicesXlsx(); return; }
    // Redrawing only the control block leaves the table and its open rows
    // exactly where they are.
    if (e.target.closest("[data-inv-toggle]")) {
      invFiltersOpen = !invFiltersOpen;
      savePref("reports:invFilters", invFiltersOpen);
      paintInvoiceControls();
    }
  });
  // The column grip. Pointer events (not mouse) so it works on the phone,
  // with the pointer captured so a fast drag that leaves the header keeps
  // resizing rather than stopping dead.
  {
    const box = el(root, "rep-table");
    let drag = null;
    box.addEventListener("pointerdown", (e) => {
      const grip = e.target.closest("[data-rep-grip]");
      if (!grip) return;
      const cell = grip.closest(".rep-car");
      drag = { x: e.clientX, w: repCarW || (cell ? cell.getBoundingClientRect().width : 190) };
      box.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    box.addEventListener("pointermove", (e) => {
      if (!drag) return;
      repCarW = Math.round(Math.min(REP_CAR_MAX, Math.max(REP_CAR_MIN, drag.w + e.clientX - drag.x)));
      applyRepCarW(repCarW);
    });
    const finish = () => {
      if (!drag) return;
      drag = null;
      savePref("reports:carW", repCarW);
    };
    box.addEventListener("pointerup", finish);
    box.addEventListener("pointercancel", finish);
    box.addEventListener("dblclick", (e) => {
      if (!e.target.closest("[data-rep-grip]")) return;
      repCarW = 0;
      savePref("reports:carW", 0);
      applyRepCarW(0);
    });
  }

  el(root, "rep-table").addEventListener("click", (e) => {
    // The number itself opens the document — a real click, so no pop-up
    // blocker has anything to say about it.
    const voidBtn = e.target.closest("[data-print-void]");
    if (voidBtn) { openVoidedInvoice(voidBtn.dataset.printVoid, voidBtn.dataset.voidNo); return; }
    const openBtn = e.target.closest("[data-open-invoice]");
    if (openBtn) {
      const r = openInvoice(openBtn.dataset.openInvoice);
      if (!r.ok) alert(r.reason);
      return;
    }
    // "Issue invoice" opens the booking — the Invoice button is in its
    // action bar, and issuing stays one deliberate act in one place.
    const bk = e.target.closest("[data-open-booking]");
    if (bk) { openBookingModal(bk.dataset.openBooking); return; }
    // Record payment / Payments opens the same dialog Billing uses — one
    // dialog, one write path, so the two pages can never disagree.
    const rec = e.target.closest("[data-payrec]");
    if (rec) { openPayModal(rec.dataset.payrec); return; }
    const dep = e.target.closest("[data-dep]");
    if (dep) { openDepositModal(dep.dataset.dep); return; }
    const pay = e.target.closest("[data-pay]");
    if (pay) { setPaidFromReports(pay.dataset.pay, pay.dataset.to === "1"); return; }
    // The rest of Billing's card actions, now under the row's breakdown.
    const rem = e.target.closest("[data-remind]");
    if (rem) { toggleReminder(rem.dataset.remind); return; }
    const em = e.target.closest("[data-remind-email]");
    if (em) { const b = state.bookings.find(x => x.id === em.dataset.remindEmail); if (b) contactByEmail(b); return; }
    const wa = e.target.closest("[data-remind-wa]");
    if (wa) { const b = state.bookings.find(x => x.id === wa.dataset.remindWa); if (b) contactByWhatsApp(b); return; }
    const sec = e.target.closest("[data-secstatus]");
    if (sec) { setSecurityStatus(sec.dataset.secstatus, sec.dataset.to); return; }
    // Anything else on an invoice row opens or closes its breakdown. Buttons
    // and links have all returned above, so a click on them never toggles.
    const row = e.target.closest("tr[data-toggle]");
    if (row) toggleInvoiceRow(row.dataset.toggle);
  });

  onDataChange(() => { if (root.classList.contains("active")) render(); });
}

// Rebuilt on every draw because a booking or expense saved for another year
// has to appear without a reload. The current choice is kept if it still
// exists, so a redraw never silently moves the page to another year.
function refreshYearOptions() {
  const sel = el(root, "rep-year");
  const years = bookingYears();
  if (!years.includes(year)) {
    const thisYear = todayStr().slice(0, 4);
    year = years.includes(thisYear) ? thisYear : years[0];
  }
  sel.innerHTML = years.map(y => `<option value="${esc(y)}">${esc(y)}</option>`).join("");
  sel.value = year;
}

let repEntity = "*";   // "*" = all companies, "" = main, otherwise entity id
let billStatus = "all";
let billMonth = "*";        // "*" = the whole year, otherwise "01".."12"      // all | paid | unpaid | upcoming
let billBroker = "*";        // "*" = everyone

// The company filter appears only when trading companies exist — the
// single-company customer never sees it (pilot, 21 Aug: "filter by Company").
function paintEntityFilter() {
  const sel = el(root, "rep-entity");
  if (!sel) return;
  const extras = extraEntities();
  if (!extras.length) { sel.style.display = "none"; repEntity = "*"; return; }
  sel.style.display = "";
  const opts = [["*", "All companies"], ["", mainEntity().name || "Main company"],
    ...extras.map(e => [e.id, e.name])];
  sel.innerHTML = opts.map(([v, n]) =>
    `<option value="${esc(v)}"${repEntity === v ? " selected" : ""}>${esc(n)}</option>`).join("");
}

function carEntityId(carId) {
  return (state.cars.find(c => c.id === carId)?.entityId) || "";
}
function rowInCompany(r) {
  if (repEntity === "*") return true;
  if (!r.carId) return false;             // "cars no longer in the fleet" can't be attributed
  return carEntityId(r.carId) === repEntity;
}

// Filtering a car report means rebuilding its aggregate, not just dropping
// rows — the month footer, grand total and average must describe exactly the
// rows on screen, or the report earns the fate the store's own comment
// promises for totals that don't match. (The first version called .filter on
// the report OBJECT — a TypeError that blanked the whole page, 22 Aug.)
function filterReport(data) {
  if (repEntity === "*") return data;
  const rows = data.rows.filter(rowInCompany);
  const totals = Array.from({ length: 12 }, (_, m) =>
    Math.round(rows.reduce((s, r) => s + (Number(r.months[m]) || 0), 0) * 100) / 100);
  const grandTotal = Math.round(totals.reduce((s, v) => s + v, 0) * 100) / 100;
  const busy = totals.filter(v => v > 0).length;
  return { ...data, rows, totals, grandTotal, average: busy ? grandTotal / busy : 0 };
}

export function render() {
  if (!root) return;
  // Arriving from a booking's "View invoice": switch to the register, widen
  // whatever is filtering it until that invoice is inside the window, and
  // mark it to be opened and flashed once the table is drawn. Done before
  // anything is painted, so the tab and the filters are already right.
  const focusId = takeFocus("reports");
  if (focusId) applyInvoiceFocus(focusId);
  applyRepCarW(repCarW);   // the property lives on the wrapper, which survives redraws
  refreshYearOptions();
  paintTabs();
  paintEntityFilter();

  const rev = filterReport(revenueByCarMonth(year));
  const exp = filterReport(expensesByCarMonth(year));
  const mon = monthlySummary(year);

  if (current === "invoices") {
    if (!invFrom) invFrom = quarterStart(todayStr());
    if (!invTo) invTo = todayStr();
  } else {
    const slot = el(root, "rep-controls");
    if (slot) slot.innerHTML = "";
  }

  if (current === "revenue") renderCarGrid(rev, "earned", "revenue");
  else if (current === "billing") renderBillingReport();
  else if (current === "broker") {
    // brokers can't be attributed to a trading company without guessing —
    // the same honest note as month-by-month when the filter is active
    renderCarGrid(revenueByBrokerMonth(year), "earned", "broker");
    if (repEntity !== "*") {
      const out = el(root, "rep-table");
      if (out) out.insertAdjacentHTML("afterbegin",
        `<div class="rep-note">By broker always shows all companies \u2014 the company filter applies to the other tabs.</div>`);
    }
  }
  else if (current === "expenses") renderCarGrid(exp, "spent", "expenses");
  else if (current === "invoices") renderInvoices();
  else {
    renderMonthly(mon);
    // this tab sums bookings and expenses whole — a per-company split of it
    // is a later build; say so rather than showing unfiltered numbers under
    // a filter that looks applied
    if (repEntity !== "*") {
      const out = el(root, "rep-table");
      if (out) out.insertAdjacentHTML("afterbegin",
        `<div class="rep-note">Month by month always shows all companies \u2014 the company filter applies to the other tabs.</div>`);
    }
  }

  // One call for every tab: each branch above has just written its table, and
  // the frozen heading is measured from whatever ended up there. After paint,
  // so the browser has laid the columns out and the widths are real.
  requestAnimationFrame(syncRepHead);
}


// ---------- The two car grids ----------
// One function for both: a report that totalled its rows differently from its
// sibling would be a bug waiting to be argued about in a meeting.
// The Billing page as a table with filters — his words: "just convert the
// Billing tab in tabular form" with Unpaid / not started / brokers (24 Aug).
// Same category rule as Billing (paid wins; else started = unpaid, else
// upcoming), same money helpers, so the two screens can never disagree.
// The foreign amount as agreed on the booking, if there was one. Not a
// conversion — the rupee total in the next column is the book figure.
function fxCell(b) {
  if (!b.fxCurrency || !(Number(b.fxTotal) > 0)) return `<span class="rep-zero">\u2014</span>`;
  return esc(`${b.fxCurrency} ${Number(b.fxTotal).toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
}
function fxTotalsCell(fx) {
  const parts = Object.entries(fx).filter(([, v]) => v > 0);
  if (!parts.length) return `<span class="rep-zero">\u2014</span>`;
  return parts.map(([sym, v]) =>
    esc(`${sym} ${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`)).join("<br>");
}

function renderBillingReport() {
  const box = el(root, "rep-table");
  const note = el(root, "rep-note");
  const ctrl = el(root, "rep-controls");
  const y = String(year);
  const catOf = b => b.paid ? "paid" : hasStarted(b) ? "unpaid" : "upcoming";

  let rows = state.bookings.filter(b => String(b.startDate || "").slice(0, 4) === y);
  // Filed by start date, the same date the rest of this tab is built on.
  if (billMonth !== "*") rows = rows.filter(b => String(b.startDate || "").slice(5, 7) === billMonth);
  if (repEntity !== "*") rows = rows.filter(b => carEntityId(b.carId) === repEntity);
  const brokers = [...new Set(rows.map(b => (b.broker || "").trim()).filter(Boolean))].sort();
  if (billBroker !== "*") rows = rows.filter(b => (b.broker || "").trim() === billBroker);
  if (billStatus !== "all") rows = rows.filter(b => catOf(b) === billStatus);
  rows.sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));

  ctrl.innerHTML = `<div class="filter-row" style="margin-bottom:8px;">
      <select data-el="bill-month">
        <option value="*">Whole year</option>
        ${MONTH_NAMES.map((n, i) => {
          const v = String(i + 1).padStart(2, "0");
          return `<option value="${v}"${billMonth === v ? " selected" : ""}>${n}</option>`;
        }).join("")}
      </select>
      <select data-el="bill-status">
        ${[["all", "All bookings"], ["paid", "Paid"], ["unpaid", "Unpaid"], ["upcoming", "Not started"]]
          .map(([v, n]) => `<option value="${v}"${billStatus === v ? " selected" : ""}>${n}</option>`).join("")}
      </select>
      <select data-el="bill-broker">
        <option value="*">All brokers</option>
        ${brokers.map(n => `<option value="${esc(n)}"${billBroker === n ? " selected" : ""}>${esc(n)}</option>`).join("")}
      </select>
    </div>`;
  ctrl.querySelector('[data-el="bill-month"]').addEventListener("change", (e) => { billMonth = e.target.value; render(); });
  ctrl.querySelector('[data-el="bill-status"]').addEventListener("change", (e) => { billStatus = e.target.value; render(); });
  ctrl.querySelector('[data-el="bill-broker"]').addEventListener("change", (e) => { billBroker = e.target.value; render(); });

  if (!rows.length) {
    box.innerHTML = `<div class="empty">No bookings match in ${esc(billMonth === "*" ? y : MONTH_NAMES[Number(billMonth) - 1] + " " + y)}.</div>`;
    note.textContent = "";
    return;
  }
  const BADGE = { paid: "Paid", unpaid: "Unpaid", upcoming: "Not started" };
  const totals = rows.reduce((a, b) => {
    a.total += invoiceTotal(b); a.recv += paidTotal(b); a.days += rentalDays(b);
    if (catOf(b) === "unpaid") a.owed += balanceFor(b);
    // Foreign amounts are totalled per currency and never converted: the books
    // are in rupees, and the agreed rate differs booking by booking, so adding
    // euros to dollars — or to rupees — would invent a number nobody agreed.
    if (b.fxCurrency && Number(b.fxTotal) > 0) {
      a.fx[b.fxCurrency] = (a.fx[b.fxCurrency] || 0) + Number(b.fxTotal);
    }
    return a;
  }, { total: 0, recv: 0, owed: 0, days: 0, fx: {} });

  box.innerHTML = `<table class="rep-table">
    <thead><tr><th>Booking</th><th>Renter</th><th>Car</th><th>From</th><th>To</th>
      <th class="rep-num">Days</th><th>Broker</th>
      <th class="rep-num">Total</th><th class="rep-num">Paid in</th>
      <th class="rep-num">Received</th><th class="rep-num">Balance</th><th>Status</th></tr></thead>
    <tbody>
      ${rows.map(b => `<tr>
        <td>${esc(bookingRef(b))}</td><td>${esc(b.renter || "")}</td><td>${esc(bookingCarLabel(b))}</td>
        <td>${esc(formatDate(b.startDate))}</td><td>${esc(formatDate(b.endDate))}</td>
        <td class="rep-num">${rentalDays(b)}</td>
        <td>${esc(b.broker || "\u2014")}</td>
        <td class="rep-num">${esc(formatAmount(invoiceTotal(b)))}</td>
        <td class="rep-num">${fxCell(b)}</td>
        <td class="rep-num">${esc(formatAmount(paidTotal(b)))}</td>
        <td class="rep-num">${esc(formatAmount(balanceFor(b)))}</td>
        <td>${BADGE[catOf(b)]}</td></tr>`).join("")}
    </tbody>
    <tfoot><tr><th colspan="5">${rows.length} booking${rows.length === 1 ? "" : "s"}</th>
      <th class="rep-num">${totals.days}</th>
      <th></th>
      <th class="rep-num">${esc(formatAmount(totals.total))}</th>
      <th class="rep-num">${fxTotalsCell(totals.fx)}</th>
      <th class="rep-num">${esc(formatAmount(totals.recv))}</th>
      <th class="rep-num">${esc(formatAmount(totals.owed))}</th><th></th></tr></tfoot>
  </table>`;
  note.textContent = "Balance column sums only unpaid, started bookings \u2014 the same rule as the Billing page.";
}

function renderCarGrid(data, verb, which) {
  const box = el(root, "rep-table");
  const note = el(root, "rep-note");

  if (!data.rows.length) {
    box.innerHTML = `<div class="empty">No cars yet — add some on the Fleet page.</div>`;
    note.textContent = "";
    return;
  }
  if (data.grandTotal === 0) {
    box.innerHTML = `<div class="empty">Nothing ${esc(verb)} in ${esc(year)}. Pick another year above.</div>`;
    note.textContent = "";
    return;
  }

  // A zero prints as a dash. A grid of "0" is unreadable, and the eye needs to
  // find the months that moved, not the months that did not.
  const cell = v => v > 0
    ? `<td class="rep-num">${esc(money(v))}</td>`
    : `<td class="rep-num rep-zero">—</td>`;

  box.innerHTML = `
    <table class="rep-table rep-cargrid">
      <thead>
        <tr>
          ${repCarHead("Car")}
          ${MONTHS.map(m => `<th class="rep-num">${m}</th>`).join("")}
          <th class="rep-num rep-strong">Total</th>
          <th class="rep-num">Average</th>
        </tr>
      </thead>
      <tbody>
        ${data.rows.map(r => `
          <tr${r.total === 0 ? ` class="rep-idle"` : ""}>
            <th class="rep-car">
              <span class="rep-plate">${esc(r.plate || (r.label === "Not car-specific" ? "—" : "no plate"))}</span>
              <span class="rep-model">${esc(r.label)}</span>
            </th>
            ${r.months.map(cell).join("")}
            ${r.total > 0
              ? `<td class="rep-num rep-strong">${esc(money(r.total))}</td>
                 <td class="rep-num">${esc(money(r.average))}</td>`
              : `<td class="rep-num rep-zero">—</td><td class="rep-num rep-zero">—</td>`}
          </tr>`).join("")}
      </tbody>
      <tfoot>
        <tr>
          <th class="rep-car">All cars</th>
          ${data.totals.map(cell).join("")}
          <td class="rep-num rep-strong">${esc(money(data.grandTotal))}</td>
          <td class="rep-num">${esc(money(data.average))}</td>
        </tr>
      </tfoot>
    </table>`;

  note.textContent = "";
}

// ---------- Month by month ----------
function renderMonthly(mon) {
  const box = el(root, "rep-table");
  const note = el(root, "rep-note");

  if (!mon.months.some(m => m.active)) {
    box.innerHTML = `<div class="empty">Nothing recorded in ${esc(year)}. Pick another year above.</div>`;
    note.textContent = "";
    return;
  }

  const num = v => v !== 0
    ? `<td class="rep-num">${esc(money(v))}</td>`
    : `<td class="rep-num rep-zero">—</td>`;

  box.innerHTML = `
    <table class="rep-table rep-months">
      <thead>
        <tr>
          ${repCarHead("Month")}
          <th class="rep-num">Occupancy</th>
          <th class="rep-num">Days rented</th>
          <th class="rep-num">Income</th>
          <th class="rep-num">Expenses</th>
          <th class="rep-num rep-strong">Net income</th>
        </tr>
      </thead>
      <tbody>
        ${mon.months.map(m => `
          <tr${m.active ? "" : ` class="rep-idle"`}>
            <th class="rep-car"><span class="rep-plate">${MONTHS[m.month]}</span></th>
            ${m.active
              ? `<td class="rep-num">${esc(percent(m.occupancy))}</td>
                 <td class="rep-num">${esc(money(m.rentedDays))} of ${esc(money(m.availableDays))}</td>`
              : `<td class="rep-num rep-zero">—</td><td class="rep-num rep-zero">—</td>`}
            ${num(m.income)}
            ${num(m.expenses)}
            ${m.active
              ? `<td class="rep-num rep-strong ${m.net < 0 ? "rep-neg" : ""}">${esc(money(m.net))}</td>`
              : `<td class="rep-num rep-zero">—</td>`}
          </tr>`).join("")}
      </tbody>
      <tfoot>
        <tr>
          <th class="rep-car">Total</th>
          <td class="rep-num">${esc(percent(mon.total.occupancy))}</td>
          <td class="rep-num rep-zero">—</td>
          <td class="rep-num">${esc(money(mon.total.income))}</td>
          <td class="rep-num">${esc(money(mon.total.expenses))}</td>
          <td class="rep-num rep-strong ${mon.total.net < 0 ? "rep-neg" : ""}">${esc(money(mon.total.net))}</td>
        </tr>
        <tr>
          <th class="rep-car">Average</th>
          <td class="rep-num">${esc(percent(mon.average.occupancy))}</td>
          <td class="rep-num rep-zero">—</td>
          <td class="rep-num">${esc(money(mon.average.income))}</td>
          <td class="rep-num">${esc(money(mon.average.expenses))}</td>
          <td class="rep-num rep-strong ${mon.average.net < 0 ? "rep-neg" : ""}">${esc(money(mon.average.net))}</td>
        </tr>
      </tfoot>
    </table>`;

  note.textContent = "";
}

// ---------- The invoices register ----------
// Every invoice the company has issued, filtered by issue date, with the VAT
// inside each one stated — because every three months this exact list, for
// one quarter, goes to the MRA. The export button hands over the filtered
// list as a spreadsheet for precisely that trip.
// Every booking in the window, invoiced or not — the view for running the
// money once invoices become the money page. Filtered by rental start date,
// because an uninvoiced booking has no issue date to filter by.
function allBookingRows() {
  return state.bookings
    .map(b => ({
      b,
      start: String(b.startDate || "").slice(0, 10),
      no: String(b.invoiceNo || ""),
      total: typeof b.invoiceTotalAt === "number" ? b.invoiceTotalAt : amountDue(b),
      received: paidTotal(b),
      balance: b.paid ? 0 : balanceFor(b)
    }))
    .filter(r => r.start && (!invFrom || r.start >= invFrom) && (!invTo || r.start <= invTo))
    .sort((a, c) => a.start.localeCompare(c.start));
}

// One list for the table, the counts and the export: the window (scope +
// dates + kind + company) first, then Billing's three filters on top.
function invBase() {
  return invScope === "all" ? allBookingRows() : issuedInvoices();
}
function invMatches(r) {
  const q = invQ.trim().toLowerCase();
  if (q && !`${r.b.renter || ""} ${bookingCarLabel(r.b)} ${r.no}`.toLowerCase().includes(q)) return false;
  if (invBroker !== "*" && (r.b.broker || "").trim() !== invBroker) return false;
  return true;
}
function invoiceRows() {
  const rows = invBase().filter(invMatches);
  if (invStatus === "all") return rows;
  // A voided number is neither paid nor owed; it shows under All only.
  return rows.filter(r => !r.voided && invCategory(r.b) === invStatus);
}
// What each status option would show, search and broker included — the same
// promise Billing's tab counts make.
function invStatusCounts() {
  const rows = invBase().filter(invMatches);
  const n = { all: rows.length, unpaid: 0, paid: 0, upcoming: 0 };
  rows.forEach(r => { if (!r.voided) n[invCategory(r.b)]++; });
  return n;
}
const STATUS_LABELS = [["all", "All"], ["unpaid", "Unpaid"], ["paid", "Paid"], ["upcoming", "Not started"]];

// ---------- The frozen heading ----------
// Same arrangement as the planner and the two boards: the heading that must
// stay still lives OUTSIDE the scrolling box. A copy of the real <thead> is
// placed in .rep-head-wrap, which sticks to the page and is scrolled sideways
// only by mirroring the table. The real heading stays in the table so the
// columns keep their natural widths — the copy is measured from it and laid
// over it, so at rest the two are indistinguishable.
//
// The first attempt (26 Aug) capped the table's height instead. That did
// freeze the heading, but only by giving the table its own vertical
// scrollbar — the window-in-a-window the pilot had already asked to remove.
function syncRepHead() {
  const wrap = el(root, "rep-head-wrap");
  const box = el(root, "rep-table");
  if (!wrap || !box) return;

  const table = box.querySelector("table.rep-table");
  const head = table && table.tHead;
  if (!head) { wrap.style.display = "none"; wrap.innerHTML = ""; return; }

  // Copy, then force every column to the width the real one actually got.
  // Without fixed widths the copy would lay itself out from its own content
  // and drift a few pixels per column — visible as a shiver on scroll.
  const clone = document.createElement("table");
  clone.className = table.className;
  clone.appendChild(head.cloneNode(true));

  const cells = [...head.rows[0].cells];
  const widths = cells.map(c => c.getBoundingClientRect().width);
  const total = widths.reduce((a, w) => a + w, 0);
  if (!total) { wrap.style.display = "none"; return; }

  const colgroup = document.createElement("colgroup");
  widths.forEach(w => {
    const col = document.createElement("col");
    col.style.width = w + "px";
    colgroup.appendChild(col);
  });
  clone.insertBefore(colgroup, clone.firstChild);
  clone.style.tableLayout = "fixed";
  clone.style.width = total + "px";

  wrap.innerHTML = "";
  wrap.appendChild(clone);
  wrap.style.display = "block";

  // Lay the copy exactly over the real heading: the negative margin pulls the
  // table back up by the copy's own height, so nothing moves down the page.
  const h = head.getBoundingClientRect().height;
  wrap.style.height = h + "px";
  wrap.style.marginBottom = (-h) + "px";
  wrap.scrollLeft = box.scrollLeft;

  if (!box.dataset.repMirror) {
    box.dataset.repMirror = "1";
    box.addEventListener("scroll", () => { wrap.scrollLeft = box.scrollLeft; });
    // Column widths change with the window, so the copy is remeasured.
    window.addEventListener("resize", () => syncRepHead());
  }

  // The status-bar mask applies only while the heading is actually pinned —
  // the planner's sentinel, fourth use (see view-bookings.js). Wired once,
  // on the wrap, so the repeated syncs don't stack observers; in the
  // browser env() is 0 and nothing changes.
  if (!wrap.dataset.pinWired && "IntersectionObserver" in window) {
    wrap.dataset.pinWired = "1";
    const pin = el(root, "rep-pin-sentinel");
    if (pin) new IntersectionObserver(([e]) =>
      wrap.classList.toggle("hdr-pinned", !e.isIntersecting && e.boundingClientRect.top < 0)
    ).observe(pin);
  }
}

function renderInvoices() {
  paintInvoiceControls();
  paintInvoiceTable();
}

function paintInvoiceControls() {
  const n = invStatusCounts();
  // Brokers named on any booking in the window — the chosen one is kept in
  // the menu even if the window no longer contains it, so the filter never
  // silently changes behind the person's back.
  const brokers = [...new Set(invBase().map(r => (r.b.broker || "").trim()).filter(Boolean))].sort();
  if (invBroker !== "*" && !brokers.includes(invBroker)) brokers.push(invBroker);
  // The dates always apply, so a closed block names them — otherwise a list
  // narrowed to one quarter looks like the whole ledger.
  const rangeLabel = `${formatDate(invFrom)} \u2013 ${formatDate(invTo)}`;
  el(root, "rep-controls").innerHTML = `
    <div class="inv-controls${invFiltersOpen ? "" : " filters-closed"}">
      <input type="text" data-inv="q" placeholder="Search customer, car or invoice no..." value="${esc(invQ)}" autocomplete="off">
      <button type="button" class="btn inv-more-toggle" data-inv-toggle>
        ${invFiltersOpen ? "\u25be" : "\u25b8"} Export invoices${invFiltersOpen ? "" : `<span class="inv-more-scope">${esc(rangeLabel)}</span>`}
      </button>
      <select data-inv="scope">
        <option value="issued"${invScope === "issued" ? " selected" : ""}>Issued invoices (by issue date)</option>
        <option value="all"${invScope === "all" ? " selected" : ""}>All bookings (by start date)</option>
      </select>
      <label>From <input type="date" data-inv="from" value="${esc(invFrom)}"></label>
      <label>To <input type="date" data-inv="to" value="${esc(invTo)}"></label>
      <select data-inv="status">
        ${STATUS_LABELS.map(([v, t]) => `<option value="${v}"${invStatus === v ? " selected" : ""}>${t} (${n[v]})</option>`).join("")}
      </select>
      <select data-inv="broker">
        <option value="*">All brokers</option>
        ${brokers.map(b => `<option value="${esc(b)}"${invBroker === b ? " selected" : ""}>${esc(b)}</option>`).join("")}
      </select>
      ${invScope === "issued" ? `
      <select data-inv="kind">
        <option value=""${invKind === "" ? " selected" : ""}>All invoices</option>
        <option value="vat"${invKind === "vat" ? " selected" : ""}>VAT invoices</option>
        <option value="normal"${invKind === "normal" ? " selected" : ""}>Regular invoices</option>
      </select>` : ""}
      <button class="btn" type="button" data-inv-export>Export this list</button>
    </div>`;
}

// Counts refreshed in place while typing — the menu is not rebuilt, so an
// open dropdown or a focused search box is left exactly as it was.
function paintStatusCounts() {
  const sel = el(root, "rep-controls").querySelector('select[data-inv="status"]');
  if (!sel) return;
  const n = invStatusCounts();
  STATUS_LABELS.forEach(([v, t]) => {
    const o = sel.querySelector(`option[value="${v}"]`);
    if (o) o.textContent = `${t} (${n[v]})`;
  });
}

// The buttons under an open row: everything Billing's card offered, in the
// same order, driven by the same helpers.
function invoiceActionsHtml(b) {
  const cust = customerForBooking(b);
  const hasEmail = !!(b.email || cust?.email);
  const hasPhone = !!(b.phone || cust?.phone);
  const sec = b.securityDeposit || 0;
  const held = (b.securityStatus || "held") === "held";
  return `<div class="card-actions inv-detail-actions">
    ${b.paid
      ? (hasLedger(b)
          ? `<button class="btn btn-small" data-payrec="${b.id}">Payments</button>`
          : `<button class="btn btn-small" data-pay="${b.id}" data-to="0">Mark as unpaid</button>`)
      : `<button class="btn btn-small" data-payrec="${b.id}">Record payment</button>`}
    <button class="btn btn-small" data-dep="${b.id}">Deposits</button>
    <button class="btn btn-small" data-open-booking="${b.id}">View booking</button>
    ${!b.paid && (hasEmail || hasPhone) ? `<button class="btn btn-small" data-remind="${b.id}">${invRemindOpen.has(b.id) ? "\u25be" : "\u25b8"} Reminder</button>` : ""}
    ${sec > 0 && held ? `
      <button class="btn btn-small" data-secstatus="${b.id}" data-to="refunded">Refund deposit</button>
      <button class="btn btn-small" data-secstatus="${b.id}" data-to="kept">Keep deposit</button>` : ""}
  </div>${reminderPanelHtml(b, hasEmail, hasPhone)}`;
}

// The address and the number themselves, not two blind buttons: the desk
// wants to see WHERE the reminder is about to go before sending it — the
// customer's own contact may be out of date, and a reminder to the wrong
// person is worse than none. Clicking either sends the same message Billing
// sends, through the same two helpers.
function reminderPanelHtml(b, hasEmail, hasPhone) {
  if (b.paid || (!hasEmail && !hasPhone)) return "";
  const cust = customerForBooking(b);
  const email = b.email || cust?.email || "";
  const phone = b.phone || cust?.phone || "";
  return `<div class="inv-remind${invRemindOpen.has(b.id) ? " open" : ""}" data-remind-for="${b.id}">
    <span class="inv-remind-lead">Send a payment reminder to:</span>
    ${hasEmail ? `<button class="btn btn-small" data-remind-email="${b.id}">\u2709 ${esc(email)}</button>` : ""}
    ${hasPhone ? `<button class="btn btn-small" data-remind-wa="${b.id}">\u260e ${esc(phone)}</button>` : ""}
  </div>`;
}

// Opened and closed in place — no redraw, so the breakdown above it does not
// move and the table keeps its scroll position.
function toggleReminder(id) {
  if (invRemindOpen.has(id)) invRemindOpen.delete(id); else invRemindOpen.add(id);
  const open = invRemindOpen.has(id);
  const box = el(root, "rep-table");
  const panel = box.querySelector(`.inv-remind[data-remind-for="${id}"]`);
  const btn = box.querySelector(`[data-remind="${id}"]`);
  if (panel) panel.classList.toggle("open", open);
  if (btn) btn.textContent = `${open ? "\u25be" : "\u25b8"} Reminder`;
}

// The breakdown row that sits under an invoice row. Always in the DOM, shown
// by class, so opening one is a class flip rather than a redraw — no flicker,
// no lost scroll position, and the table above it never moves.
function invoiceDetailRow(b, cols) {
  return `<tr class="inv-detail${invOpen.has(b.id) ? " open" : ""}" data-detail-of="${b.id}">
    <td colspan="${cols}"><div class="inv-detail-body">${invoiceDetailsHtml(b)}${invoiceActionsHtml(b)}</div></td>
  </tr>`;
}

function toggleInvoiceRow(id) {
  if (invOpen.has(id)) invOpen.delete(id); else invOpen.add(id);
  const box = el(root, "rep-table");
  const row = box.querySelector(`tr[data-toggle="${id}"]`);
  const det = box.querySelector(`tr[data-detail-of="${id}"]`);
  if (row) row.classList.toggle("open", invOpen.has(id));
  if (det) det.classList.toggle("open", invOpen.has(id));
}

// The row's own compact actions — the two most-used, kept on the row so a
// payment can be recorded without opening anything (yesterday's design).
function rowActionsHtml(b) {
  return `${b.paid
    ? (hasLedger(b)
        ? `<button class="btn btn-small" data-payrec="${b.id}">Payments</button>`
        : `<button class="btn btn-small" data-pay="${b.id}" data-to="0">Unmark</button>`)
    : `<button class="btn btn-small" data-payrec="${b.id}">Record payment</button>`}<button class="btn btn-small" data-dep="${b.id}">Deposits</button>`;
}
function periodHtml(b) {
  return `${esc(formatDate(b.startDate))} – ${esc(formatDate(b.endDate))}`;
}
function statusChip(b) {
  const c = invCategory(b);
  return c === "paid" ? `<span class="pay-chip paid">PAID</span>` : "";
}

// Scroll the row into view and outline it briefly. Runs after the table has
// been written, on a timeout so the browser has laid it out first.
function revealInvoiceRow() {
  if (!revealInvoice) return;
  const id = revealInvoice;
  revealInvoice = null;
  setTimeout(() => {
    const row = el(root, "rep-table").querySelector(`tr[data-toggle="${id}"]`);
    if (!row) return;
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    row.classList.add("row-flash");
    setTimeout(() => row.classList.remove("row-flash"), 1600);
  }, 0);
}

function paintInvoiceTable() {
  const box = el(root, "rep-table");
  const note = el(root, "rep-note");
  const rows = invoiceRows();
  note.textContent = "";
  const exp = el(root, "rep-controls").querySelector("[data-inv-export]");
  if (exp) exp.disabled = !rows.length;

  if (invScope === "all") { renderAllBookings(box, rows); revealInvoiceRow(); return; }

  if (!rows.length) {
    box.innerHTML = `<div class="empty">${invQ || invStatus !== "all" || invBroker !== "*"
      ? "No invoices match these filters. Widen them above to see more."
      : "No invoices issued between these dates. Invoices are issued from a booking — open one and press Invoice."}</div>`;
    return;
  }

  const totals = rows.reduce((a, r) => ({
    total: a.total + r.total,
    excl: a.excl + (r.excl || 0),
    vat: a.vat + (r.vat || 0)
  }), { total: 0, excl: 0, vat: 0 });
  const r2 = x => Math.round(x * 100) / 100;
  const COLS = 12;

  box.innerHTML = `
    <table class="rep-table inv-table">
      <thead>
        <tr>
          ${repCarHead("Invoice", true)}
          <th>Issued</th>
          <th>Period</th>
          <th>Customer</th>
          <th>Vehicle</th>
          <th>Broker</th>
          <th class="rep-num">Excl. VAT</th>
          <th class="rep-num">VAT</th>
          <th class="rep-num rep-strong">Total</th>
          <th class="rep-num">Received</th>
          <th class="rep-num">Balance</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => r.voided ? `
          <tr class="inv-void">
            <th class="rep-car"><span class="inv-chev inv-chev-none"></span><button type="button" class="inv-open" data-print-void="${r.b.id}" data-void-no="${esc(r.no)}">${esc(r.no)}</button>
              <span class="rep-model">${r.isVat ? "VAT invoice" : "Invoice"} · <span class="pay-chip void">VOID</span></span></th>
            <td>${esc(formatDate(r.at))}</td>
            <td>${periodHtml(r.b)}</td>
            <td>${esc(r.b.renter || "")}</td>
            <td>${esc(bookingCarLabel(r.b))}</td>
            <td>${esc(r.b.broker || "\u2014")}</td>
            <td class="rep-num"><span class="rep-zero">\u2014</span></td>
            <td class="rep-num"><span class="rep-zero">\u2014</span></td>
            <td class="rep-num">${esc(money(r.total))}</td>
            <td class="rep-num"><span class="rep-zero">\u2014</span></td>
            <td class="rep-num">voided ${esc(formatDate(r.voidedAt))}</td>
            <td class="inv-actions"></td>
          </tr>` : `
          <tr class="inv-row${invOpen.has(r.b.id) ? " open" : ""}" data-toggle="${r.b.id}" title="Click for the breakdown">
            <th class="rep-car"><span class="inv-chev">\u25B8</span><button type="button" class="inv-open" data-open-invoice="${r.b.id}">${esc(r.no)}</button>
              <span class="rep-model">${r.isVat ? `VAT invoice · ${esc(String(r.pct))}%` : "Invoice"} · ${esc(bookingRef(r.b))}</span></th>
            <td>${esc(formatDate(r.at))}</td>
            <td>${periodHtml(r.b)}</td>
            <td>${esc(r.b.renter || "")}</td>
            <td>${esc(bookingCarLabel(r.b))}</td>
            <td>${esc(r.b.broker || "\u2014")}</td>
            <td class="rep-num">${r.excl !== null ? esc(money(r.excl)) : `<span class="rep-zero">—</span>`}</td>
            <td class="rep-num">${r.vat !== null ? esc(money(r.vat)) : `<span class="rep-zero">—</span>`}</td>
            <td class="rep-num rep-strong">${esc(money(r.total))}</td>
            <td class="rep-num">${r.received > 0 ? esc(money(r.received)) : `<span class="rep-zero">\u2014</span>`}</td>
            <td class="rep-num">${r.b.paid ? statusChip(r.b) : esc(money(balanceFor(r.b)))}</td>
            <td class="inv-actions">${rowActionsHtml(r.b)}</td>
          </tr>${invoiceDetailRow(r.b, COLS)}`).join("")}
      </tbody>
      <tfoot>
        <tr>
          <th class="rep-car">Total · ${rows.length} invoice${rows.length === 1 ? "" : "s"}</th>
          <td></td><td></td><td></td><td></td><td></td>
          <td class="rep-num">${totals.excl ? esc(money(r2(totals.excl))) : "—"}</td>
          <td class="rep-num">${totals.vat ? esc(money(r2(totals.vat))) : "—"}</td>
          <td class="rep-num rep-strong">${esc(money(r2(totals.total)))}</td>
          <td class="rep-num">${esc(money(r2(rows.reduce((a, r) => a + r.received, 0))))}</td>
          <td class="rep-num">${esc(money(r2(rows.reduce((a, r) => a + (r.b.paid ? 0 : balanceFor(r.b)), 0))))}</td>
          <td></td>
        </tr>
      </tfoot>
    </table>`;
  revealInvoiceRow();
}

function renderAllBookings(box, rows) {
  if (!rows.length) {
    box.innerHTML = `<div class="empty">${invQ || invStatus !== "all" || invBroker !== "*"
      ? "No bookings match these filters. Widen them above to see more."
      : "No bookings start between these dates."}</div>`;
    return;
  }
  const r2 = x => Math.round(x * 100) / 100;
  const tot = rows.reduce((a, r) => ({ total: a.total + r.total, rec: a.rec + r.received, bal: a.bal + r.balance }),
    { total: 0, rec: 0, bal: 0 });
  const COLS = 9;
  box.innerHTML = `
    <table class="rep-table inv-table">
      <thead>
        <tr>
          ${repCarHead("Invoice", true)}
          <th>Period</th>
          <th>Customer</th>
          <th>Vehicle</th>
          <th>Broker</th>
          <th class="rep-num rep-strong">Total</th>
          <th class="rep-num">Received</th>
          <th class="rep-num">Balance</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr class="inv-row${invOpen.has(r.b.id) ? " open" : ""}" data-toggle="${r.b.id}" title="Click for the breakdown">
            <th class="rep-car"><span class="inv-chev">\u25B8</span>${r.no
              ? `<button type="button" class="inv-open" data-open-invoice="${r.b.id}">${esc(r.no)}</button>`
              : `<button type="button" class="btn btn-small" data-open-booking="${r.b.id}">Issue invoice</button>`}
              <span class="rep-model">${esc(bookingRef(r.b))}</span></th>
            <td>${periodHtml(r.b)}</td>
            <td>${esc(r.b.renter || "")}</td>
            <td>${esc(bookingCarLabel(r.b))}</td>
            <td>${esc(r.b.broker || "\u2014")}</td>
            <td class="rep-num rep-strong">${esc(money(r.total))}</td>
            <td class="rep-num">${r.received > 0 ? esc(money(r.received)) : `<span class="rep-zero">\u2014</span>`}</td>
            <td class="rep-num">${r.b.paid ? statusChip(r.b) : esc(money(r.balance))}</td>
            <td class="inv-actions">${rowActionsHtml(r.b)}</td>
          </tr>${invoiceDetailRow(r.b, COLS)}`).join("")}
      </tbody>
      <tfoot>
        <tr>
          <th class="rep-car">Total \u00b7 ${rows.length} booking${rows.length === 1 ? "" : "s"}</th>
          <td></td><td></td><td></td><td></td>
          <td class="rep-num rep-strong">${esc(money(r2(tot.total)))}</td>
          <td class="rep-num">${esc(money(r2(tot.rec)))}</td>
          <td class="rep-num">${esc(money(r2(tot.bal)))}</td>
          <td></td>
        </tr>
      </tfoot>
    </table>`;
}

// Refund / keep a security deposit — the same one-field write Billing makes.
async function setSecurityStatus(id, to) {
  if (to !== "refunded" && to !== "kept") return;
  setSync("saving");
  try {
    await updateDoc(doc(db, "bookings", id), { securityStatus: to });
  } catch (err) {
    setSync("error");
    alert("Couldn't update (" + (err.code || err.message) + "). Try again.");
  }
}

// Marking paid from this page writes exactly what Billing writes — the one
// paidPatch both pages share — so the two pages can never tell different
// stories about the same booking.
async function setPaidFromReports(id, to) {
  const b = state.bookings.find(x => x.id === id);
  if (!b) return;
  setSync("saving");
  try {
    const p = paidPatch(b, to);
    await updateDoc(doc(db, "bookings", id), { ...p.patch, paidLog: arrayUnion(p.logEntry) });
  } catch (err) {
    setSync("error");
    alert("Couldn't update (" + (err.code || err.message) + "). Try again.");
  }
}

async function exportInvoicesXlsx() {
  // Exactly the rows on screen — every filter applies, in either scope.
  const rows = invoiceRows();
  if (!rows.length) return;
  const r2 = x => Math.round(x * 100) / 100;
  const co = companyName() || "Company";
  const issued = invScope === "issued";
  const statusOf = r => r.voided ? "Void" : ({ paid: "Paid", unpaid: "Unpaid", upcoming: "Not started" })[invCategory(r.b)];
  const head = issued
    ? ["Invoice no", "Kind", "VAT %", "Issued", "Booking", "Customer", "Vehicle", "From", "To", "Broker",
       "Value excl. VAT", "VAT", "Total", "Received", "Balance", "Status"]
    : ["Invoice no", "Booking", "Customer", "Vehicle", "From", "To", "Broker",
       "Total", "Received", "Balance", "Status"];
  const line = r => issued
    ? [r.no, r.isVat ? "VAT invoice" : "Invoice", r.isVat ? r.pct : "", r.at, bookingRef(r.b),
       r.b.renter || "", bookingCarLabel(r.b), r.b.startDate || "", r.b.endDate || "", r.b.broker || "",
       r.excl ?? "", r.vat ?? "", r.total, r.voided ? "" : r.received, r.voided ? "" : (r.b.paid ? 0 : balanceFor(r.b)), statusOf(r)]
    : [r.no, bookingRef(r.b), r.b.renter || "", bookingCarLabel(r.b), r.b.startDate || "", r.b.endDate || "",
       r.b.broker || "", r.total, r.received, r.balance, statusOf(r)];
  const sum = fn => r2(rows.reduce((a, r) => a + (Number(fn(r)) || 0), 0));
  const totalLine = issued
    ? ["Total", "", "", "", "", "", "", "", "", "",
       sum(r => r.excl), sum(r => r.vat), sum(r => r.total),
       sum(r => r.voided ? 0 : r.received), sum(r => r.voided || r.b.paid ? 0 : balanceFor(r.b)), ""]
    : ["Total", "", "", "", "", "", "", sum(r => r.total), sum(r => r.received), sum(r => r.balance), ""];
  const aoa = [
    [`${co} — ${issued ? "invoices issued" : "bookings starting"} ${invFrom} to ${invTo}`],
    [],
    head,
    ...rows.map(line),
    [],
    totalLine
  ];
  const XLSX = await loadXlsx();
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = head.map(h => ({ wch: h === "Customer" || h === "Vehicle" ? 24 : h.length > 9 ? 15 : 12 }));
  XLSX.utils.book_append_sheet(wb, ws, "Invoices");
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const name = co.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "");
  downloadBlob(`invoices-${name}-${invFrom}-to-${invTo}.xlsx`,
    new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
}

// ---------- Excel ----------
// One workbook, one tab per report, bare numbers — a column of text with "Rs"
// in front of it cannot be summed, and finance will sum it. All three reports
// go in every time, whichever one is on screen: the file is for handing on.
async function exportXlsx() {
  const btn = el(root, "rep-export");
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Preparing...";
  try {
    const rev = revenueByCarMonth(year);
    const exp = expensesByCarMonth(year);
    const mon = monthlySummary(year);
    const co = companyName() || "Company";

    const gridRows = (title, data) => [
      [`${co} — ${title}, ${year}`],
      [],
      ["Plate", "Car", ...MONTHS, "Total", "Average"],
      ...data.rows.map(r => [r.plate, r.label, ...r.months, r.total, r.average]),
      [],
      ["", "All cars", ...data.totals, data.grandTotal, data.average]
    ];

    const monthRows = [
      [`${co} — month by month, ${year}`],
      [`Occupancy based on ${mon.fleet} car${mon.fleet === 1 ? "" : "s"} in the fleet today.`],
      [],
      ["Month", "Occupancy", "Days rented", "Days available", "Income", "Expenses", "Net income"],
      ...mon.months.map(m => [MONTHS[m.month], m.occupancy, m.rentedDays, m.availableDays,
                              m.income, m.expenses, m.net]),
      [],
      ["Total", mon.total.occupancy, "", "", mon.total.income, mon.total.expenses, mon.total.net],
      ["Average", mon.average.occupancy, "", "", mon.average.income, mon.average.expenses, mon.average.net]
    ];

    const XLSX = await loadXlsx();
    const wb = XLSX.utils.book_new();
    const gridCols = [{ wch: 14 }, { wch: 26 }, ...MONTHS.map(() => ({ wch: 11 })), { wch: 13 }, { wch: 12 }];

    const wsRev = XLSX.utils.aoa_to_sheet(gridRows("revenue by car", rev));
    wsRev["!cols"] = gridCols;
    XLSX.utils.book_append_sheet(wb, wsRev, `Revenue ${year}`);

    const wsExp = XLSX.utils.aoa_to_sheet(gridRows("expenses by car", exp));
    wsExp["!cols"] = gridCols;
    XLSX.utils.book_append_sheet(wb, wsExp, `Expenses ${year}`);

    const wsMon = XLSX.utils.aoa_to_sheet(monthRows);
    wsMon["!cols"] = [{ wch: 12 }, { wch: 12 }, { wch: 13 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }];
    // Occupancy is a fraction, so it is formatted as a percentage rather than
    // written as text — the cell stays a number the spreadsheet can work with.
    const pctRows = [...mon.months.map((_, i) => 4 + i), mon.months.length + 6, mon.months.length + 7];
    pctRows.forEach(r => {
      const c = wsMon[XLSX.utils.encode_cell({ r, c: 1 })];
      if (c) c.z = "0%";
    });
    XLSX.utils.book_append_sheet(wb, wsMon, `Month by month ${year}`);

    const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const name = co.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "");
    downloadBlob(`reports-${name}-${year}.xlsx`,
      new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  } catch (e) {
    alert("Couldn't build the spreadsheet (" + (e.message || e) + "). Try again.");
  }
  btn.disabled = false;
  btn.textContent = original;
}
