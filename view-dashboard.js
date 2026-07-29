// Dashboard — the morning overview. Everything here is derived from data the
// other views already load, so it costs no extra database reads, and every
// figure links through to the screen where you would act on it.
import { openBookingModal } from "./booking-form.js";
import {
  state, onDataChange, esc, formatDate, formatAmount, todayStr,
  orderedCars, carStatus, currentBooking, serviceDue,
  bookingState, bookingCarLabel, buildSchedule,
  startTime, endTime, rentalTotal, balanceFor, securityHeld, settledAmount, hasStarted,
  inPeriod, settledOn, PERIOD_DAYS,
  sharesStartHandover, sharesEndHandover,
  el,
  requestFocus,
  invoiceTotal
} from "./store.js";

let root = null;
const DASH_DAYS = 14;
let anchorOffset = -1;   // days relative to today for the first visible column

function shiftAnchor(days) { anchorOffset += days; render(); }

// The vehicle column and day columns were sized for a desktop card. Inside a
// phone-width card that left 120px of the ~306px available to the car names,
// squeezing a fortnight into the rest. Narrower on a phone, unchanged elsewhere.
function miniColumns() {
  return window.matchMedia("(max-width: 640px)").matches
    ? { label: 84, half: 9 }
    : { label: 120, half: 14 };
}

export function mount(container) {
  root = container;

  // The planner here behaves exactly like the one on the Bookings page:
  // tap a booking to edit it, tap an empty day to create one.
  el(root, "mini").addEventListener("click", (e) => {
    const bar = e.target.closest("[data-booking]");
    if (bar) { openBookingModal(bar.dataset.booking); return; }

    const cell = e.target.closest("[data-add-car]");
    if (cell) { openBookingModal(null, { carId: cell.dataset.addCar, date: cell.dataset.addDate }); return; }

    const car = e.target.closest("[data-carjump]");
    if (car) {
      requestFocus("fleet", car.dataset.carjump);
      location.hash = "#fleet";
      return;
    }
  });

  // Everything else on the dashboard is a shortcut to the page that owns it
  root.addEventListener("click", (e) => {
    if (e.target.closest("[data-el='mini']")) return;   // planner handled above
    const go = e.target.closest("[data-goto]");
    if (go) { location.hash = "#" + go.dataset.goto; return; }
  });

  // Prev / today / next for the planner window
  el(root, "mini-prev").addEventListener("click", () => { shiftAnchor(-7); });
  el(root, "mini-next").addEventListener("click", () => { shiftAnchor(7); });
  el(root, "mini-today").addEventListener("click", () => { anchorOffset = -1; render(); });

  // Rotating a phone or resizing changes which column sizes apply, so redraw.
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (root.classList.contains("active")) render();
    }, 150);
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
  renderMiniTimeline();
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
  const noRate = state.cars.filter(c => !c.dailyRate);

  const alerts = [];
  if (overdue.length) alerts.push({
    tone: "red", goto: "bookings",
    text: `${overdue.length} rental${overdue.length === 1 ? "" : "s"} past the return date`
  });
  if (lateJobs.length) alerts.push({
    tone: "red", goto: "tasks",
    text: `${lateJobs.length} job${lateJobs.length === 1 ? "" : "s"} running late`
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
function renderMoney() {
  const started = state.bookings.filter(hasStarted);
  const unpaid = started.filter(b => !b.paid);
  const outstanding = unpaid.reduce((s, b) => s + balanceFor(b), 0);

  // What actually came in. This has to be the settled amount, not the rental
  // total: an advance taken before the window was received then, not now.
  // Billing counts it exactly the same way, so the two screens agree.
  const received = state.bookings
    .filter(b => b.paid && inPeriod(settledOn(b)))
    .reduce((s, b) => s + settledAmount(b), 0);

  // What the period's rentals are worth in total, settled or not
  const booked = state.bookings
    .filter(b => inPeriod(b.startDate))
    .reduce((s, b) => s + invoiceTotal(b), 0);

  const deposits = state.bookings.reduce((s, b) => s + securityHeld(b), 0);

  el(root, "money").innerHTML =
    figure("Outstanding", formatAmount(outstanding), "red", "billing") +
    figure(`Received (${PERIOD_DAYS} days)`, formatAmount(received), "green", "billing") +
    figure(`Booked (${PERIOD_DAYS} days)`, formatAmount(booked), "", "bookings") +
    figure("Deposits held", formatAmount(deposits), "blue", "billing");
}

// ---------- Compact read-only planner ----------
function renderMiniTimeline() {
  const grid = el(root, "mini");
  const t = todayStr();

  const days = [];
  const anchor = new Date();
  anchor.setHours(0, 0, 0, 0);
  anchor.setDate(anchor.getDate() + anchorOffset);
  for (let i = 0; i < DASH_DAYS; i++) {
    const d = new Date(anchor);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  const dstr = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const first = dstr(days[0]), last = dstr(days[days.length - 1]);

  const cars = orderedCars();
  if (cars.length === 0) {
    grid.style.gridTemplateColumns = "1fr";
    grid.innerHTML = `<div class="tl-empty">No cars yet — add some on the Fleet view.</div>`;
    return;
  }

  const cols = miniColumns();
  grid.style.gridTemplateColumns =
    `${cols.label}px repeat(${DASH_DAYS * 2}, minmax(${cols.half}px, 1fr))`;
  // Same as the full planner: state the width rather than let the longest
  // booking label decide it. This grid shares the .timeline class, so it had the
  // same fault — columns widening whenever a wordy booking came into view.
  grid.style.minWidth = (cols.label + DASH_DAYS * 2 * cols.half) + "px";

  const dow = ["Su","Mo","Tu","We","Th","Fr","Sa"];
  const MON3 = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  let html = `<div class="tl-corner" style="grid-row:1;grid-column:1;">Vehicle</div>`;
  days.forEach((d, i) => {
    const ds = dstr(d);
    const monthStart = d.getDate() === 1;
    const cls = (ds === t ? "today" : (d.getDay() === 0 || d.getDay() === 6) ? "weekend" : "")
      + (monthStart ? " month-start" : "");
    html += `<div class="tl-daynum ${cls}" style="grid-row:1;grid-column:${i * 2 + 2} / span 2;">
      <span class="dow">${monthStart ? MON3[d.getMonth()] : dow[d.getDay()]}</span>${d.getDate()}</div>`;
  });

  cars.forEach((car, idx) => {
    const row = idx + 2;
    const oos = !!car.outOfService;

    html += `<div class="tl-car" data-carjump="${car.id}" style="grid-row:${row};grid-column:1;">
      <strong><span class="car-hl"${car.rowColour ? ` style="background:${car.rowColour}"` : ""}>${esc(`${car.make} ${car.model}`)}</span></strong>
      <span class="tl-plate">${esc(car.plate || "no plate")}</span>
    </div>`;

    days.forEach((d, i) => {
      const ds = dstr(d);
      const cls = (ds === t ? "today" : (d.getDay() === 0 || d.getDay() === 6) ? "weekend" : "")
        + (d.getDate() === 1 ? " month-start" : "");
      html += `<div class="tl-cell addable ${cls}" data-add-car="${car.id}" data-add-date="${ds}"
        title="Add a booking for this car on ${formatDate(ds)}"
        style="grid-row:${row};grid-column:${i * 2 + 2} / span 2;"></div>`;
    });

    if (oos) {
      html += `<div class="tl-oos-bar" style="grid-row:${row};grid-column:2 / ${DASH_DAYS * 2 + 2};">Out of service</div>`;
    }

    state.bookings
      .filter(b => b.carId === car.id && b.startDate <= last && b.endDate >= first)
      .forEach(b => {
        const s0 = b.startDate < first ? 0 : Math.round((new Date(b.startDate) - days[0]) / 86400000);
        const e0 = b.endDate > last ? DASH_DAYS - 1 : Math.round((new Date(b.endDate) - days[0]) / 86400000);
        if (!(e0 >= 0 && s0 <= DASH_DAYS - 1 && e0 >= s0)) return;

        const st = bookingState(b);
        const clipS = sharesStartHandover(b) && b.startDate >= first;
        const clipE = sharesEndHandover(b) && b.endDate <= last;
        const colS = s0 * 2 + 2 + (clipS ? 1 : 0);
        const colE = e0 * 2 + 4 - (clipE ? 1 : 0);
        const custom = b.barColour ? `background:${b.barColour};color:#24201a;` : "";

        html += `<div class="tl-bar ${st} ${b.barColour ? "custom" : ""}" data-booking="${b.id}"
          title="${esc(`${b.renter} · ${formatDate(b.startDate)} ${startTime(b)} – ${formatDate(b.endDate)} ${endTime(b)}`)}"
          style="grid-row:${row};grid-column:${colS} / ${colE};${custom}">
            <span class="tl-bar-name">${esc(b.renter || "")}</span>
          </div>`;
      });
  });

  grid.innerHTML = html;

  const fmt = d => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  el(root, "mini-range").textContent = `${fmt(days[0])} – ${fmt(days[days.length - 1])}`;
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
