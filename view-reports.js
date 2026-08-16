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
  amountDue, vatSplit, balanceFor, paidPatch, paidTotal, hasLedger, hasStarted,
  loadPref, savePref, el
} from "./store.js";
import { loadXlsx, downloadBlob } from "./backup.js";
import { openInvoice } from "./agreement.js";
import { openPayModal, openDepositModal } from "./view-billing.js";
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
  return state.bookings
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
      && (everything || !invKind || (invKind === "vat") === r.isVat))
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
    if (inp.dataset.inv === "from") invFrom = inp.value;
    else if (inp.dataset.inv === "to") invTo = inp.value;
    else if (inp.dataset.inv === "scope") invScope = inp.value;
    else invKind = inp.value;
    render();
  });
  el(root, "rep-controls").addEventListener("click", (e) => {
    if (e.target.closest("[data-inv-export]")) exportInvoicesXlsx();
  });
  el(root, "rep-table").addEventListener("click", (e) => {
    // The number itself opens the document — a real click, so no pop-up
    // blocker has anything to say about it.
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
    if (pay) setPaidFromReports(pay.dataset.pay, pay.dataset.to === "1");
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

export function render() {
  if (!root) return;
  refreshYearOptions();
  paintTabs();

  const rev = revenueByCarMonth(year);
  const exp = expensesByCarMonth(year);
  const mon = monthlySummary(year);

  if (current === "invoices") {
    if (!invFrom) invFrom = quarterStart(todayStr());
    if (!invTo) invTo = todayStr();
  } else {
    const slot = el(root, "rep-controls");
    if (slot) slot.innerHTML = "";
  }

  if (current === "revenue") renderCarGrid(rev, "earned", "revenue");
  else if (current === "expenses") renderCarGrid(exp, "spent", "expenses");
  else if (current === "invoices") renderInvoices();
  else renderMonthly(mon);
}


// ---------- The two car grids ----------
// One function for both: a report that totalled its rows differently from its
// sibling would be a bug waiting to be argued about in a meeting.
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
    <table class="rep-table">
      <thead>
        <tr>
          <th class="rep-car">Car</th>
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
          <th class="rep-car">Month</th>
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

function renderInvoices() {
  const box = el(root, "rep-table");
  const note = el(root, "rep-note");
  const rows = invScope === "all" ? allBookingRows() : issuedInvoices();

  const controls = `
    <div class="inv-controls">
      <select data-inv="scope">
        <option value="issued"${invScope === "issued" ? " selected" : ""}>Issued invoices (by issue date)</option>
        <option value="all"${invScope === "all" ? " selected" : ""}>All bookings (by start date)</option>
      </select>
      <label>From <input type="date" data-inv="from" value="${esc(invFrom)}"></label>
      <label>To <input type="date" data-inv="to" value="${esc(invTo)}"></label>
      ${invScope === "issued" ? `
      <select data-inv="kind">
        <option value=""${invKind === "" ? " selected" : ""}>All invoices</option>
        <option value="vat"${invKind === "vat" ? " selected" : ""}>VAT invoices</option>
        <option value="normal"${invKind === "normal" ? " selected" : ""}>Regular invoices</option>
      </select>
      <button class="btn" type="button" data-inv-export ${rows.length ? "" : "disabled"}>Export this list</button>` : ""}
    </div>`;
  el(root, "rep-controls").innerHTML = controls;

  if (invScope === "all") { renderAllBookings(box, note, controls, rows); return; }

  if (!rows.length) {
    box.innerHTML = `<div class="empty">No invoices issued between these dates.
      Invoices are issued from a booking — open one and press Invoice.</div>`;
    note.textContent = "";
    return;
  }

  const totals = rows.reduce((a, r) => ({
    total: a.total + r.total,
    excl: a.excl + (r.excl || 0),
    vat: a.vat + (r.vat || 0)
  }), { total: 0, excl: 0, vat: 0 });
  const r2 = x => Math.round(x * 100) / 100;

  box.innerHTML = `
    <table class="rep-table">
      <thead>
        <tr>
          <th class="rep-car">Invoice</th>
          <th>Issued</th>
          <th>Customer</th>
          <th>Vehicle</th>
          <th class="rep-num">Excl. VAT</th>
          <th class="rep-num">VAT</th>
          <th class="rep-num rep-strong">Total</th>
          <th class="rep-num">Received</th>
          <th class="rep-num">Balance</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <th class="rep-car"><button type="button" class="inv-open" data-open-invoice="${r.b.id}">${esc(r.no)}</button>
              <span class="rep-model">${r.isVat ? `VAT invoice · ${esc(String(r.pct))}%` : "Invoice"}</span></th>
            <td>${esc(formatDate(r.at))}</td>
            <td>${esc(r.b.renter || "")}</td>
            <td>${esc(bookingCarLabel(r.b))}</td>
            <td class="rep-num">${r.excl !== null ? esc(money(r.excl)) : `<span class="rep-zero">—</span>`}</td>
            <td class="rep-num">${r.vat !== null ? esc(money(r.vat)) : `<span class="rep-zero">—</span>`}</td>
            <td class="rep-num rep-strong">${esc(money(r.total))}</td>
            <td class="rep-num">${r.received > 0 ? esc(money(r.received)) : `<span class="rep-zero">\u2014</span>`}</td>
            <td class="rep-num">${r.b.paid ? `<span class="pay-chip paid">PAID</span>` : esc(money(balanceFor(r.b)))}</td>
            <td class="inv-actions">${r.b.paid
              ? (hasLedger(r.b)
                  ? `<button class="btn btn-small" data-payrec="${r.b.id}">Payments</button>`
                  : `<button class="btn btn-small" data-pay="${r.b.id}" data-to="0">Unmark</button>`)
              : `<button class="btn btn-small" data-payrec="${r.b.id}">Record payment</button>`}<button class="btn btn-small" data-dep="${r.b.id}">Deposits</button></td>
          </tr>`).join("")}
      </tbody>
      <tfoot>
        <tr>
          <th class="rep-car">Total · ${rows.length} invoice${rows.length === 1 ? "" : "s"}</th>
          <td></td><td></td><td></td>
          <td class="rep-num">${totals.excl ? esc(money(r2(totals.excl))) : "—"}</td>
          <td class="rep-num">${totals.vat ? esc(money(r2(totals.vat))) : "—"}</td>
          <td class="rep-num rep-strong">${esc(money(r2(totals.total)))}</td>
          <td class="rep-num">${esc(money(r2(rows.reduce((a, r) => a + r.received, 0))))}</td>
          <td class="rep-num">${esc(money(r2(rows.reduce((a, r) => a + (r.b.paid ? 0 : balanceFor(r.b)), 0))))}</td>
          <td></td>
        </tr>
      </tfoot>
    </table>`;

  note.textContent = "";
}

function renderAllBookings(box, note, controls, rows) {
  note.textContent = "";
  if (!rows.length) {
    box.innerHTML = `<div class="empty">No bookings start between these dates.</div>`;
    return;
  }
  const r2 = x => Math.round(x * 100) / 100;
  const tot = rows.reduce((a, r) => ({ total: a.total + r.total, rec: a.rec + r.received, bal: a.bal + r.balance }),
    { total: 0, rec: 0, bal: 0 });
  box.innerHTML = `
    <table class="rep-table">
      <thead>
        <tr>
          <th class="rep-car">Invoice</th>
          <th>Starts</th>
          <th>Customer</th>
          <th>Vehicle</th>
          <th class="rep-num rep-strong">Total</th>
          <th class="rep-num">Received</th>
          <th class="rep-num">Balance</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <th class="rep-car">${r.no
              ? `<button type="button" class="inv-open" data-open-invoice="${r.b.id}">${esc(r.no)}</button>`
              : `<button type="button" class="btn btn-small" data-open-booking="${r.b.id}">Issue invoice</button>`}
              <span class="rep-model">${esc(bookingRef(r.b))}</span></th>
            <td>${esc(formatDate(r.start))}</td>
            <td>${esc(r.b.renter || "")}</td>
            <td>${esc(bookingCarLabel(r.b))}</td>
            <td class="rep-num rep-strong">${esc(money(r.total))}</td>
            <td class="rep-num">${r.received > 0 ? esc(money(r.received)) : `<span class="rep-zero">\u2014</span>`}</td>
            <td class="rep-num">${r.b.paid ? `<span class="pay-chip paid">PAID</span>` : esc(money(r.balance))}</td>
            <td class="inv-actions">${r.b.paid
              ? (hasLedger(r.b)
                  ? `<button class="btn btn-small" data-payrec="${r.b.id}">Payments</button>`
                  : `<button class="btn btn-small" data-pay="${r.b.id}" data-to="0">Unmark</button>`)
              : `<button class="btn btn-small" data-payrec="${r.b.id}">Record payment</button>`}<button class="btn btn-small" data-dep="${r.b.id}">Deposits</button></td>
          </tr>`).join("")}
      </tbody>
      <tfoot>
        <tr>
          <th class="rep-car">Total \u00b7 ${rows.length} booking${rows.length === 1 ? "" : "s"}</th>
          <td></td><td></td><td></td>
          <td class="rep-num rep-strong">${esc(money(r2(tot.total)))}</td>
          <td class="rep-num">${esc(money(r2(tot.rec)))}</td>
          <td class="rep-num">${esc(money(r2(tot.bal)))}</td>
          <td></td>
        </tr>
      </tfoot>
    </table>`;
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
  const rows = issuedInvoices();
  if (!rows.length) return;
  const r2 = x => Math.round(x * 100) / 100;
  const co = companyName() || "Company";
  const aoa = [
    [`${co} — invoices issued ${invFrom} to ${invTo}`],
    [],
    ["Invoice no", "Kind", "VAT %", "Issued", "Booking", "Customer", "Vehicle",
     "Value excl. VAT", "VAT", "Total"],
    ...rows.map(r => [r.no, r.isVat ? "VAT invoice" : "Invoice", r.isVat ? r.pct : "",
      r.at, bookingRef(r.b), r.b.renter || "", bookingCarLabel(r.b),
      r.excl ?? "", r.vat ?? "", r.total]),
    [],
    ["Total", "", "", "", "", "", "",
      r2(rows.reduce((a, r) => a + (r.excl || 0), 0)),
      r2(rows.reduce((a, r) => a + (r.vat || 0), 0)),
      r2(rows.reduce((a, r) => a + r.total, 0))]
  ];
  const XLSX = await loadXlsx();
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [{ wch: 20 }, { wch: 12 }, { wch: 7 }, { wch: 12 }, { wch: 12 },
                 { wch: 22 }, { wch: 26 }, { wch: 15 }, { wch: 12 }, { wch: 13 }];
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
