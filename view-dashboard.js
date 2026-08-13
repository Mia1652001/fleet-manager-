// Dashboard — the morning overview. Everything here is derived from data the
// other views already load, so it costs no extra database reads, and every
// figure links through to the screen where you would act on it.
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
  carDocsDue
} from "./store.js";

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
    if (go) { location.hash = "#" + go.dataset.goto; return; }
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


function figure(label, value, tone, goto) {
  return `<button class="dash-figure" data-goto="${goto}">
    <span class="dash-figure-val ${tone || ""}">${value}</span>
    <span class="dash-figure-label">${esc(label)}</span>
  </button>`;
}

export function render() {
  if (!root) return;
  const t = todayStr();

  renderAlerts(t);
  renderTodayJobs();
  renderMoney();
  renderFleetFigures();
  renderBookingFigures();
  renderServiceFigures();
  renderCustomerFigures();
  renderUnpaid();
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
    tone: "red", goto: "fleet",
    text: `${docsExpired.length} car${docsExpired.length === 1 ? "" : "s"} with expired documents (licence, insurance, road tax…)`
  });
  if (docsSoon.length) alerts.push({
    tone: "amber", goto: "fleet",
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
        `<button class="dash-alert ${a.tone}" data-goto="${a.goto}">${esc(a.text)} →</button>`).join("");
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
    figure("Booked", formatAmount(m.booked), "", "bookings") +
    figure("Received", formatAmount(m.received), "green", "billing") +
    figure("Outstanding", formatAmount(m.outstanding), "red", "billing") +
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
