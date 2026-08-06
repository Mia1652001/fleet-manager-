// Reports view — revenue by car and month.
//
// Built for the pilot's finance office, who kept this grid by hand in a
// spreadsheet: one row per vehicle, one column per month, the invoice value of
// what that vehicle earned, then a total and an average down the right.
//
// Everything here is derived from bookings already in memory, so the report
// costs no extra database reads and can never disagree with Billing — both add
// up the same invoices, filed by the day the rental starts.

import {
  state, onDataChange, esc, formatAmount, todayStr,
  revenueByCarMonth, bookingYears, companyName,
  initPanelToggle, el
} from "./store.js";
import { loadXlsx, downloadBlob } from "./backup.js";

let root = null;
let summaryOpen = () => true;
let year = "";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Bare numbers in the grid, with the currency named once above it. "Rs" on
// every one of 168 cells is noise, and it costs the width that lets a month
// column fit on screen — a finance sheet reads as columns of figures, not as
// columns of sentences.
function money(n) {
  return Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export function mount(container) {
  root = container;

  summaryOpen = initPanelToggle(root, "reportsShowSummary", "toggle-summary", "hide-summary", "Summary");

  el(root, "rep-year").addEventListener("change", () => {
    year = el(root, "rep-year").value;
    render();
  });

  el(root, "rep-export").addEventListener("click", exportXlsx);

  onDataChange(() => { if (root.classList.contains("active")) render(); });
}

// The year list is rebuilt on every draw because a booking saved for next year
// has to appear in it without a reload. The current choice is kept if it still
// exists, so a redraw never silently moves the report to another year.
function refreshYearOptions() {
  const sel = el(root, "rep-year");
  const years = bookingYears();
  if (!years.includes(year)) year = years.includes(todayStr().slice(0, 4)) ? todayStr().slice(0, 4) : years[0];
  sel.innerHTML = years.map(y => `<option value="${esc(y)}">${esc(y)}</option>`).join("");
  sel.value = year;
}

function clearNote() {
  const note = el(root, "rep-note");
  if (note) note.textContent = "";
}

export function render() {
  if (!root) return;
  refreshYearOptions();

  const data = revenueByCarMonth(year);

  if (summaryOpen()) {
    const earning = data.rows.filter(r => r.total > 0).length;
    const best = data.rows.slice().sort((a, b) => b.total - a.total)[0];
    el(root, "stats").innerHTML = `
      <div class="stat"><div class="stat-label">Invoiced<span class="stat-scope">${esc(year)}</span></div>
        <div class="stat-val">${formatAmount(data.grandTotal)}</div></div>
      <div class="stat"><div class="stat-label">Average per month<span class="stat-scope">months with rentals</span></div>
        <div class="stat-val green">${formatAmount(data.average)}</div></div>
      <div class="stat"><div class="stat-label">Cars that earned<span class="stat-scope">${esc(year)}</span></div>
        <div class="stat-val">${earning}</div></div>
      <div class="stat"><div class="stat-label">Best earner<span class="stat-scope">${best && best.total > 0 ? esc(best.plate || best.label) : "—"}</span></div>
        <div class="stat-val blue">${formatAmount(best ? best.total : 0)}</div></div>
    `;
  }

  const box = el(root, "rep-table");
  if (!data.rows.length) {
    box.innerHTML = `<div class="empty">No cars yet — add some on the Fleet page.</div>`;
    clearNote();
    return;
  }
  if (data.grandTotal === 0) {
    box.innerHTML = `<div class="empty">No bookings started in ${esc(year)}. Pick another year above.</div>`;
    clearNote();
    return;
  }

  // A zero prints as a dash. A grid of "Rs 0" is unreadable, and the eye needs
  // to find the months that earned, not the months that did not.
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
              <span class="rep-plate">${esc(r.plate || "no plate")}</span>
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

  // Outside the scrolling box, or the explanation slides away sideways with
  // the months and is never read.
  const note = el(root, "rep-note");
  if (note) {
    note.innerHTML =
      `All amounts in ${esc(state.settings?.currency || "Rs")}. Invoiced value — rental plus
       delivery, insurance and other charges, whether settled or not. Bank charges on card
       payments are excluded: the company collects those for the bank. A rental is counted in
       the month it starts, the same way invoices are filed everywhere else in the app, so the
       total here matches Booked on the Billing page for the same year. Average is per month
       that earned, not per calendar month — a car bought in October is not judged on twelve.`;
  }
}

// The same grid as a spreadsheet, because finance works in one. Bare numbers,
// no currency symbol: a column of text with "Rs" in front cannot be summed.
async function exportXlsx() {
  const btn = el(root, "rep-export");
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Preparing...";
  try {
    const data = revenueByCarMonth(year);
    const rows = [
      [`${companyName()} — revenue by car, ${data.year}`],
      [`Invoiced value (rental + extras), counted in the month each rental starts. Bank charges excluded.`],
      [],
      ["Plate", "Car", ...MONTHS, "Total", "Average"],
      ...data.rows.map(r => [r.plate, r.label, ...r.months, r.total, r.average]),
      [],
      ["", "All cars", ...data.totals, data.grandTotal, data.average]
    ];
    const XLSX = await loadXlsx();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 14 }, { wch: 26 }, ...MONTHS.map(() => ({ wch: 11 })), { wch: 13 }, { wch: 12 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, `Revenue ${data.year}`);
    const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const name = (companyName() || "company").replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "");
    downloadBlob(`revenue-by-car-${name}-${data.year}.xlsx`,
      new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  } catch (e) {
    alert("Couldn't build the spreadsheet (" + (e.message || e) + "). Try again.");
  }
  btn.disabled = false;
  btn.textContent = original;
}
