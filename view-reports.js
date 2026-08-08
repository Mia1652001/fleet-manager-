// Reports view — the grids the pilot's finance office kept by hand.
//
// Three reports on one page, each in its own collapsible block: what each car
// earned, what each car cost, and the two set against each other month by
// month with an occupancy figure beside them.
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

// Bare numbers in the grids, with the currency named once beneath each. "Rs"
// on every one of 168 cells is noise, and it costs the width that lets a month
// column fit on screen — a finance sheet reads as columns of figures, not as
// columns of sentences.
function money(n) {
  return Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
}
function percent(x) {
  return `${(Number(x || 0) * 100).toFixed(0)}%`;
}

// ---------- Collapsible blocks ----------
// The shared panel helper toggles a class on a whole view, which suits one
// panel per page. Here there are three, each folding independently, so each
// block gets its own toggle and its own remembered state. Same button, same
// arrow, same feel as the Summary panels everywhere else.
const sections = [];

function initSection(name, toggleName) {
  const box = el(root, name);
  const btn = el(root, toggleName);
  if (!box || !btn) return () => true;

  const prefKey = `reports:${name}`;
  // Open to begin with: this is the reports page, and a page that opens empty
  // makes someone hunt for what they came to read. Folding is for the reports
  // a given person never looks at.
  let open = loadPref(prefKey, true);
  const chev = btn.querySelector(".rep-head-chev");
  const paint = () => {
    box.classList.toggle("collapsed", !open);
    if (chev) chev.textContent = open ? "▾" : "▸";
  };
  btn.addEventListener("click", () => {
    open = !open;
    savePref(prefKey, open);
    paint();
    render();
  });
  paint();
  const isOpen = () => open;
  sections.push(isOpen);
  return isOpen;
}

// The figure that rides on the heading row. A folded section should still be
// worth its line on the page — the name alone tells you nothing you did not
// already know.
function setHeadline(name, text) {
  const e = el(root, name);
  if (e) e.textContent = text;
}

let revenueOpen = () => true;
let expensesOpen = () => true;
let monthlyOpen = () => true;

export function mount(container) {
  root = container;

  summaryOpen = initPanelToggle(root, "reportsShowSummary", "toggle-summary", "hide-summary", "Summary");

  revenueOpen = initSection("sec-revenue", "tog-revenue");
  expensesOpen = initSection("sec-expenses", "tog-expenses");
  monthlyOpen = initSection("sec-monthly", "tog-monthly");

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

  const rev = revenueByCarMonth(year);
  const exp = expensesByCarMonth(year);
  const mon = monthlySummary(year);

  // Headline figures are set whether the section is open or shut — folded is
  // exactly when they matter.
  setHeadline("sub-revenue", `${formatAmount(rev.grandTotal)} invoiced`);
  setHeadline("sub-expenses", `${formatAmount(exp.grandTotal)} spent`);
  setHeadline("sub-monthly",
    `${formatAmount(mon.total.net)} net · ${percent(mon.total.occupancy)} occupancy`);

  renderSummary(rev, exp, mon);
  if (revenueOpen()) renderCarGrid("rev", rev, "earned");
  if (expensesOpen()) renderCarGrid("exp", exp, "spent");
  if (monthlyOpen()) renderMonthly(mon);
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
function renderCarGrid(prefix, data, verb) {
  const box = el(root, `${prefix}-table`);
  const note = el(root, `${prefix}-note`);
  if (!box) return;

  if (!data.rows.length) {
    box.innerHTML = `<div class="empty">No cars yet — add some on the Fleet page.</div>`;
    if (note) note.textContent = "";
    return;
  }
  if (data.grandTotal === 0) {
    box.innerHTML = `<div class="empty">Nothing ${esc(verb)} in ${esc(year)}. Pick another year above.</div>`;
    if (note) note.textContent = "";
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

  if (!note) return;
  const cur = esc(state.settings?.currency || "Rs");
  note.innerHTML = prefix === "rev"
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
  const box = el(root, "mon-table");
  const note = el(root, "mon-note");
  if (!box) return;

  const anything = mon.months.some(m => m.active);
  if (!anything) {
    box.innerHTML = `<div class="empty">Nothing recorded in ${esc(year)}. Pick another year above.</div>`;
    if (note) note.textContent = "";
    return;
  }

  const num = (v, tone = "") => v !== 0
    ? `<td class="rep-num ${tone}">${esc(money(v))}</td>`
    : `<td class="rep-num rep-zero">—</td>`;

  box.innerHTML = `
    <table class="rep-table rep-months">
      <thead>
        <tr>
          <th class="rep-car">Month</th>
          <th class="rep-num">Occupancy</th>
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
              ? `<td class="rep-num">${esc(percent(m.occupancy))}</td>`
              : `<td class="rep-num rep-zero">—</td>`}
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
          <td class="rep-num">${esc(money(mon.total.income))}</td>
          <td class="rep-num">${esc(money(mon.total.expenses))}</td>
          <td class="rep-num rep-strong ${mon.total.net < 0 ? "rep-neg" : ""}">${esc(money(mon.total.net))}</td>
        </tr>
        <tr>
          <th class="rep-car">Average</th>
          <td class="rep-num">${esc(percent(mon.average.occupancy))}</td>
          <td class="rep-num">${esc(money(mon.average.income))}</td>
          <td class="rep-num">${esc(money(mon.average.expenses))}</td>
          <td class="rep-num rep-strong ${mon.average.net < 0 ? "rep-neg" : ""}">${esc(money(mon.average.net))}</td>
        </tr>
      </tfoot>
    </table>`;

  if (!note) return;
  note.innerHTML =
    `All amounts in ${esc(state.settings?.currency || "Rs")}. Income is what was invoiced that
     month — the same figure as the revenue grid above and as Booked on Billing. Expenses come
     from the Expenses page. Net is one minus the other.
     Occupancy is days rented divided by days available, where available is
     ${mon.fleet} car${mon.fleet === 1 ? "" : "s"} times the days in the month; a rental
     spanning two months contributes its days to both, unlike the money, which belongs to the
     month it started in. Note it uses today's fleet size for every month, because that is the
     only fleet the app can know — through a big change in fleet size it drifts.
     Average is across the months that had activity, not across twelve.`;
}

// ---------- Excel ----------
// One workbook, one tab per report, bare numbers. A column of text with "Rs"
// in front of it cannot be summed, and finance will sum it.
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
      ["Month", "Occupancy", "Income", "Expenses", "Net income"],
      ...mon.months.map(m => [MONTHS[m.month], m.occupancy, m.income, m.expenses, m.net]),
      [],
      ["Total", mon.total.occupancy, mon.total.income, mon.total.expenses, mon.total.net],
      ["Average", mon.average.occupancy, mon.average.income, mon.average.expenses, mon.average.net]
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
    wsMon["!cols"] = [{ wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 14 }];
    // Occupancy is a fraction, so it is formatted as a percentage rather than
    // written as text — the cell stays a number the spreadsheet can work with.
    mon.months.forEach((m, i) => {
      const c = wsMon[XLSX.utils.encode_cell({ r: 4 + i, c: 1 })];
      if (c) c.z = "0%";
    });
    [mon.months.length + 6, mon.months.length + 7].forEach(r => {
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
