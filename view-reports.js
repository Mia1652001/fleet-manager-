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
  state, onDataChange, esc, formatAmount, todayStr,
  revenueByCarMonth, expensesByCarMonth, monthlySummary,
  bookingYears, companyName,
  initPanelToggle, loadPref, savePref, el
} from "./store.js";
import { loadXlsx, downloadBlob } from "./backup.js";

let root = null;
let summaryOpen = () => true;
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
const REPORTS = ["revenue", "expenses", "monthly"];
let current = "revenue";

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

  summaryOpen = initPanelToggle(root, "reportsShowSummary", "toggle-summary", "hide-summary", "Summary");
  wireTabs();

  el(root, "rep-year").addEventListener("change", () => {
    year = el(root, "rep-year").value;
    render();
  });

  el(root, "rep-export").addEventListener("click", exportXlsx);

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

  renderSummary(rev, exp, mon);

  // The headline for whichever report is showing, stated once above the table
  // rather than left to be hunted for in a corner of it.
  const headline = el(root, "rep-headline");
  if (headline) {
    headline.textContent =
      current === "revenue" ? `${formatAmount(rev.grandTotal)} invoiced in ${year}` :
      current === "expenses" ? `${formatAmount(exp.grandTotal)} spent in ${year}` :
      `${formatAmount(mon.total.net)} net in ${year} · ${percent(mon.total.occupancy)} occupancy`;
  }

  if (current === "revenue") renderCarGrid(rev, "earned", "revenue");
  else if (current === "expenses") renderCarGrid(exp, "spent", "expenses");
  else renderMonthly(mon);
}

function renderSummary(rev, exp, mon) {
  if (!summaryOpen()) return;
  const net = rev.grandTotal - exp.grandTotal;
  el(root, "stats").innerHTML = `
    <div class="stat"><div class="stat-label">Invoiced<span class="stat-scope">${esc(year)}</span></div>
      <div class="stat-val">${formatAmount(rev.grandTotal)}</div></div>
    <div class="stat"><div class="stat-label">Expenses<span class="stat-scope">${esc(year)}</span></div>
      <div class="stat-val amber">${formatAmount(exp.grandTotal)}</div></div>
    <div class="stat"><div class="stat-label">Net<span class="stat-scope">${esc(year)}</span></div>
      <div class="stat-val ${net < 0 ? "red" : "green"}">${formatAmount(net)}</div></div>
    <div class="stat"><div class="stat-label">Occupancy<span class="stat-scope">${esc(year)} · ${mon.fleet} car${mon.fleet === 1 ? "" : "s"}</span></div>
      <div class="stat-val blue">${percent(mon.total.occupancy)}</div></div>
  `;
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

  const cur = esc(state.settings?.currency || "Rs");
  note.innerHTML = which === "revenue"
    ? `All amounts in ${cur}. Invoiced value — rental plus delivery, insurance and other
       charges, whether settled or not. Bank charges on card payments are excluded: the company
       collects those for the bank. A rental counts in the month it starts, the same way
       invoices are filed everywhere else, so the total here matches Booked on Billing for the
       same year. Average is per month that earned, not per calendar month.`
    : `All amounts in ${cur}. Everything recorded on the Expenses page, by the date and car on
       each entry. Spending with no car against it — office costs, a bulk purchase — sits in
       its own row, so this total always matches the Expenses page. Average is per month that
       had spending.`;
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

  note.innerHTML =
    `All amounts in ${esc(state.settings?.currency || "Rs")}. Income is what was invoiced that
     month — the same figure as Revenue by car and as Booked on Billing. Expenses come from the
     Expenses page. Net is one minus the other.
     Occupancy is days rented divided by days available, where available is
     ${mon.fleet} car${mon.fleet === 1 ? "" : "s"} times the days in the month; a rental
     spanning two months contributes its days to both, unlike the money, which belongs to the
     month it started in. It uses today's fleet size for every month, because that is the only
     fleet the app can know — through a big change in fleet size it drifts.
     Total and Average both cover the months that had activity, not all twelve.`;
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
