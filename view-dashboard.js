// Dashboard — the morning overview. Everything here is derived from data the
// other views already load, so it costs no extra database reads, and every
// figure links through to the screen where you would act on it.
import { setFleetFocus } from "./view-fleet.js";
import { openBookingModal } from "./booking-form.js";
import {
  state, onDataChange, esc, formatDate, formatAmount, todayStr,
  orderedCars, carStatus, currentBooking, serviceDue,
  bookingState, bookingCarLabel, buildSchedule,
  startTime, endTime, rentalTotal, balanceFor, hasStarted,
  inPeriod, PERIOD_DAYS,
  moneySummary, monthOf, thisMonth, shiftMonth, monthLabel,
  sharesStartHandover, sharesEndHandover,
  el,
  requestFocus,
  carDocsDue,
  CAR_DOC_FIELDS, MONTH_NAMES
, monthlySummary } from "./store.js";

let root = null;

// Which month the Money card is reporting. Starts on the current one every
// time the app opens: a figure left on some month three back would be read as
// today's position by whoever glanced at it next.
let moneyMonth = thisMonth();

export function mount(container) {
  root = container;

  // Everything on the dashboard is a shortcut to the page that owns it.
  // The mini planner that used to live here is gone (pilot request, Aug
  // 2026): the real planner is one tap away and this one repeated it worse.
  root.addEventListener("click", (e) => {
    const go = e.target.closest("[data-goto]");
    if (!go) return;
    // A named car wins over any filter: Fleet is asked to reveal that one
    // card, and whatever focus a previous jump left behind is cleared, or the
    // filter could hide the very car being opened.
    if (go.dataset.car) {
      setFleetFocus(null);
      requestFocus("fleet", go.dataset.car);
      location.hash = "#" + go.dataset.goto;
      return;
    }
    if (go.dataset.focus) setFleetFocus(go.dataset.focus);
    location.hash = "#" + go.dataset.goto;
  });

  // Prev / this month / next for the Money card. Guarded the same way the
  // booking form guards its newer buttons: if the browser is still holding an
  // older copy of the page these three do not exist yet, and reaching for them
  // unguarded would throw during startup and take the whole app down rather
  // than just this one control.
  const mNav = [
    ["money-prev", () => { moneyMonth = shiftMonth(moneyMonth, -1); }],
    ["money-next", () => { moneyMonth = shiftMonth(moneyMonth, 1); }],
    ["money-this", () => { moneyMonth = thisMonth(); }]
  ];
  mNav.forEach(([name, step]) => {
    const btn = el(root, name);
    if (btn) btn.addEventListener("click", () => { step(); render(); });
  });


  onDataChange(() => { if (root.classList.contains("active")) render(); });
}


// ---------- The three charts the pilot picked (24 Aug) ----------
// Hand-rolled SVG: no libraries to load, nothing to break offline, prints
// like everything else. All three read monthlySummary, the same helper the
// Month-by-month report uses — one source, so chart and report always agree.
const M_LETTERS = ["J","F","M","A","M","J","J","A","S","O","N","D"];

function chartRevenueBars(months) {
  const vals = months.map(m => m.income);
  const max = Math.max(...vals, 1);
  const W = 300, H = 120, base = 100, bw = 18, gap = 6.5;
  const bars = vals.map((v, i) => {
    const h = Math.round((v / max) * 82);
    const x = 4 + i * (bw + gap);
    return `<g><title>${M_LETTERS[i]}: ${formatAmount(v)}</title>
      <rect x="${x}" y="${base - h}" width="${bw}" height="${Math.max(h, v > 0 ? 2 : 0)}" rx="2" fill="var(--accent)" opacity="0.85"/>
      <text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle" class="ch-lbl">${M_LETTERS[i]}</text></g>`;
  }).join("");
  return `<div class="chart"><h4>Revenue per month</h4>
    <svg viewBox="0 0 ${W} ${H}" role="img">${bars}</svg></div>`;
}

function chartOccupancy(months, fleetSize) {
  const now = new Date();
  const mi = now.getMonth();
  const daysInMonth = new Date(now.getFullYear(), mi + 1, 0).getDate();
  const capacity = fleetSize * daysInMonth;
  const pct = capacity ? Math.round((months[mi].rentedDays / capacity) * 100) : 0;
  const shown = Math.min(pct, 100);
  return `<div class="chart"><h4>Occupancy this month</h4>
    <div class="occ-num">${pct}%</div>
    <div class="occ-track"><div class="occ-fill" style="width:${shown}%"></div></div>
    <div class="ch-note">${months[mi].rentedDays} rented day${months[mi].rentedDays === 1 ? "" : "s"} of ${capacity} (${fleetSize} car${fleetSize === 1 ? "" : "s"} \u00d7 ${daysInMonth} days)</div>
  </div>`;
}

function chartIncomeExpenses(months) {
  const inc = months.map(m => m.income), exp = months.map(m => m.expenses);
  const max = Math.max(...inc, ...exp, 1);
  const W = 300, H = 120, base = 100;
  const pt = (v, i) => `${8 + i * 25.8},${base - Math.round((v / max) * 82)}`;
  const line = (vals, cls) => `<polyline points="${vals.map(pt).join(" ")}" class="${cls}" fill="none"/>`;
  const dots = (vals, cls) => vals.map((v, i) =>
    `<circle cx="${pt(v, i).split(",")[0]}" cy="${pt(v, i).split(",")[1]}" r="2.4" class="${cls}"><title>${M_LETTERS[i]}: ${formatAmount(v)}</title></circle>`).join("");
  const lbls = M_LETTERS.map((l, i) => `<text x="${8 + i * 25.8}" y="${H - 6}" text-anchor="middle" class="ch-lbl">${l}</text>`).join("");
  return `<div class="chart"><h4>Income vs expenses</h4>
    <svg viewBox="0 0 ${W} ${H}" role="img">
      ${line(inc, "ch-line-inc")}${dots(inc, "ch-dot-inc")}
      ${line(exp, "ch-line-exp")}${dots(exp, "ch-dot-exp")}${lbls}
    </svg>
    <div class="ch-note"><span class="ch-key ch-key-inc"></span> income \u2003 <span class="ch-key ch-key-exp"></span> expenses</div>
  </div>`;
}

function renderCharts() {
  const box = el(root, "dash-charts");
  if (!box) return;
  const y = new Date().getFullYear();
  const yr = el(root, "charts-year");
  if (yr) yr.textContent = String(y);
  const months = monthlySummary(y).months;
  box.innerHTML =
    chartRevenueBars(months) +
    chartOccupancy(months, state.cars.length) +
    chartIncomeExpenses(months);
}

function figure(label, value, tone, goto, sub) {
  // The sub-line states each figure's population — the three counted
  // DIFFERENT sets of bookings by design, and three bare numbers side by
  // side invited the arithmetic that "didn't add up" (pilot, 23 Aug).
  return `<button class="dash-figure" data-goto="${goto}">
    <span class="dash-figure-val ${tone || ""}">${value}</span>
    <span class="dash-figure-label">${esc(label)}</span>
    ${sub ? `<span class="dash-figure-sub">${esc(sub)}</span>` : ""}
  </button>`;
}

export function render() {
  if (!root) return;
  renderCharts();
  const t = todayStr();

  renderAlerts(t);
  renderTodayJobs();
  renderMoney();
  renderFleetFigures();
  renderBookingFigures();
  renderServiceFigures();
  renderCustomerFigures();
  renderDocMonths(t);
  renderExpenseMonths();
  renderUnpaid();
}

// ---------- Documents expiring, by month ----------
// Arshad, 7 Aug: "license coming to expiry for the current month and next
// months." The app already warned at 30 days, which is a rolling window —
// it cannot be tied to a month, compared with last month, or looked at ahead.
// The same objection his accountant made about the money figures, and the
// same answer: whole calendar months, each one named.
//
// Six months: this one and five ahead. Far enough to plan a renewal queue,
// short enough that the card does not become a list nobody reads. Anything
// already expired leads, because that is today's problem, not next quarter's.
const DOC_MONTHS_AHEAD = 5;
const DOCS_PER_MONTH = 4;

function docsByMonth(t) {
  const first = t.slice(0, 7);
  const window = [first];
  for (let i = 1; i <= DOC_MONTHS_AHEAD; i++) window.push(shiftMonth(first, i));
  const buckets = new Map(window.map(m => [m, []]));
  const expired = [];

  orderedCars().forEach(car => {
    CAR_DOC_FIELDS.forEach(f => {
      const date = car[f.key];
      if (!date || String(date).length < 10) return;
      const item = { car, label: f.label, date };
      if (date < t) { expired.push(item); return; }
      const key = String(date).slice(0, 7);
      if (buckets.has(key)) buckets.get(key).push(item);
    });
  });

  expired.sort((a, b) => a.date.localeCompare(b.date));
  buckets.forEach(list => list.sort((a, b) => a.date.localeCompare(b.date)));
  return { expired, window, buckets };
}

function docRow(x, tone) {
  // No data-focus here. This card looks six months ahead; the Fleet "docs"
  // filter only keeps cars due within 30 days, so a row for a document due in
  // December landed on "Showing 0 cars" (pilot, 25 Aug 18:34). The row opens
  // its own car instead, which is what clicking a car should do anyway.
  return `<div class="dash-job" data-goto="fleet" data-car="${esc(x.car.id)}">
    <span class="dash-job-main">${esc(x.car.plate || bookingCarLabelish(x.car))}
      <span class="dash-dim">${esc(x.label)}</span></span>
    <span class="dash-doc-date${tone ? " " + tone : ""}">${esc(formatDate(x.date))}</span>
  </div>`;
}
// A car's own short name, without needing a booking to hang it on.
function bookingCarLabelish(car) {
  return [car.make, car.model].filter(Boolean).join(" ") || "Car";
}

function renderDocMonths(t) {
  const box = el(root, "docs-months");
  if (!box) return;                       // older cached page: skip, never throw
  const { expired, window, buckets } = docsByMonth(t);
  const total = expired.length + window.reduce((n, m) => n + buckets.get(m).length, 0);

  if (!total) {
    box.innerHTML = `<div class="dash-empty">Nothing expiring in the next ${DOC_MONTHS_AHEAD + 1} months.</div>`;
    return;
  }

  const block = (title, items, tone) => {
    if (!items.length) return "";
    const shown = items.slice(0, DOCS_PER_MONTH);
    return `<div class="dash-month">
      <div class="dash-month-head${tone ? " " + tone : ""}">
        <span>${esc(title)}</span><span class="dash-month-n">${items.length}</span>
      </div>
      ${shown.map(x => docRow(x, tone)).join("")}
      ${items.length > shown.length
        ? `<button class="dash-more" data-goto="fleet">+ ${items.length - shown.length} more \u2192</button>`
        : ""}
    </div>`;
  };

  // Months with nothing due are dropped rather than printed empty: six empty
  // headings would bury the two months that actually need work.
  box.innerHTML = block("Already expired", expired, "dash-red")
    + window.map((m, i) => block(monthLabel(m) + (i === 0 ? " \u00b7 this month" : ""),
        buckets.get(m), i === 0 ? "dash-amber" : "")).join("");
}

// ---------- Monthly expenses: past, current and coming ----------
// His words: "Monthly expenses for the month + past months + next months."
// All three at once, so a strip rather than a stepper — the Money card above
// already steps one month at a time, and the question here is the shape of
// the year, not one month's figure. Reads state.expenses directly rather than
// monthlySummary because the window crosses a year boundary and that helper
// answers for one year only.
const EXP_MONTHS_BACK = 5;
const EXP_MONTHS_AHEAD = 3;

function expensesByMonthWindow() {
  const now = thisMonth();
  const keys = [];
  for (let i = -EXP_MONTHS_BACK; i <= EXP_MONTHS_AHEAD; i++) keys.push(shiftMonth(now, i));
  const totals = new Map(keys.map(k => [k, 0]));
  (state.expenses || []).forEach(x => {
    const k = String(x.date || "").slice(0, 7);
    if (!totals.has(k)) return;
    totals.set(k, totals.get(k) + Math.max(0, Number(x.amount) || 0));
  });
  return { keys, totals, now };
}

function renderExpenseMonths() {
  const box = el(root, "expense-months");
  if (!box) return;
  const { keys, totals, now } = expensesByMonthWindow();
  const spent = keys.reduce((n, k) => n + totals.get(k), 0);
  if (!spent) {
    box.innerHTML = `<div class="dash-empty">Nothing recorded in these months.</div>`;
    return;
  }
  // The tallest month sets the bar scale, so the shape is readable whatever
  // the amounts happen to be.
  // Bar heights in pixels, not percentages: a percentage needs a parent with a
  // definite height, and one stylesheet change to the column would silently
  // flatten every bar to nothing.
  const peak = Math.max(...keys.map(k => totals.get(k)));
  const BAR_MAX = 48;
  const barPx = v => (peak > 0 && v > 0) ? Math.max(2, Math.round((v / peak) * BAR_MAX)) : 0;
  box.innerHTML = `<div class="dash-mstrip">
    ${keys.map(k => {
      const v = totals.get(k);
      const isNow = k === now;
      const ahead = k > now;
      return `<div class="dash-mcol${isNow ? " now" : ""}${ahead ? " ahead" : ""}" data-goto="expenses"
          title="${esc(monthLabel(k))}: ${esc(formatAmount(v))}">
        <span class="dash-mbar" style="height:${barPx(v)}px"></span>
        <span class="dash-mval">${v ? esc(formatAmount(v)) : "\u2014"}</span>
        <span class="dash-mlabel">${esc(MONTH_NAMES[Number(k.slice(5, 7)) - 1].slice(0, 3))}</span>
      </div>`;
    }).join("")}
  </div>
  <div class="dash-mnote">${esc(formatAmount(spent))} over these ${keys.length} months \u00b7 months ahead hold what is already recorded</div>`;
}

// ---------- Anything that needs attention right now ----------
function renderAlerts(t) {
  const overdue = state.bookings.filter(b => bookingState(b) === "overdue");
  const lateJobs = buildSchedule({ from: null, to: null, includeDone: false }).filter(j => j.overdue);
  const dueService = state.cars.filter(serviceDue);
  const docsExpired = state.cars.filter(c => carDocsDue(c).some(x => x.expired));
  const docsSoon = state.cars.filter(c => {
    const due = carDocsDue(c);
    return due.length && !due.some(x => x.expired);
  });
  const noRate = state.cars.filter(c => !c.dailyRate);

  const alerts = [];

  // Company operating licence — set on the Settings page. These come first:
  // one company-level problem outranks any single car's. The look-ahead is 60
  // days rather than the cars' 30, because renewing an operating licence
  // involves an authority, not a counter at the insurer.
  {
    const s = state.settings || {};
    const end = s.licenceEnd || "";
    if (end && end.length === 10) {
      const h = new Date(t + "T12:00");
      h.setDate(h.getDate() + 60);
      const horizon = `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, "0")}-${String(h.getDate()).padStart(2, "0")}`;
      if (end < t) alerts.push({
        tone: "red", goto: "settings",
        text: `Company licence expired on ${formatDate(end)}`
      });
      else if (end <= horizon) alerts.push({
        tone: "amber", goto: "settings",
        text: `Company licence expires ${formatDate(end)}`
      });
    }
    if (typeof s.licenceFleet === "number" && s.licenceFleet > 0
        && state.cars.length > s.licenceFleet) alerts.push({
      tone: "red", goto: "fleet",
      text: `Fleet has ${state.cars.length} cars but the licence covers ${s.licenceFleet}`
    });
  }

  if (overdue.length) alerts.push({
    tone: "red", goto: "bookings",
    text: `${overdue.length} rental${overdue.length === 1 ? "" : "s"} past the return date`
  });
  if (lateJobs.length) alerts.push({
    tone: "red", goto: "tasks",
    text: `${lateJobs.length} job${lateJobs.length === 1 ? "" : "s"} running late`
  });
  if (docsExpired.length) alerts.push({
    tone: "red", goto: "fleet", focus: "docs",
    text: `${docsExpired.length} car${docsExpired.length === 1 ? "" : "s"} with expired documents (licence, insurance, road tax…)`
  });
  if (docsSoon.length) alerts.push({
    tone: "amber", goto: "fleet", focus: "docs",
    text: `${docsSoon.length} car${docsSoon.length === 1 ? "" : "s"} with documents expiring within 30 days`
  });
  if (dueService.length) alerts.push({
    tone: "amber", goto: "maintenance",
    text: `${dueService.length} car${dueService.length === 1 ? "" : "s"} due a service`
  });
  if (noRate.length) alerts.push({
    tone: "amber", goto: "fleet",
    text: `${noRate.length} car${noRate.length === 1 ? "" : "s"} with no daily rate set`
  });

  el(root, "alerts").innerHTML = alerts.length === 0
    ? `<div class="dash-allclear">Nothing needs attention — no overdue rentals, late jobs or servicing due.</div>`
    : alerts.map(a =>
        `<button class="dash-alert ${a.tone}" data-goto="${a.goto}"${a.focus ? ` data-focus="${a.focus}"` : ""}>${esc(a.text)} →</button>`).join("");
}

// ---------- Today's deliveries and collections ----------
function renderTodayJobs() {
  const t = todayStr();
  // buildSchedule deliberately hangs on to unfinished jobs from earlier days so
  // the Tasks list can never lose one. This card is specifically about today and
  // has room for six rows, so leftovers used to push the day's real work out of
  // sight. They are counted and linked instead of listed.
  const all = buildSchedule({ from: t, to: t, includeDone: false });
  const jobs = all.filter(j => j.date === t);
  const leftover = all.length - jobs.length;
  const leftoverLink = leftover > 0
    ? `<button class="dash-more" data-goto="tasks">+ ${leftover} unfinished from earlier days →</button>`
    : "";

  const box = el(root, "today-jobs");
  if (jobs.length === 0) {
    box.innerHTML = `<div class="dash-empty">No jobs scheduled today.</div>` + leftoverLink;
    return;
  }

  const shown = jobs.slice(0, 6);
  box.innerHTML = shown.map(j => `
    <div class="dash-job" data-goto="tasks">
      <span class="dash-job-time">${j.time ? esc(j.time) : "—"}</span>
      <span class="job-kind ${j.kind}">${
        { delivery: "Out", recovery: "Back", task: "Task", service: "Service" }[j.kind] || j.kind
      }</span>
      <span class="dash-job-main">${esc(j.car || j.customer)}${
        j.kind !== "task" && j.customer ? ` <span class="dash-dim">${esc(j.customer)}</span>` : ""
      }${j.location ? ` <span class="dash-dim">· ${esc(j.location)}</span>` : ""}</span>
      ${j.overdue ? `<span class="job-flag">Late</span>` : ""}
    </div>`).join("")
    + (jobs.length > shown.length
        ? `<button class="dash-more" data-goto="tasks">+ ${jobs.length - shown.length} more today →</button>`
        : "")
    + leftoverLink;
}

// ---------- Money ----------
// One calendar month at a time, steppable in both directions. Stepping forward
// is the point as much as stepping back: a month still to come shows nothing
// received and nothing owed yet, but its Booked figure is the company's order
// book for that month, which is what the pilot's accountant asked to see.
function renderMoney() {
  const m = moneySummary(state.bookings, d => monthOf(d) === moneyMonth);
  const label = monthLabel(moneyMonth);

  const range = el(root, "money-range");
  if (range) {
    range.textContent = moneyMonth === thisMonth() ? `${label} · this month` : label;
  }

  // Booked, Received, Outstanding, Deposits — the order the pilot's finance
  // office reads them in: what was sold, what came in, what is still owed, what
  // is only being held. Each figure answers the one before it.
  el(root, "money").innerHTML =
    figure("Booked", formatAmount(m.booked), "", "bookings", "rentals starting this month") +
    figure("Received", formatAmount(m.received), "green", "billing", "cash arriving this month, any booking") +
    figure("Outstanding", formatAmount(m.outstanding), "red", "billing", "unpaid rentals already started") +
    figure("Deposits held", formatAmount(m.deposits), "blue", "billing");
}

// ---------- Figures by page ----------
function renderFleetFigures() {
  const withStatus = state.cars.map(c => carStatus(c));
  const available = withStatus.filter(s => s === "available").length;
  const out = withStatus.filter(s => s === "rented" || s === "overdue").length;
  const service = withStatus.filter(s => s === "service").length;

  el(root, "fleet-figures").innerHTML =
    figure("Total cars", state.cars.length, "", "fleet") +
    figure("Free now", available, "green", "fleet") +
    figure("Out now", out, "amber", "fleet") +
    figure("Out of service", service, "red", "maintenance");
}

function renderBookingFigures() {
  const states = state.bookings.map(bookingState);
  const count = s => states.filter(x => x === s).length;
  el(root, "booking-figures").innerHTML =
    figure("Active", count("active-b"), "green", "bookings") +
    figure("Upcoming", count("upcoming"), "amber", "bookings") +
    figure("Overdue", count("overdue"), "red", "bookings") +
    figure("Completed", count("completed"), "", "bookings");
}

function renderServiceFigures() {
  const due = state.cars.filter(serviceDue).length;
  const oos = state.cars.filter(c => c.outOfService).length;
  const scheduled = state.cars.filter(c => c.nextServiceDate && !serviceDue(c)).length;
  el(root, "service-figures").innerHTML =
    figure("Service due", due, "amber", "maintenance") +
    figure("Out of service", oos, "red", "maintenance") +
    figure("Scheduled", scheduled, "", "maintenance");
}

function renderCustomerFigures() {
  const added = state.customers.filter(c => inPeriod(c.createdAt)).length;
  const repeat = state.customers.filter(c =>
    state.bookings.filter(b => b.customerId === c.id).length > 1).length;

  el(root, "customer-figures").innerHTML =
    figure("On the register", state.customers.length, "", "customers") +
    figure(`Added (${PERIOD_DAYS} days)`, added, "blue", "customers") +
    figure("Repeat renters", repeat, "green", "customers");
}

function renderUnpaid() {
  const unpaid = state.bookings
    .filter(b => hasStarted(b) && !b.paid && balanceFor(b) > 0)
    .sort((a, b) => a.endDate.localeCompare(b.endDate));

  const box = el(root, "unpaid-list");
  if (unpaid.length === 0) {
    box.innerHTML = `<div class="dash-empty">Everything is settled.</div>`;
    return;
  }

  const shown = unpaid.slice(0, 5);
  box.innerHTML = shown.map(b => `
    <div class="dash-job" data-goto="billing">
      <span class="dash-job-main">${esc(b.renter)}
        <span class="dash-dim">${esc(bookingCarLabel(b))}</span></span>
      <span class="dash-amount">${formatAmount(balanceFor(b))}</span>
    </div>`).join("")
    + (unpaid.length > shown.length
        ? `<button class="dash-more" data-goto="billing">+ ${unpaid.length - shown.length} more unpaid →</button>`
        : "");
}
