// Dashboard — the morning overview. Everything here is derived from data the
// other views already load, so it costs no extra database reads, and every
// figure links through to the screen where you would act on it.
import {
  state, onDataChange, esc, formatDate, formatAmount, todayStr,
  orderedCars, carStatus, currentBooking, serviceDue,
  bookingState, bookingCarLabel, buildSchedule,
  startTime, endTime, rentalTotal, balanceFor, securityHeld, hasStarted,
  sharesStartHandover, sharesEndHandover,
  el
} from "./store.js";

let root = null;
const DASH_DAYS = 14;

export function mount(container) {
  root = container;

  // Any figure or row can be a shortcut to the page that owns it
  root.addEventListener("click", (e) => {
    const go = e.target.closest("[data-goto]");
    if (go) { location.hash = "#" + go.dataset.goto; return; }
  });

  onDataChange(() => { if (root.classList.contains("active")) render(); });
}

function shiftDate(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
  const jobs = buildSchedule({ from: t, to: t, includeDone: false });

  const box = el(root, "today-jobs");
  if (jobs.length === 0) {
    box.innerHTML = `<div class="dash-empty">No jobs scheduled today.</div>`;
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
        : "");
}

// ---------- Money ----------
function renderMoney() {
  const started = state.bookings.filter(hasStarted);
  const unpaid = started.filter(b => !b.paid);
  const outstanding = unpaid.reduce((s, b) => s + balanceFor(b), 0);

  const now = new Date();
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const received = state.bookings
    .filter(b => b.paid && (b.paidAt || "").startsWith(monthPrefix))
    .reduce((s, b) => s + rentalTotal(b), 0);

  // What this month's bookings are worth in total, settled or not
  const monthValue = state.bookings
    .filter(b => (b.startDate || "").startsWith(monthPrefix))
    .reduce((s, b) => s + rentalTotal(b), 0);

  const deposits = state.bookings.reduce((s, b) => s + securityHeld(b), 0);

  el(root, "money").innerHTML =
    figure("Outstanding", formatAmount(outstanding), "red", "billing") +
    figure("Received this month", formatAmount(received), "green", "billing") +
    figure("Booked this month", formatAmount(monthValue), "", "bookings") +
    figure("Deposits held", formatAmount(deposits), "blue", "billing");
}

// ---------- Compact read-only planner ----------
function renderMiniTimeline() {
  const grid = el(root, "mini");
  const t = todayStr();

  const days = [];
  const anchor = new Date();
  anchor.setHours(0, 0, 0, 0);
  anchor.setDate(anchor.getDate() - 1);          // a day of context behind
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

  grid.style.gridTemplateColumns = `120px repeat(${DASH_DAYS * 2}, minmax(14px, 1fr))`;

  const dow = ["Su","Mo","Tu","We","Th","Fr","Sa"];
  let html = `<div class="tl-corner" style="grid-row:1;grid-column:1;">Vehicle</div>`;
  days.forEach((d, i) => {
    const ds = dstr(d);
    const cls = ds === t ? "today" : (d.getDay() === 0 || d.getDay() === 6) ? "weekend" : "";
    html += `<div class="tl-daynum ${cls}" style="grid-row:1;grid-column:${i * 2 + 2} / span 2;">
      <span class="dow">${dow[d.getDay()]}</span>${d.getDate()}</div>`;
  });

  cars.forEach((car, idx) => {
    const row = idx + 2;
    const oos = !!car.outOfService;

    html += `<div class="tl-car" data-goto="bookings" style="grid-row:${row};grid-column:1;">
      <strong><span class="car-hl"${car.rowColour ? ` style="background:${car.rowColour}"` : ""}>${esc(`${car.make} ${car.model}`)}</span></strong>
      <span class="tl-plate">${esc(car.plate || "no plate")}</span>
    </div>`;

    days.forEach((d, i) => {
      const ds = dstr(d);
      const cls = ds === t ? "today" : (d.getDay() === 0 || d.getDay() === 6) ? "weekend" : "";
      html += `<div class="tl-cell ${cls}" data-goto="bookings" style="grid-row:${row};grid-column:${i * 2 + 2} / span 2;"></div>`;
    });

    if (oos) {
      html += `<div class="tl-oos-bar" data-goto="bookings" style="grid-row:${row};grid-column:2 / ${DASH_DAYS * 2 + 2};">Out of service</div>`;
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

        html += `<div class="tl-bar ${st} ${b.barColour ? "custom" : ""}" data-goto="bookings"
          title="${esc(`${b.renter} · ${formatDate(b.startDate)} ${startTime(b)} – ${formatDate(b.endDate)} ${endTime(b)}`)}"
          style="grid-row:${row};grid-column:${colS} / ${colE};${custom}">
            <span class="tl-bar-name">${esc(b.renter || "")}</span>
          </div>`;
      });
  });

  grid.innerHTML = html;
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
  const now = new Date();
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const added = state.customers.filter(c => (c.createdAt || "").startsWith(monthPrefix)).length;
  const repeat = state.customers.filter(c =>
    state.bookings.filter(b => b.customerId === c.id).length > 1).length;

  el(root, "customer-figures").innerHTML =
    figure("On the register", state.customers.length, "", "customers") +
    figure("Added this month", added, "blue", "customers") +
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
