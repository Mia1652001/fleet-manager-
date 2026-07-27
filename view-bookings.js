// Bookings view — calendar and reservations with conflict prevention.
//
// The add/edit booking dialog itself lives in booking-form.js, shared with the
// dashboard planner, so both screens open the same form and validate the same way.
import { openBookingModal } from "./booking-form.js";
import { db, setSync } from "./firebase-init.js";
import { updateDoc, deleteDoc, doc, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  state, onDataChange, esc, formatDate, formatAmount, todayStr, bookingCarLabel, bookingState,
  sharesStartHandover, sharesEndHandover, serviceDue,
  orderedCars, loadPref, savePref,
  startTime, endTime, pickupLabel, dropoffLabel, rentalTotal,
  initPanelToggle,
  el, val, closeModal
} from "./store.js";

let root = null;
let filter = "all";
let calYear, calMonth;
let planner = "timeline"; // "timeline" | "month"

// The timeline always holds the same stretch of calendar — a month and a half,
// starting a few days before today. The slider is a zoom, not a range: it makes
// the columns wider or narrower so more or less of that stretch is on screen at
// once, but every one of the 45 days stays there to be scrolled to. Before, the
// slider shortened the window itself, so zooming in to read a booking threw away
// the far end of the calendar and there was no way to scroll to it.
const TIMELINE_DAYS = 45;

// Day column widths per slider position, as half-columns — a day is two of
// these, because bookings hand over mid-day and a bar can start or end on a
// half. Wider steps than the old scale, since the window no longer shortens to
// compensate: zooming in now has to do all the work of making a bar readable.
const ZOOM_HALF = { 1: 16, 2: 22, 3: 30, 4: 42, 5: 60 };   // desktop
const MOBILE_HALF = { 1: 10, 2: 12, 3: 15, 4: 19, 5: 26 }; // phones

// The vehicle column can afford to be generous when the days are wide.
const ZOOM_LABEL = { 1: 120, 2: 140, 3: 170, 4: 190, 5: 200 };

// Position 3 on a desktop puts roughly three weeks on screen, which is what the
// planner showed before this change. A phone starts one step wider still, since
// screen space is the scarce thing there.
const DEFAULT_ZOOM = window.matchMedia("(max-width: 640px)").matches ? 1 : 3;
let zoom = loadPref("timelineZoom", DEFAULT_ZOOM);

// The planner is what the desk works from, so the summary figures and the
// booking list stay closed until asked for. Each person's choice is remembered
// on their own device.
let showSummary = loadPref("bookingsShowSummary", false);
let showList = loadPref("bookingsShowList", false);

function isNarrowScreen() {
  return window.matchMedia("(max-width: 640px)").matches;
}

function zoomCfg() {
  const z = ZOOM_HALF[zoom] ? zoom : 3;
  // A phone gets its own, much narrower set: the vehicle column is trimmed to
  // 88px and the days are roughly a third of their desktop width, or barely any
  // of the calendar would be on screen at once.
  return isNarrowScreen()
    ? { days: TIMELINE_DAYS, half: MOBILE_HALF[z], label: 88 }
    : { days: TIMELINE_DAYS, half: ZOOM_HALF[z], label: ZOOM_LABEL[z] };
}

function timelineDays() { return zoomCfg().days; }

// The window is always 45 days now, so printing that would say nothing. What the
// slider actually changes is how much of it you can see without scrolling, so
// that is what the readout reports. Measured from the planner's real width, so
// it is honest on any screen.
function syncZoomLabel() {
  const out = el(root, "zoom-count");
  if (!out) return;
  const wrap = el(root, "timeline-wrap");
  const cfg = zoomCfg();
  const usable = (wrap ? wrap.clientWidth : 0) - cfg.label;
  const visible = usable > 0
    ? Math.min(TIMELINE_DAYS, Math.max(1, Math.floor(usable / (cfg.half * 2))))
    : null;
  out.textContent = visible ? `${visible} of ${TIMELINE_DAYS}d` : `${TIMELINE_DAYS}d`;
}

// Roughly how wide the bar labels render. DM Mono is monospaced, so character
// count is a reliable proxy — but only against the right font size, and the bars
// are set smaller on a phone than on a desktop. Measuring everything at the
// desktop size over-estimated what a phone label needs by more than a tenth,
// which hid text that would in fact have fitted.
//
// pad is what the bar spends on its own side padding; gap is the space before
// each label that follows another. Counted separately because a bar carrying
// only a name pays no gaps at all — lumping them into one figure charged every
// bar for spacing it was not using, which is why the shortest bars came out
// completely empty.
const BAR_METRICS = {
  wide:   { charPx: 5.4, pad: 14, gap: 6 },   // 9px labels, 7px side padding
  narrow: { charPx: 4.8, pad: 10, gap: 4 }    // 8px labels, 5px side padding
};

function barMetrics() {
  return isNarrowScreen() ? BAR_METRICS.narrow : BAR_METRICS.wide;
}

// Room the end labels take, including the gap each one introduces.
function endsWidth(parts) {
  const m = barMetrics();
  const shown = parts.filter(Boolean);
  return shown.reduce((n, t) => n + t.length, 0) * m.charPx + shown.length * m.gap;
}
let timelineAnchor = null; // Date — first visible day in the timeline

// Redrawing the planner rebuilds every cell, which loses the scroll position.
// Most redraws are not the user's doing — a colleague saves a booking, a search
// term is typed, the window is resized — and being thrown back to today in the
// middle of reading August is maddening. So the position is put back afterwards,
// except when the user has actually asked to move the window.
let reanchored = true;   // the first draw should start at the left
let legendOpen = () => true;   // set on mount; see initPanelToggle

function freshAnchor() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 3); // a little history for context, then the road ahead
  return d;
}
function dstr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function mount(container) {
  root = container;
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth();
  timelineAnchor = freshAnchor();

  applyPanels();
  // The legend costs four lines of a phone screen to explain colours that are
  // self-evident after a day's use, so it starts closed there. A desktop has
  // room, so it stays open. Either way the choice is remembered.
  legendOpen = initPanelToggle(
    root, "bookingsShowLegend", "toggle-legend", "hide-legend", "Legend", !isNarrowScreen());
  el(root, "toggle-summary").addEventListener("click", () => togglePanel("summary"));
  el(root, "toggle-list").addEventListener("click", () => togglePanel("list"));

  el(root, "search").addEventListener("input", render);   // redraws planner and list
  el(root, "new-booking").addEventListener("click", () => openBookingModal(null));


  const zoomEl = el(root, "zoom");
  zoomEl.value = String(zoom);
  zoomEl.addEventListener("input", () => {
    zoom = Number(zoomEl.value);
    savePref("timelineZoom", zoom);
    // Column widths change, so the old offset would land somewhere arbitrary
    reanchored = true;
    render();
  });
  syncZoomLabel();


  // Rotating a phone changes which layout applies, so redraw on resize
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (root.classList.contains("active") && planner === "timeline") render();
    }, 150);
  });

  setupCarDragging();

  el(root, "view-timeline").addEventListener("click", () => setPlanner("timeline"));
  el(root, "view-month").addEventListener("click", () => setPlanner("month"));

  // Clicking a booking bar in the timeline opens it for editing
  el(root, "timeline").addEventListener("click", (e) => {
    const link = e.target.closest(".tl-carlink");
    if (link) { location.hash = "#fleet"; return; }

    const bar = e.target.closest("[data-booking]");
    if (bar) { openBookingModal(bar.dataset.booking); return; }

    // Clicking an empty day opens a new booking with that car and date
    // already filled in, so there is no need to pick them again.
    const cell = e.target.closest("[data-add-car]");
    if (cell) openBookingModal(null, { carId: cell.dataset.addCar, date: cell.dataset.addDate });
  });

  el(root, "cal-prev").addEventListener("click", () => {
    if (planner === "timeline") {
      timelineAnchor.setDate(timelineAnchor.getDate() - 7); reanchored = true; render();
    } else shiftMonth(-1);
  });
  el(root, "cal-next").addEventListener("click", () => {
    if (planner === "timeline") {
      timelineAnchor.setDate(timelineAnchor.getDate() + 7); reanchored = true; render();
    } else shiftMonth(1);
  });
  // Reaching 2027 by pressing Next twenty-six times is not reasonable. A month
  // input jumps straight to any month of any year, and on a phone it opens the
  // native month-and-year wheel rather than a text field.
  el(root, "cal-jump").addEventListener("change", () => {
    const v = val(root, "cal-jump");                 // format is "2027-03"
    const m = /^(\d{4})-(\d{2})$/.exec(v);
    if (!m) return;
    const year = Number(m[1]), monthIndex = Number(m[2]) - 1;
    if (monthIndex < 0 || monthIndex > 11) return;
    if (planner === "timeline") {
      timelineAnchor = new Date(year, monthIndex, 1);
      reanchored = true;                             // a new window starts at its first day
    } else {
      calYear = year; calMonth = monthIndex;
    }
    render();
  });

  el(root, "cal-today").addEventListener("click", () => {
    if (planner === "timeline") { timelineAnchor = freshAnchor(); reanchored = true; }
    else {
      const d = new Date();
      calYear = d.getFullYear(); calMonth = d.getMonth();
    }
    render();
  });

  el(root, "filters").addEventListener("click", (e) => {
    const t = e.target.closest(".tab");
    if (!t) return;
    filter = t.dataset.f;
    el(root, "filters").querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
    t.classList.add("active");
    render();
  });

  root.querySelectorAll("[data-close]").forEach(b =>
    b.addEventListener("click", () => closeModal(root, b.dataset.close)));
  root.querySelectorAll(".overlay").forEach(o =>
    o.addEventListener("click", e => { if (e.target === o) o.classList.remove("open"); }));

  el(root, "list").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.act === "complete") completeBooking(id);
    else if (btn.dataset.act === "edit") openBookingModal(id);
    else if (btn.dataset.act === "delete") deleteBooking(id);
  });

  onDataChange(() => { if (root.classList.contains("active")) render(); });
}

function shiftMonth(delta) {
  calMonth += delta;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  if (calMonth > 11) { calMonth = 0; calYear++; }
  render();
}

function stateLabel(s) {
  return { "active-b": "Active", upcoming: "Upcoming", overdue: "Overdue", completed: "Completed" }[s] || s;
}

export function render() {
  if (!root) return;
  if (showSummary) renderStats();
  if (planner === "timeline") { renderTimeline(); fitPlannerHeight(); }
  else renderCalendar();
  // After the planner is drawn, so the readout can measure a laid-out element.
  syncZoomLabel();
  updateToggleLabels();
  // A closed panel is not drawn at all, so a long booking list costs nothing
  // while it is put away.
  if (showList) renderList();
}

// ---------- Planner height ----------
// The planner has to be its own scrolling box, or the frozen date row has
// nothing to stay pinned to. That means it needs a height — and a guessed
// height is either wasteful or too short, because what sits above it changes
// (the Summary panel opens and closes, and windows differ). So it is measured:
// fill everything from the planner's top edge to the bottom of the window.
const PLANNER_MIN_HEIGHT = 320;   // a short window still gets a usable planner
const PLANNER_BOTTOM_GAP = 4;     // run right down to the window edge

function fitPlannerHeight() {
  const wrap = el(root, "timeline-wrap");
  if (!wrap) return;
  // Document offset, not viewport offset, so the answer does not change
  // depending on how far the page happens to be scrolled.
  const topInPage = wrap.getBoundingClientRect().top + window.scrollY;
  const available = window.innerHeight - topInPage - PLANNER_BOTTOM_GAP;
  wrap.style.maxHeight = Math.max(PLANNER_MIN_HEIGHT, Math.round(available)) + "px";
}

// ---------- Collapsible panels ----------
function applyPanels() {
  root.classList.toggle("hide-summary", !showSummary);
  root.classList.toggle("hide-list", !showList);
  updateToggleLabels();
}

function togglePanel(which) {
  if (which === "summary") {
    showSummary = !showSummary;
    savePref("bookingsShowSummary", showSummary);
  } else {
    showList = !showList;
    savePref("bookingsShowList", showList);
  }
  applyPanels();
  render();          // fills in whatever was just opened
}

function updateToggleLabels() {
  const n = filteredBookings().length;
  el(root, "toggle-summary").textContent = `${showSummary ? "\u25be" : "\u25b8"} Summary`;
  el(root, "toggle-list").textContent =
    `${showList ? "\u25be" : "\u25b8"} Booking list (${n})`;
}

function setPlanner(which) {
  planner = which;
  el(root, "view-timeline").classList.toggle("active", which === "timeline");
  el(root, "view-month").classList.toggle("active", which === "month");
  el(root, "timeline-wrap").style.display = which === "timeline" ? "block" : "none";
  el(root, "calendar").style.display = which === "month" ? "grid" : "none";
  // The Days control only means anything to the timeline; a month is a month.
  el(root, "zoom-wrap").style.display = which === "timeline" ? "" : "none";
  const legend = root.querySelector(".tl-legend");
  if (legend) legend.style.display = which === "timeline" ? "flex" : "none";
  render();
}

function renderStats() {
  const states = state.bookings.map(bookingState);
  const count = s => states.filter(x => x === s).length;
  el(root, "stats").innerHTML = `
    <div class="stat"><div class="stat-label">Active now</div><div class="stat-val green">${count("active-b")}</div></div>
    <div class="stat"><div class="stat-label">Upcoming</div><div class="stat-val amber">${count("upcoming")}</div></div>
    <div class="stat"><div class="stat-label">Overdue</div><div class="stat-val red">${count("overdue")}</div></div>
    <div class="stat"><div class="stat-label">Completed</div><div class="stat-val">${count("completed")}</div></div>
  `;
}

// ---------- Timeline / fleet planner ----------
// Cars down the left, days across the top, one bar per rental.
// This is the layout most rental companies already use on paper or in a
// spreadsheet, so availability can be read across a whole month at a glance.
function renderTimeline() {
  const wrap = el(root, "timeline-wrap");
  const grid = el(root, "timeline");
  const t = todayStr();

  // Build the rolling window of dates from the anchor
  const days = [];
  const DAYS = timelineDays();
  for (let i = 0; i < DAYS; i++) {
    const d = new Date(timelineAnchor);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  const first = dstr(days[0]);
  const last = dstr(days[days.length - 1]);

  // Title shows the visible range rather than a calendar month, since the
  // window can straddle two months.
  const fmt = d => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const yearLabel = days[days.length - 1].getFullYear();
  el(root, "cal-title").textContent = `${fmt(days[0])} – ${fmt(days[days.length - 1])} ${yearLabel}`;

  if (state.cars.length === 0) {
    grid.innerHTML = '<div class="tl-empty">No cars yet. Add cars on the Fleet view and they will appear here.</div>';
    grid.style.gridTemplateColumns = "1fr";
    return;
  }

  const search = el(root, "search").value.trim().toLowerCase();
  let cars = orderedCars();

  if (search) {
    // Keep a car if the car itself matches, or if any of its bookings do.
    cars = cars.filter(c => {
      const carText = `${c.year || ""} ${c.make} ${c.model} ${c.plate || ""} ${c.category || ""}`.toLowerCase();
      if (carText.includes(search)) return true;
      return state.bookings.some(b => b.carId === c.id &&
        `${b.renter || ""} ${b.pickupLocation || ""} ${b.dropoffLocation || ""}`.toLowerCase().includes(search));
    });
  }

  // minmax lets columns stretch to fill a wide screen instead of leaving
  // dead space after the window, while still enforcing a usable minimum
  // width (and staying horizontally scrollable) on narrow ones.
  // Two half-columns per day: a whole rental fills both, and on a handover day
  // the outgoing rental takes the first half and the incoming one the second,
  // so same-day turnarounds read clearly instead of overlapping.
  if (cars.length === 0) {
    grid.innerHTML = '<div class="tl-empty">No cars match that search.</div>';
    grid.style.gridTemplateColumns = "1fr";
    return;
  }

  const cfg = zoomCfg();
  grid.style.gridTemplateColumns = `${cfg.label}px repeat(${DAYS * 2}, minmax(${cfg.half}px, 1fr))`;

  // Width comes from the zoom level, never from the content. Stating it outright
  // means a day column is the same width whatever bookings happen to be on
  // screen, and it makes the planner wider than its frame so it scrolls.
  const gridWidth = cfg.label + DAYS * 2 * cfg.half;
  grid.style.minWidth = gridWidth + "px";

  // How wide a day column really is. Tracks stretch to fill the planner when the
  // frame is wider than the grid needs, so take whichever is larger — but never
  // guess: this now matches what is actually rendered, which the previous
  // estimate did not, and that mismatch was hiding labels from bars that had
  // ample room for them.
  const dayPx = Math.max(cfg.half * 2, (wrap.clientWidth - cfg.label) / DAYS);

  // The sticky renter name pins just past this column, so it needs the width
  grid.style.setProperty("--tl-label-w", cfg.label + "px");

  const dowShort = ["Su","Mo","Tu","We","Th","Fr","Sa"];
  let html = `<div class="tl-corner" style="grid-row:1;grid-column:1;">Vehicle</div>`;

  days.forEach((d, i) => {
    const ds = dstr(d);
    const dow = d.getDay();
    const cls = ds === t ? "today" : (dow === 0 || dow === 6) ? "weekend" : "";
    html += `<div class="tl-daynum ${cls}" style="grid-row:1;grid-column:${i * 2 + 2} / span 2;">
      <span class="dow">${dowShort[dow]}</span>${d.getDate()}</div>`;
  });

  cars.forEach((car, i) => {
    const row = i + 2;
    const oos = !!car.outOfService;

    const due = serviceDue(car);
    html += `<div class="tl-car ${oos ? "oos" : ""} ${due ? "due" : ""}" data-carrow="${car.id}" style="grid-row:${row};grid-column:1;">
      <span class="tl-grip" data-grip="${car.id}" title="Drag to reorder">⠿</span>
      <strong><a href="#fleet" class="tl-carlink" data-car="${car.id}"
        title="Open this car on the Fleet view"><span class="car-hl"${car.rowColour ? ` style="background:${car.rowColour}"` : ""}>${esc(`${car.make} ${car.model}`)}</span></a></strong>
      <span class="tl-plate">${esc(car.plate || "no plate")}${car.category ? " · " + esc(car.category) : ""}${due ? ' <span class="tl-duetag">service due</span>' : ""}</span>
    </div>`;

    days.forEach((d, i2) => {
      const ds = dstr(d);
      const dow = d.getDay();
      const cls = ds === t ? "today" : (dow === 0 || dow === 6) ? "weekend" : "";
      html += `<div class="tl-cell addable ${cls}" data-add-car="${car.id}" data-add-date="${ds}"
        title="Add a booking for this car on ${formatDate(ds)}"
        style="grid-row:${row};grid-column:${i2 * 2 + 2} / span 2;"></div>`;
    });

    if (oos) {
      html += `<div class="tl-oos-bar" style="grid-row:${row};grid-column:2 / ${DAYS * 2 + 2};">Out of service</div>`;
    }

    // Mark the service date itself, if it falls inside the visible window
    if (car.nextServiceDate && car.nextServiceDate >= first && car.nextServiceDate <= last) {
      const off = Math.round((new Date(car.nextServiceDate) - days[0]) / 86400000);
      if (off >= 0 && off < DAYS) {
        html += `<div class="tl-service" title="Service due ${formatDate(car.nextServiceDate)}"
          style="grid-row:${row};grid-column:${off * 2 + 2} / ${off * 2 + 4};">SERVICE</div>`;
      }
    }

    // Bookings for this car that touch the visible window
    state.bookings
      .filter(b => b.carId === car.id && b.startDate <= last && b.endDate >= first)
      .sort((a, b) => a.startDate.localeCompare(b.startDate))
      .forEach(b => {
        // Clip the bar to the visible window, measured in day-offsets from the anchor
        const startOffset = b.startDate < first ? 0 : Math.round((new Date(b.startDate) - days[0]) / 86400000);
        const endOffset = b.endDate > last ? DAYS - 1 : Math.round((new Date(b.endDate) - days[0]) / 86400000);
        if (!(endOffset >= 0 && startOffset <= DAYS - 1 && endOffset >= startOffset)) return;

        const s = bookingState(b);
        const span = endOffset - startOffset + 1;

        // What fits in a bar is a question of pixels against actual text, not of
        // how many days it covers. The old rule hid the pick-up and drop-off
        // labels on anything shorter than four days, so a two-day booking showed
        // nothing but a name even on a wide screen with room to spare — which is
        // the display problem reported from the field.
        //
        // "12:00 BB" and "11:30 Airport" need very different amounts of room, so
        // the labels are measured rather than guessed at. Falling back through
        // location+time, then time alone, then just the name means a bar shows as
        // much as it can hold instead of dropping straight to nothing.
        // Room for text is the bar minus its own side padding.
        const inner = span * dayPx - barMetrics().pad;
        const full = [pickupLabel(b), dropoffLabel(b)];
        const times = [startTime(b), endTime(b)];

        // Where and when the car changes hands is the operational detail; the
        // renter's name is already in the tooltip and the list. So the ends are
        // filled first and the name takes whatever room is left over — which is
        // what lets a short booking show its locations at all.
        let ends = [];
        if (inner >= endsWidth(full)) ends = full;
        else if (inner >= endsWidth(times)) ends = times;
        const [startTxt = "", endTxt = ""] = ends;

        // The name is always rendered and left to truncate in whatever room the
        // ends did not take. Gating it on a pixel budget as well meant a short
        // booking on a phone came out completely blank — a coloured bar with no
        // text at all, which reads as a fault rather than as a bar too small to
        // label. Even two letters and an ellipsis identify which rental it is,
        // and the tooltip still carries the full detail.
        const nameTxt = esc(b.renter || "");

        const paidCls = b.paid ? "paid" : "unpaid";
        // A custom colour replaces the status colour, but an overdue rental
        // keeps a red outline so the warning is never hidden by a colour code.
        const custom = b.barColour || "";
        const customStyle = custom ? `background:${custom};color:#24201a;border-color:rgba(0,0,0,0.12);` : "";
        const customCls = custom ? "custom" : "";
        const title =
          `${b.renter}\n` +
          `Out: ${formatDate(b.startDate)} ${startTime(b)}${b.pickupLocation ? " · " + b.pickupLocation : ""}\n` +
          `Back: ${formatDate(b.endDate)} ${endTime(b)}${b.dropoffLocation ? " · " + b.dropoffLocation : ""}\n` +
          `${formatAmount(rentalTotal(b))} · ${b.paid ? "Paid" : "Unpaid"}` +
          (b.managedBy ? `\nManaged by ${b.managedBy}` : "") +
          (b.deliveredBy ? `\nDelivered by ${b.deliveredBy}` : "") +
          (b.notes ? `\nNote: ${b.notes}` : "");

        // Give up half a day at either end when another rental hands over
        // on the same date, so both are visible side by side.
        const clipStart = sharesStartHandover(b) && b.startDate >= first;
        const clipEnd = sharesEndHandover(b) && b.endDate <= last;
        const colStart = startOffset * 2 + 2 + (clipStart ? 1 : 0);
        const colEnd = endOffset * 2 + 4 - (clipEnd ? 1 : 0);

        html += `<div class="tl-bar ${s} ${paidCls} ${customCls}" data-booking="${b.id}" title="${esc(title)}"
          style="grid-row:${row};grid-column:${colStart} / ${colEnd};${customStyle}">
            ${startTxt ? `<span class="tl-bar-start">${esc(startTxt)}</span>` : ""}
            <span class="tl-bar-name">${b.paid ? "✓ " : ""}${nameTxt}</span>
            ${endTxt ? `<span class="tl-bar-end">${esc(endTxt)}</span>` : ""}
          </div>`;
      });
  });

  // Both axes: the planner scrolls vertically too now that it has a height.
  const keepLeft = wrap.scrollLeft;
  const keepTop = wrap.scrollTop;
  grid.innerHTML = html;
  if (reanchored) {
    wrap.scrollLeft = 0;   // a new window, so start at its first day
    reanchored = false;
  } else {
    wrap.scrollLeft = keepLeft;
    wrap.scrollTop = keepTop;
  }

  // Legend, added once, directly after the timeline
  if (!root.querySelector(".tl-legend")) {
    const legend = document.createElement("div");
    legend.className = "tl-legend";
    legend.innerHTML = `
      <span><i class="tl-key active-b"></i> Out now</span>
      <span><i class="tl-key upcoming"></i> Booked ahead</span>
      <span><i class="tl-key overdue"></i> Overdue</span>
      <span><i class="tl-key oos"></i> Out of service</span>
      <span><i class="tl-key paid"></i> Paid</span>
      <span><i class="tl-key unpaid"></i> Unpaid</span>
      <span><i class="tl-key custom"></i> Your own colour</span>
      <span style="opacity:0.7;">Tap a booking to edit it, or an empty day to add one</span>`;
    wrap.insertAdjacentElement("afterend", legend);
  }
}

function renderCalendar() {
  const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  el(root, "cal-title").textContent = `${monthNames[calMonth]} ${calYear}`;

  const first = new Date(calYear, calMonth, 1);
  const startDow = (first.getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const t = todayStr();

  let html = ["Mo","Tu","We","Th","Fr","Sa","Su"].map(d => `<div class="cal-dow">${d}</div>`).join("");
  for (let i = 0; i < startDow; i++) html += `<div class="cal-day other-month"></div>`;

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const dayBookings = state.bookings.filter(b => b.status !== "completed" && b.startDate <= dateStr && dateStr <= b.endDate);
    const shown = dayBookings.slice(0, 2);
    const extra = dayBookings.length - shown.length;

    html += `
      <div class="cal-day${dateStr === t ? " today" : ""}">
        <div class="cal-day-num">${day}</div>
        ${shown.map(b => `<div class="cal-booking ${bookingState(b)}">${esc(b.renter)}</div>`).join("")}
        ${extra > 0 ? `<div class="cal-more">+${extra} more</div>` : ""}
        <div class="cal-dots">${dayBookings.slice(0, 4).map(b => `<div class="cal-dot ${bookingState(b)}"></div>`).join("")}</div>
      </div>`;
  }

  el(root, "calendar").innerHTML = html;
}

// Which bookings the list would show. Shared with the toggle label, so the
// count on the closed button always matches what opening it reveals.
function filteredBookings() {
  const search = el(root, "search").value.toLowerCase();
  return state.bookings.filter(b => {
    const s = bookingState(b);
    const mf = filter === "all" ? s !== "completed" : s === filter;
    const ms = `${bookingCarLabel(b)} ${b.renter || ""}`.toLowerCase().includes(search);
    return mf && ms;
  });
}

function renderList() {
  let list = filteredBookings();

  const order = { overdue: 0, "active-b": 1, upcoming: 2, completed: 3 };
  list.sort((a, b) => (order[bookingState(a)] - order[bookingState(b)]) || a.startDate.localeCompare(b.startDate));

  const listEl = el(root, "list");
  if (list.length === 0) {
    listEl.innerHTML = '<div class="empty">No bookings here yet. Create one with the button above.</div>';
    return;
  }

  listEl.innerHTML = list.map(b => {
    const s = bookingState(b);
    return `
    <div class="item-card ${s}">
      <div class="card-top">
        <div>
          <div class="card-title">${esc(b.renter)}</div>
          <div class="card-sub">${esc(bookingCarLabel(b))}</div>
        </div>
        <span class="badge ${s}">${stateLabel(s)}</span>
      </div>
      <div class="card-details">
        <span>Out: <strong>${formatDate(b.startDate)} ${startTime(b)}</strong>${b.pickupLocation ? " · " + esc(b.pickupLocation) : ""}</span>
        <span>Back: <strong>${formatDate(b.endDate)} ${endTime(b)}</strong>${b.dropoffLocation ? " · " + esc(b.dropoffLocation) : ""}</span>
        <span>Total: <strong>${formatAmount(rentalTotal(b))}</strong> ${b.paid ? "(paid)" : "(unpaid)"}</span>
        ${b.phone ? `<span>Phone: <strong>${esc(b.phone)}</strong></span>` : ""}
      </div>
      ${(b.managedBy || b.deliveredBy || b.notes) ? `
      <div class="card-details">
        ${b.managedBy ? `<span>Managed by: <strong>${esc(b.managedBy)}</strong></span>` : ""}
        ${b.deliveredBy ? `<span>Delivered by: <strong>${esc(b.deliveredBy)}</strong></span>` : ""}
        ${b.notes ? `<span>Note: <strong>${esc(b.notes)}</strong></span>` : ""}
      </div>` : ""}
      <div class="card-actions">
        ${s !== "completed" ? `<button class="btn" data-act="complete" data-id="${b.id}">Mark returned</button>
        <button class="btn" data-act="edit" data-id="${b.id}">Edit</button>` : ""}
        <button class="btn danger" data-act="delete" data-id="${b.id}">Delete</button>
      </div>
    </div>`;
  }).join("");
}

// ---------- Create / edit ----------
async function completeBooking(id) {
  setSync("saving");
  try { await updateDoc(doc(db, "bookings", id), { status: "completed" }); }
  catch (e) { alert("Couldn't update (" + (e.code || e.message) + ")."); setSync("error"); }
}

async function deleteBooking(id) {
  if (!confirm("Delete this booking?")) return;
  setSync("saving");
  try { await deleteDoc(doc(db, "bookings", id)); }
  catch (e) { alert("Couldn't delete (" + (e.code || e.message) + ")."); setSync("error"); }
}

// ---------- Reordering cars in the planner ----------
// Pointer events rather than HTML5 drag-and-drop, because the latter does not
// work on touch screens. Dragging starts only from the grip handle, so tapping
// the car name still follows the link to the Fleet view.

let dragCarId = null;
let dragOverId = null;

function setupCarDragging() {
  const grid = el(root, "timeline");

  grid.addEventListener("pointerdown", (e) => {
    const grip = e.target.closest("[data-grip]");
    if (!grip) return;
    e.preventDefault();
    dragCarId = grip.dataset.grip;
    dragOverId = null;
    grid.setPointerCapture(e.pointerId);
    grid.classList.add("dragging");
    markDragRow();
  });

  grid.addEventListener("pointermove", (e) => {
    if (!dragCarId) return;
    e.preventDefault();
    const over = document.elementFromPoint(e.clientX, e.clientY);
    const row = over && over.closest("[data-carrow]");
    const id = row ? row.dataset.carrow : null;
    if (id !== dragOverId) { dragOverId = id; markDragRow(); }
  });

  const finish = async (e) => {
    if (!dragCarId) return;
    const from = dragCarId, to = dragOverId;
    dragCarId = null; dragOverId = null;
    grid.classList.remove("dragging");
    try { grid.releasePointerCapture(e.pointerId); } catch {}
    clearDragMarks();
    if (to && to !== from) await commitCarOrder(from, to);
  };

  grid.addEventListener("pointerup", finish);
  grid.addEventListener("pointercancel", finish);
}

function markDragRow() {
  clearDragMarks();
  if (dragCarId) {
    const r = root.querySelector(`[data-carrow="${dragCarId}"]`);
    if (r) r.classList.add("drag-source");
  }
  if (dragOverId && dragOverId !== dragCarId) {
    const r = root.querySelector(`[data-carrow="${dragOverId}"]`);
    if (r) r.classList.add("drag-target");
  }
}

function clearDragMarks() {
  root.querySelectorAll(".drag-source, .drag-target")
    .forEach(n => n.classList.remove("drag-source", "drag-target"));
}

// Moves one car to another's position and renumbers the whole fleet, so the
// order is stable and shared with everyone in the company.
async function commitCarOrder(fromId, toId) {
  const list = orderedCars();
  const fromIdx = list.findIndex(c => c.id === fromId);
  const toIdx = list.findIndex(c => c.id === toId);
  if (fromIdx < 0 || toIdx < 0) return;

  const [moved] = list.splice(fromIdx, 1);
  list.splice(toIdx, 0, moved);

  setSync("saving");
  try {
    const batch = writeBatch(db);
    list.forEach((c, i) => {
      if (c.sortOrder !== i) batch.update(doc(db, "cars", c.id), { sortOrder: i });
    });
    await batch.commit();
  } catch (e) {
    alert("Couldn't save the new order (" + (e.code || e.message) + ").");
    setSync("error");
  }
}
