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
  el, val, closeModal,
  bookingRef,
  requestFocus,
  invoiceTotal,
  findClash, describeInterval, hasManualTotal, rateFor, rentalDays,
  showToast, openModal, showError
} from "./store.js";

let root = null;
let filter = "all";


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

// Drag across empty days to book a range. Holds the dates of the window
// currently drawn, so a day index can be turned back into a date.
let lastRenderedDays = [];
let cellDrag = null;

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
      if (root.classList.contains("active")) render();
    }, 150);
  });

  setupCarDragging();


  // Clicking a booking bar in the timeline opens it for editing
  el(root, "timeline").addEventListener("click", (e) => {
    const link = e.target.closest(".tl-carlink");
    if (link) {
      requestFocus("fleet", link.dataset.car);
      location.hash = "#fleet";
      return;
    }

    const bar = e.target.closest("[data-booking]");
    if (bar) { openBookingModal(bar.dataset.booking); return; }

    // Clicking an empty day opens a new booking with that car and date
    // already filled in, so there is no need to pick them again.
    const cell = e.target.closest("[data-add-car]");
    if (cell) openBookingModal(null, { carId: cell.dataset.addCar, date: cell.dataset.addDate });
  });

  wireDragToBook();
  wireBookingMove();

  el(root, "cal-prev").addEventListener("click", () => {
    timelineAnchor.setDate(timelineAnchor.getDate() - 7);
    reanchored = true;
    render();
  });
  el(root, "cal-next").addEventListener("click", () => {
    timelineAnchor.setDate(timelineAnchor.getDate() + 7);
    reanchored = true;
    render();
  });
  // Reaching 2027 by pressing Next twenty-six times is not reasonable. A month
  // input jumps straight to any month of any year, and on a phone it opens the
  // native month-and-year wheel rather than a text field.
  buildJumpOptions();
  el(root, "jump-month").addEventListener("change", jumpToChosenMonth);
  el(root, "jump-year").addEventListener("change", jumpToChosenMonth);

  el(root, "cal-today").addEventListener("click", () => {
    timelineAnchor = freshAnchor();
    reanchored = true;
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


function stateLabel(s) {
  return { "active-b": "Active", upcoming: "Upcoming", overdue: "Overdue", completed: "Completed" }[s] || s;
}

export function render() {
  if (!root) return;
  if (showSummary) renderStats();
  renderTimeline();
  fitPlannerHeight();
  // After the planner is drawn, so the readout can measure a laid-out element.
  syncZoomLabel();
  syncJumpSelects();
  updateToggleLabels();
  // A closed panel is not drawn at all, so a long booking list costs nothing
  // while it is put away.
  if (showList) renderList();
}

// ---------- Jump to a month ----------
// Reaching next March by pressing Next twenty-odd times is not reasonable, so
// the month and year can be picked directly. Two selects rather than a month
// input, because Safari does not support that input and shows an empty text box
// instead — which is worse than having no control at all, since it looks like
// something that ought to work.

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun",
                     "Jul","Aug","Sep","Oct","Nov","Dec"];
const JUMP_YEARS_BACK = 1;
const JUMP_YEARS_FORWARD = 3;

function buildJumpOptions() {
  const thisYear = new Date().getFullYear();
  el(root, "jump-month").innerHTML =
    MONTH_NAMES.map((m, i) => `<option value="${i}">${m}</option>`).join("");

  const years = [];
  for (let y = thisYear - JUMP_YEARS_BACK; y <= thisYear + JUMP_YEARS_FORWARD; y++) years.push(y);
  el(root, "jump-year").innerHTML =
    years.map(y => `<option value="${y}">${y}</option>`).join("");
}

// Keeps the two selects showing where the planner currently is, so they read as
// a position rather than an empty control waiting for input.
function syncJumpSelects() {
  const d = timelineAnchor || new Date();
  const ms = el(root, "jump-month");
  const ys = el(root, "jump-year");
  if (!ms || !ys) return;
  ms.value = String(d.getMonth());
  // Only if that year is on the list; scrolling far out should not blank it.
  if ([...ys.options].some(o => o.value === String(d.getFullYear()))) {
    ys.value = String(d.getFullYear());
  }
}

function jumpToChosenMonth() {
  const monthIndex = Number(el(root, "jump-month").value);
  const year = Number(el(root, "jump-year").value);
  if (!Number.isInteger(monthIndex) || !Number.isInteger(year)) return;

  timelineAnchor = new Date(year, monthIndex, 1);
  reanchored = true;            // a new window starts at its first day
  render();
}

// ---------- Drag a booking onto another car ----------
// Moving a rental to a different vehicle is a normal thing to need — a car comes
// back damaged, or a better one frees up. Dragging the bar is the obvious
// gesture, but it changes what the customer is charged, so it always stops for
// confirmation rather than acting on the drop.
//
// Mouse and trackpad only, like the other planner drags: on a touchscreen this
// gesture scrolls the planner.

let barDrag = null;
let pendingMove = null;

function wireBookingMove() {
  const grid = el(root, "timeline");
  if (!grid) return;

  grid.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch" || e.button !== 0) return;
    const bar = e.target.closest("[data-booking]");
    if (!bar) return;

    barDrag = {
      bookingId: bar.dataset.booking,
      fromRow: bar.style.gridRow,
      moved: false,
      pointerId: e.pointerId,
      startY: e.clientY
    };
    try { grid.setPointerCapture(e.pointerId); } catch {}
  });

  grid.addEventListener("pointermove", (e) => {
    if (!barDrag) return;
    // A threshold, so a slightly unsteady click is still a click. Vertical
    // movement only: dragging sideways is how you would adjust dates, which this
    // does not do, and treating it as a move would be a nasty surprise.
    if (!barDrag.moved && Math.abs(e.clientY - barDrag.startY) < 8) return;

    const under = document.elementFromPoint(e.clientX, e.clientY);
    const cell = under && under.closest && under.closest("[data-add-car]");
    grid.querySelectorAll(".tl-cell.move-target").forEach(c => c.classList.remove("move-target"));
    if (!cell) return;

    const b = state.bookings.find(x => x.id === barDrag.bookingId);
    if (!b || cell.dataset.addCar === b.carId) return;   // its own row does nothing

    barDrag.moved = true;
    barDrag.toCarId = cell.dataset.addCar;
    grid.classList.add("moving-bar");
    grid.querySelectorAll(`[data-row="${cell.dataset.row}"]`)
        .forEach(c => c.classList.add("move-target"));
    e.preventDefault();
  });

  const finish = () => {
    if (!barDrag) return;
    const drag = barDrag;
    barDrag = null;
    try { grid.releasePointerCapture(drag.pointerId); } catch {}
    grid.classList.remove("moving-bar");
    grid.querySelectorAll(".tl-cell.move-target").forEach(c => c.classList.remove("move-target"));
    if (!drag.moved || !drag.toCarId) return;

    // Otherwise the click that follows opens the booking form on top of this.
    grid.addEventListener("click", ev => {
      ev.preventDefault(); ev.stopPropagation();
    }, { capture: true, once: true });

    askToMove(drag.bookingId, drag.toCarId);
  };

  grid.addEventListener("pointerup", finish);
  grid.addEventListener("pointercancel", () => {
    barDrag = null;
    grid.classList.remove("moving-bar");
    grid.querySelectorAll(".tl-cell.move-target").forEach(c => c.classList.remove("move-target"));
  });

  el(root, "move-confirm").addEventListener("click", doMove);
  root.querySelectorAll('[data-close="move-modal"]').forEach(b =>
    b.addEventListener("click", () => { pendingMove = null; closeModal(root, "move-modal"); }));
}

function askToMove(bookingId, toCarId) {
  const b = state.bookings.find(x => x.id === bookingId);
  const toCar = state.cars.find(c => c.id === toCarId);
  if (!b || !toCar) return;

  // Checked before anything is asked: there is no point offering a price choice
  // for a move that cannot happen.
  const clash = findClash({
    carId: toCarId,
    startAt: `${b.startDate}T${startTime(b)}`,
    endAt: `${b.endDate}T${endTime(b)}`,
    ignoreId: bookingId
  });
  if (clash) {
    showToast(`${toCar.make} ${toCar.model} is already out ${describeInterval(clash)} (${clash.renter})`, "warn");
    return;
  }

  const toName = `${toCar.year || ""} ${toCar.make} ${toCar.model} (${toCar.plate || "no plate"})`.trim();
  const newRate = toCar.dailyRate || 0;
  const days = rentalDays(b);

  pendingMove = { bookingId, toCarId, toName, newRate };

  el(root, "move-summary").innerHTML = `
    <div class="jd-row"><span class="jd-k">Booking</span><span class="jd-v">${esc(bookingRef(b))} · ${esc(b.renter || "")}</span></div>
    <div class="jd-row"><span class="jd-k">Dates</span><span class="jd-v">${formatDate(b.startDate)} – ${formatDate(b.endDate)} (${days} day${days === 1 ? "" : "s"})</span></div>
    <div class="jd-row"><span class="jd-k">From</span><span class="jd-v">${esc(bookingCarLabel(b))}</span></div>
    <div class="jd-row"><span class="jd-k">To</span><span class="jd-v">${esc(toName)}</span></div>`;

  const keptTotal = rentalTotal(b);
  el(root, "move-keep-label").textContent = hasManualTotal(b)
    ? `Keep the agreed price — ${formatAmount(keptTotal)}`
    : `Keep the agreed rate — ${formatAmount(rateFor(b))}/day, ${formatAmount(keptTotal)}`;

  const newTotal = days * newRate;
  const newOpt = el(root, "move-new");
  el(root, "move-new-label").textContent = newRate > 0
    ? `Use this car's rate — ${formatAmount(newRate)}/day, ${formatAmount(newTotal)}`
    : "This car has no daily rate set";
  newOpt.disabled = newRate <= 0;

  el(root, "move-keep").checked = true;
  showError(root, "move-error", null);
  openModal(root, "move-modal");
}

async function doMove() {
  if (!pendingMove) return;
  const { bookingId, toCarId, toName, newRate } = pendingMove;
  const useNewRate = el(root, "move-new").checked;

  const btn = el(root, "move-confirm");
  btn.disabled = true; btn.textContent = "Moving...";
  setSync("saving");
  try {
    const update = { carId: toCarId, carName: toName };
    if (useNewRate) {
      // Clearing any agreed total as well, or the new rate would be recorded but
      // the invoice would go on using the old fixed price and quietly disagree.
      update.dailyRate = newRate;
      update.totalPrice = null;
    }
    await updateDoc(doc(db, "bookings", bookingId), update);
    closeModal(root, "move-modal");
    pendingMove = null;
    showToast(`Moved to ${toName}`);
  } catch (e) {
    showError(root, "move-error", "Couldn't move it (" + (e.code || e.message) + "). Try again.");
    setSync("error");
  }
  btn.disabled = false; btn.textContent = "Move booking";
}

// ---------- Drag across days to book a range ----------
// Pressing on an empty day and dragging sideways sets both dates at once, which
// is how the range is thought about anyway — "this car, these days" — rather
// than opening the form and typing two dates that are already on screen.
//
// Mouse and trackpad only. On a touchscreen the same gesture is how you scroll
// the planner sideways, and taking that over would make the planner unusable to
// gain a shortcut nobody can discover on a phone. Tapping a day still works
// there, exactly as before.

function wireDragToBook() {
  const grid = el(root, "timeline");
  if (!grid) return;

  grid.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch") return;
    if (e.button !== 0) return;                       // left button only
    const cell = e.target.closest("[data-add-car]");
    if (!cell) return;                                // a bar, a car name, or a gap

    cellDrag = {
      carId: cell.dataset.addCar,
      row: cell.dataset.row,
      from: Number(cell.dataset.idx),
      to: Number(cell.dataset.idx),
      moved: false,
      pointerId: e.pointerId
    };
    grid.classList.add("picking-range");
    // Without capture the drag dies the moment the pointer crosses a bar or
    // leaves the grid, which happens constantly on a busy planner.
    try { grid.setPointerCapture(e.pointerId); } catch {}
  });

  grid.addEventListener("pointermove", (e) => {
    if (!cellDrag) return;
    // elementFromPoint rather than the event target: with the pointer captured
    // every move reports the grid itself, not the cell underneath.
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const cell = under && under.closest && under.closest("[data-add-car]");
    // Staying on the same vehicle keeps the gesture meaning one thing; dragging
    // diagonally across rows would be ambiguous about which car was intended.
    if (!cell || cell.dataset.row !== cellDrag.row) return;

    const idx = Number(cell.dataset.idx);
    if (idx === cellDrag.to) return;
    cellDrag.to = idx;
    cellDrag.moved = true;
    e.preventDefault();
    paintDragPreview();
  });

  const finish = (e) => {
    if (!cellDrag) return;
    const drag = cellDrag;
    cellDrag = null;
    try { grid.releasePointerCapture(drag.pointerId); } catch {}
    clearDragPreview();

    if (!drag.moved) return;                          // a plain click; leave it be

    const lo = Math.min(drag.from, drag.to);
    const hi = Math.max(drag.from, drag.to);
    const start = lastRenderedDays[lo];
    const end = lastRenderedDays[hi];
    if (!start || !end) return;

    // The click that follows a drag would otherwise open the form a second time
    // on whichever day the pointer happened to be over.
    grid.addEventListener("click", ev => {
      ev.preventDefault(); ev.stopPropagation();
    }, { capture: true, once: true });

    openBookingModal(null, { carId: drag.carId, date: start, endDate: end });
  };

  grid.addEventListener("pointerup", finish);
  grid.addEventListener("pointercancel", () => {
    cellDrag = null;
    clearDragPreview();
  });

  // Escape abandons a drag in progress rather than committing it.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && cellDrag) {
      cellDrag = null;
      clearDragPreview();
    }
  });
}

function clearDragPreview() {
  const grid = el(root, "timeline");
  if (!grid) return;
  grid.classList.remove("picking-range");
  grid.querySelectorAll(".tl-cell.picking").forEach(c => c.classList.remove("picking"));
  const bar = grid.querySelector(".tl-drag-preview");
  if (bar) bar.remove();
}

function paintDragPreview() {
  const grid = el(root, "timeline");
  if (!grid || !cellDrag) return;
  clearDragPreview();

  const lo = Math.min(cellDrag.from, cellDrag.to);
  const hi = Math.max(cellDrag.from, cellDrag.to);

  grid.querySelectorAll(`[data-row="${cellDrag.row}"]`).forEach(c => {
    const i = Number(c.dataset.idx);
    if (i >= lo && i <= hi) c.classList.add("picking");
  });

  // A bar in the same shape as a real booking, so what is being drawn is
  // obviously the booking that is about to exist.
  const days = hi - lo + 1;
  const bar = document.createElement("div");
  bar.className = "tl-drag-preview";
  bar.style.gridRow = cellDrag.row;
  bar.style.gridColumn = `${lo * 2 + 2} / ${hi * 2 + 4}`;
  bar.textContent = days === 1 ? "1 day" : `${days} days`;
  grid.appendChild(bar);
}

// ---------- Planner height ----------
// The planner has to be its own scrolling box, or the frozen date row has
// nothing to stay pinned to. That means it needs a height — and a guessed
// height is either wasteful or too short, because what sits above it changes
// (the Summary panel opens and closes, and windows differ). So it is measured:
// fill everything from the planner's top edge to the bottom of the window.
// The planner fills the space between its own top edge and the bottom of the
// window. It cannot exceed that: the date row stays frozen by being sticky inside
// this frame, which only holds while the frame is on screen, so a frame taller
// than the window would scroll its own top away and take the dates with it.
// Height is therefore won by taking space off what sits above the planner, not by
// letting the planner spill past the window.
// The planner is a window's worth of height rather than "whatever is left below
// the header". So at rest its bottom hangs below the fold — the page is longer,
// which is the trade — and scrolling down by the height of the header brings the
// whole planner into the window with the date row along its top edge. That is the
// position you actually work in, and it is where the extra rows show up.
//
// A window's height is the ceiling and this reaches it. Going beyond would mean
// scrolling the frame's own top off screen to see its lower rows, and the frozen
// date row would go with it, since it is pinned inside this frame rather than to
// the window.
const PLANNER_VIEWPORT_AIR = 24;  // a little air so it does not touch the edges
const PLANNER_MIN_HEIGHT = 320;   // a short window still gets a usable planner

function fitPlannerHeight() {
  const wrap = el(root, "timeline-wrap");
  if (!wrap) return;
  const available = window.innerHeight - PLANNER_VIEWPORT_AIR;
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
      // row and day index are carried on the cell so a drag can work out which
      // span it covers without having to measure anything on screen.
      html += `<div class="tl-cell addable ${cls}" data-add-car="${car.id}" data-add-date="${ds}"
        data-row="${row}" data-idx="${i2}"
        title="Drag across days to book a range, or click for a single day"
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
          `${formatAmount(invoiceTotal(b))} · ${b.paid ? "Paid" : "Unpaid"}` +
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
  // Kept for the drag-to-book handler, which needs to turn a day index back into
  // a date after the grid has been built.
  lastRenderedDays = days.map(dstr);

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
          <div class="card-sub">${esc(bookingCarLabel(b))} · <span class="ref">${esc(bookingRef(b))}</span></div>
        </div>
        <span class="badge ${s}">${stateLabel(s)}</span>
      </div>
      <div class="card-details">
        <span>Out: <strong>${formatDate(b.startDate)} ${startTime(b)}</strong>${b.pickupLocation ? " · " + esc(b.pickupLocation) : ""}</span>
        <span>Back: <strong>${formatDate(b.endDate)} ${endTime(b)}</strong>${b.dropoffLocation ? " · " + esc(b.dropoffLocation) : ""}</span>
        <span>Total: <strong>${formatAmount(invoiceTotal(b))}</strong> ${b.paid ? "(paid)" : "(unpaid)"}</span>
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
