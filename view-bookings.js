// Bookings view — calendar and reservations with conflict prevention.
//
// The add/edit booking dialog itself lives in booking-form.js, shared with the
// dashboard planner, so both screens open the same form and validate the same way.
import { openBookingModal } from "./booking-form.js";
import { db, setSync } from "./firebase-init.js";
import { updateDoc, deleteDoc, doc, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  state, onDataChange, esc, formatDate, formatAmount, todayStr, bookingCarLabel, bookingState,
  sharesStartHandover, sharesEndHandover, serviceDue, initPanelToggle,
  orderedCars, loadPref, savePref,
  startTime, endTime, pickupLabel, dropoffLabel, rentalTotal,
  el, val, closeModal,
  bookingRef,
  requestFocus,
  invoiceTotal,
  findClash, describeInterval, hasManualTotal, rateFor, rentalDays, fxPair, extrasTotal, deleteBookingWarning,
  carStatus, fillTimeOptions, getTime, setTime,
  showToast, openModal, showError,
  setVal
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

// ---------- The pinned month ----------
// The corner of the planner — where the car column meets the date strip —
// names the month on screen, the way a wall planner prints it in its corner.
// It stays put while the planner scrolls sideways, and the label changes the
// moment the first visible column crosses into the next month.
let tlMonthDays = [];   // the rendered window, as Date objects
let tlMonthHalf = 60;   // half-column width in px at the current zoom

function updateTlMonth() {
  if (!root || tlMonthDays.length === 0) return;
  const label = root.querySelector(".tl-month");
  const wrap = el(root, "timeline-wrap");
  if (!label || !wrap) return;
  // Which day sits at the left edge right now. Columns only compress to their
  // stated width when the grid is wider than its frame — which is the only
  // time it can scroll — so the arithmetic and the pixels always agree.
  const idx = Math.min(tlMonthDays.length - 1,
    Math.max(0, Math.round(wrap.scrollLeft / (tlMonthHalf * 2))));
  const d = tlMonthDays[idx];
  label.textContent = `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}
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
  el(root, "toggle-list").addEventListener("click", () => togglePanel("list"));

  el(root, "search").addEventListener("input", () => { jumpToSearchMatch(); render(); });
  el(root, "planner-xls").addEventListener("click", exportPlannerXls);

  // The date strip's status-bar mask applies only while pinned: a 1px
  // sentinel above it leaves the viewport exactly when the strip reaches the
  // top, and the class follows. At rest there is no mask and no dead space.
  {
    const sentinel = el(root, "tl-pin-sentinel");
    const wrap = el(root, "timeline-head-wrap");
    if (sentinel && wrap && "IntersectionObserver" in window) {
      new IntersectionObserver(([e]) =>
        wrap.classList.toggle("hdr-pinned", !e.isIntersecting && e.boundingClientRect.top < 0)
      ).observe(sentinel);
    }
  }


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
  wireAvailability();

  // The sticky date strip never scrolls on its own — it mirrors the planner
  // body's sideways position, so the day columns stay lined up while the strip
  // itself stays pinned to the top of the page.
  {
    const bodyWrap = el(root, "timeline-wrap");
    const headWrap = el(root, "timeline-head-wrap");
    if (bodyWrap && headWrap) {
      bodyWrap.addEventListener("scroll", () => {
        headWrap.scrollLeft = bodyWrap.scrollLeft;
        updateTlMonth();
      });
    }
  }

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
    if (btn) {
      const id = btn.dataset.id;
      if (btn.dataset.act === "complete") completeBooking(id);
      else if (btn.dataset.act === "edit") openBookingModal(id);
      else if (btn.dataset.act === "delete") deleteBooking(id);
      return;
    }
    // Tapping anywhere on the card opens the booking.
    if (e.target.closest("input, select, textarea, a")) return;
    const card = e.target.closest("[data-booking-card]");
    if (card) openBookingModal(card.dataset.bookingCard);
  });

  onDataChange(() => { if (root.classList.contains("active")) render(); });
}


function stateLabel(s) {
  return { "active-b": "Active", upcoming: "Upcoming", overdue: "Overdue", completed: "Completed" }[s] || s;
}

export function render() {
  if (!root) return;
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
  // Read three days into the window, not its first day: the window deliberately
  // starts 3 days back for context, so on the 1st–3rd of a month the first
  // column is still last month — and the dropdowns reading "Jul" on August 1st
  // looks stuck rather than truthful. Three days in is today for the default
  // anchor, and still the chosen month after a jump (which lands on the 1st).
  const base = timelineAnchor || new Date();
  const d = new Date(base);
  d.setDate(d.getDate() + 3);
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

// The day cells sit underneath the booking bars, so elementFromPoint — which
// returns only the topmost element — hands back a bar whenever the pointer is
// over one. During a drag it almost always is: the bar being dragged, or one in
// the row being dragged onto. The cell was never found and the drag did nothing.
//
// elementsFromPoint returns the whole stack at that point, so the cell can be
// picked out from underneath.
function nodeAtPoint(x, y, selector) {
  const stack = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [];
  for (const node of stack) {
    const hit = node.closest && node.closest(selector);
    if (hit) return hit;
  }
  // Older browsers without elementsFromPoint still get the simple behaviour.
  const one = document.elementFromPoint(x, y);
  return one && one.closest ? one.closest(selector) : null;
}

const cellAtPoint = (x, y) => nodeAtPoint(x, y, "[data-add-car]");

// ---------- Drag a booking to another car, another date, or both ----------
// Moving a rental is a normal thing to need — a car comes back damaged, a
// better one frees up, or the customer simply postpones. Dragging the bar is
// the obvious gesture: sideways shifts the whole rental to new dates (same
// length, so the price never changes by itself), up or down moves it to a
// different car (which can change the rate, so that opens the price dialog),
// and a diagonal drag does both at once.
//
// Either way it always stops for confirmation rather than acting on the drop,
// and the double-booking check runs against the new position first.
//
// Mouse and trackpad only, like the other planner drags: on a touchscreen this
// gesture scrolls the planner.

let barDrag = null;
let pendingMove = null;

// A date N days away, computed at midday so time zones can't slide it a day.
function addDaysStr(ds, n) {
  const d = new Date(ds + "T12:00");
  d.setDate(d.getDate() + n);
  return dstr(d);
}

// ---------- Check availability ----------
// The desk's question — "have we got anything free from the 5th to the 9th?" —
// answered as a list instead of squinting along the planner for blank
// stretches. Every car is judged with the same clash check bookings use, so
// this can never disagree with what saving a booking would say. Free cars get
// a Book button that opens the form already filled in.

function wireAvailability() {
  const btn = el(root, "check-avail");
  if (!btn) return;

  fillTimeOptions(root, "av-start-time");
  fillTimeOptions(root, "av-end-time");

  btn.addEventListener("click", () => {
    const today = todayStr();
    setVal(root, "av-start", today);
    setVal(root, "av-end", addDaysStr(today, 1));
    setTime(root, "av-start-time", "12:00");
    setTime(root, "av-end-time", "12:00");
    showError(root, "avail-error", null);
    renderAvailability();
    openModal(root, "avail-modal");
  });

  el(root, "av-start").addEventListener("change", () => {
    // picking a future start usually means checking that date onward — if the
    // end is now behind it, follow to start+1 instead of showing an error
    const s2 = val(root, "av-start");
    if (s2 && val(root, "av-end") <= s2) setVal(root, "av-end", addDaysStr(s2, 1));
    renderAvailability();
  });
  el(root, "av-end").addEventListener("change", renderAvailability);
  ["av-start-time-h", "av-start-time-m", "av-end-time-h", "av-end-time-m"].forEach(name =>
    el(root, name).addEventListener("change", renderAvailability));

  root.querySelectorAll('[data-close="avail-modal"]').forEach(b =>
    b.addEventListener("click", () => closeModal(root, "avail-modal")));

  el(root, "avail-results").addEventListener("click", (e) => {
    const book = e.target.closest("[data-book]");
    if (!book) return;
    const preset = {
      carId: book.dataset.book,
      date: val(root, "av-start"),
      endDate: val(root, "av-end"),
      startTime: getTime(root, "av-start-time"),
      endTime: getTime(root, "av-end-time")
    };
    closeModal(root, "avail-modal");
    openBookingModal(null, preset);
  });
}

function renderAvailability() {
  const box = el(root, "avail-results");
  if (!box) return;
  const start = val(root, "av-start");
  const end = val(root, "av-end");
  if (!start || !end) { box.innerHTML = ""; return; }

  const startAt = `${start}T${getTime(root, "av-start-time")}`;
  const endAt = `${end}T${getTime(root, "av-end-time")}`;
  if (endAt <= startAt) {
    showError(root, "avail-error", "The end has to come after the start.");
    box.innerHTML = "";
    return;
  }
  showError(root, "avail-error", null);

  const free = [];
  const busy = [];
  orderedCars().forEach(c => {
    if (carStatus(c) === "service") {
      busy.push({ car: c, why: "out of service" });
      return;
    }
    const clash = findClash({ carId: c.id, startAt, endAt });
    if (clash) busy.push({ car: c, why: `${describeInterval(clash)} (${clash.renter || ""})` });
    else free.push(c);
  });

  const carLine = c =>
    `${c.year || ""} ${c.make} ${c.model}`.trim() + ` (${c.plate || "no plate"})` +
    (c.category ? ` · ${c.category}` : "");

  box.innerHTML = `
    <p style="margin:0 0 8px;"><strong>${free.length}</strong> of ${free.length + busy.length} cars available</p>
    ${free.map(c => `
      <div class="jd-row" style="align-items:center;">
        <span class="jd-v">${esc(carLine(c))}${c.dailyRate ? ` — ${esc(formatAmount(c.dailyRate))}/day` : ""}</span>
        <button class="btn" data-book="${c.id}">Book</button>
      </div>`).join("")}
    ${free.length === 0 ? `<p style="color:var(--muted);">Nothing free for these dates.</p>` : ""}
    ${busy.length ? `
      <p style="margin:14px 0 6px;color:var(--muted);">Not available</p>
      ${busy.map(x => `
        <div class="jd-row">
          <span class="jd-v" style="color:var(--muted);">${esc(carLine(x.car))} — ${esc(x.why)}</span>
        </div>`).join("")}` : ""}`;
}

// The little date tag that follows the cursor during planner drags, so a
// drop is never a guess: moving a bar shows the dates it would land on (and
// the car, when that changes); dragging out a new range shows the range.
// One element for the whole page, module-level, created on first use.
let dragTip = null;

function ensureDragTip() {
  if (dragTip) return dragTip;
  dragTip = document.createElement("div");
  dragTip.className = "drag-tip";
  document.body.appendChild(dragTip);
  return dragTip;
}

function showDragTip(x, y, text) {
  const t = ensureDragTip();
  t.textContent = text;
  t.classList.add("on");
  const pad = 14;
  let left = x + pad, top = y + pad;
  if (left + t.offsetWidth > window.innerWidth - 8) left = x - t.offsetWidth - pad;
  if (top + t.offsetHeight > window.innerHeight - 8) top = y - t.offsetHeight - pad;
  t.style.left = left + "px";
  t.style.top = top + "px";
}

function hideDragTip() {
  if (dragTip) dragTip.classList.remove("on");
}

function wireBookingMove() {
  const grid = el(root, "timeline");
  if (!grid) return;

  grid.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch" || e.button !== 0) return;
    const bar = e.target.closest("[data-booking]");
    if (!bar) return;

    // The day cell under the pointer marks where the bar was picked up, so a
    // sideways drag can be measured in whole days rather than pixels.
    const grabCell = cellAtPoint(e.clientX, e.clientY);

    barDrag = {
      bookingId: bar.dataset.booking,
      s0: Number(bar.dataset.s0),
      e0: Number(bar.dataset.e0),
      grabIdx: grabCell ? Number(grabCell.dataset.idx) : null,
      moved: false,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY
    };
    // Captured only once it is a real drag, or the click that follows would be
    // retargeted to the grid and tapping a booking would stop opening it.
  });

  grid.addEventListener("pointermove", (e) => {
    if (!barDrag) return;
    // A threshold in either direction, so a slightly unsteady click stays a click.
    if (!barDrag.moved &&
        Math.abs(e.clientY - barDrag.startY) < 8 &&
        Math.abs(e.clientX - barDrag.startX) < 8) return;

    const cell = cellAtPoint(e.clientX, e.clientY);
    grid.querySelectorAll(".tl-cell.move-target").forEach(c => c.classList.remove("move-target"));
    if (!cell) { barDrag.toCarId = null; hideDragTip(); return; }   // off the grid: no target

    const b = state.bookings.find(x => x.id === barDrag.bookingId);
    if (!b) return;

    const idx = Number(cell.dataset.idx);
    const delta = barDrag.grabIdx === null ? 0 : idx - barDrag.grabIdx;
    const toCarId = cell.dataset.addCar;
    // Same car, same days: not a move. Cleared, not merely skipped — otherwise
    // dragging away and back would drop on whatever was hovered last.
    if (delta === 0 && toCarId === b.carId) { barDrag.toCarId = null; hideDragTip(); return; }

    if (!barDrag.moved) {
      try { grid.setPointerCapture(e.pointerId); } catch {}
    }
    barDrag.moved = true;
    barDrag.toCarId = toCarId;
    barDrag.delta = delta;
    grid.classList.add("moving-bar");

    // Paint the span the booking would occupy after the drop, clamped to the
    // visible window, so the drag reads as "the rental will sit here".
    const lo = Math.max(0, barDrag.s0 + delta);
    const hi = Math.min(lastRenderedDays.length - 1, barDrag.e0 + delta);
    grid.querySelectorAll(`[data-row="${cell.dataset.row}"]`).forEach(c => {
      const i = Number(c.dataset.idx);
      if (i >= lo && i <= hi) c.classList.add("move-target");
    });

    const newStart = addDaysStr(b.startDate, delta);
    const newEnd = addDaysStr(b.endDate, delta);
    const toCar = toCarId !== b.carId ? state.cars.find(c => c.id === toCarId) : null;
    showDragTip(e.clientX, e.clientY,
      `${formatDate(newStart)} – ${formatDate(newEnd)}${toCar ? ` → ${toCar.make} ${toCar.model}` : ""}`);
    e.preventDefault();
  });

  const finish = () => {
    if (!barDrag) return;
    const drag = barDrag;
    barDrag = null;
    if (drag.moved) { try { grid.releasePointerCapture(drag.pointerId); } catch {} }
    grid.classList.remove("moving-bar");
    grid.querySelectorAll(".tl-cell.move-target").forEach(c => c.classList.remove("move-target"));
    hideDragTip();
    if (!drag.moved || !drag.toCarId) return;

    // Otherwise the click that follows opens the booking form on top of this.
    grid.addEventListener("click", ev => {
      ev.preventDefault(); ev.stopPropagation();
    }, { capture: true, once: true });

    const b = state.bookings.find(x => x.id === drag.bookingId);
    if (!b) return;

    if (drag.toCarId === b.carId) {
      // Same car, new dates: length and price unchanged, so a plain
      // confirmation is enough.
      askToShiftDates(b, drag.delta || 0);
    } else {
      // Another car, possibly new dates too: the rate can change, so this goes
      // through the price dialog, carrying the date shift with it.
      askToMove(drag.bookingId, drag.toCarId, drag.delta || 0);
    }
  };

  grid.addEventListener("pointerup", finish);
  // A cancel that arrives before any movement is almost always the browser
  // starting a text selection rather than the user giving up, and dropping the
  // drag there is why this appeared to do nothing at all. Once a drag is
  // genuinely under way a cancel is real and is honoured.
  grid.addEventListener("pointercancel", () => {
    if (barDrag && !barDrag.moved) return;
    barDrag = null;
    grid.classList.remove("moving-bar");
    grid.querySelectorAll(".tl-cell.move-target").forEach(c => c.classList.remove("move-target"));
    hideDragTip();
  });

  ["move-keep", "move-new", "move-custom"].forEach(name =>
    el(root, name).addEventListener("change", () => {
      const custom = el(root, "move-custom").checked;
      el(root, "move-custom-row").style.display = custom ? "flex" : "none";
      if (custom) el(root, "move-custom-total").focus();
    }));

  el(root, "move-confirm").addEventListener("click", doMove);
  root.querySelectorAll('[data-close="move-modal"]').forEach(b =>
    b.addEventListener("click", () => { pendingMove = null; closeModal(root, "move-modal"); }));
}

// Shift a rental sideways on the same car: both dates move together, so the
// number of days — and with it the price — stays exactly as it was.
async function askToShiftDates(b, delta) {
  if (!delta) return;
  const newStart = addDaysStr(b.startDate, delta);
  const newEnd = addDaysStr(b.endDate, delta);

  const clash = findClash({
    carId: b.carId,
    startAt: `${newStart}T${startTime(b)}`,
    endAt: `${newEnd}T${endTime(b)}`,
    ignoreId: b.id
  });
  if (clash) {
    showToast(`That would clash with ${clash.renter} (${describeInterval(clash)})`, "warn");
    return;
  }

  if (!confirm(
    `Move ${b.renter || "this booking"} (${bookingRef(b)})\n` +
    `from ${formatDate(b.startDate)} – ${formatDate(b.endDate)}\n` +
    `to ${formatDate(newStart)} – ${formatDate(newEnd)}?\n\n` +
    `Same number of days — the price does not change.`
  )) return;

  setSync("saving");
  try {
    // Both dates move, so any task-only override is stale and is cleared —
    // the hand-over and collection follow the booking to its new days.
    const update = { startDate: newStart, endDate: newEnd };
    if (b.deliveryDate) update.deliveryDate = null;
    if (b.recoveryDate) update.recoveryDate = null;
    await updateDoc(doc(db, "bookings", b.id), update);
    showToast(`Moved to ${formatDate(newStart)} – ${formatDate(newEnd)}`);
  } catch (e) {
    alert("Couldn't move it (" + (e.code || e.message) + "). Try again.");
    setSync("error");
  }
}

function askToMove(bookingId, toCarId, dayDelta = 0) {
  const b = state.bookings.find(x => x.id === bookingId);
  const toCar = state.cars.find(c => c.id === toCarId);
  if (!b || !toCar) return;

  // The dates the booking will have after the drop — shifted when the drag was
  // diagonal, unchanged when it was straight up or down.
  const newStart = dayDelta ? addDaysStr(b.startDate, dayDelta) : b.startDate;
  const newEnd = dayDelta ? addDaysStr(b.endDate, dayDelta) : b.endDate;

  // Checked before anything is asked: there is no point offering a price choice
  // for a move that cannot happen.
  const clash = findClash({
    carId: toCarId,
    startAt: `${newStart}T${startTime(b)}`,
    endAt: `${newEnd}T${endTime(b)}`,
    ignoreId: bookingId
  });
  if (clash) {
    showToast(`${toCar.make} ${toCar.model} is already out ${describeInterval(clash)} (${clash.renter})`, "warn");
    return;
  }

  const toName = `${toCar.year || ""} ${toCar.make} ${toCar.model} (${toCar.plate || "no plate"})`.trim();
  const newRate = toCar.dailyRate || 0;
  const days = rentalDays(b);

  pendingMove = { bookingId, toCarId, toName, newRate, dayDelta, newStart, newEnd };

  el(root, "move-summary").innerHTML = `
    <div class="jd-row"><span class="jd-k">Booking</span><span class="jd-v">${esc(bookingRef(b))} · ${esc(b.renter || "")}</span></div>
    <div class="jd-row"><span class="jd-k">Dates</span><span class="jd-v">${formatDate(newStart)} – ${formatDate(newEnd)} (${days} day${days === 1 ? "" : "s"})${dayDelta ? " · moved from " + formatDate(b.startDate) : ""}</span></div>
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
  setVal(root, "move-custom-total", "");
  el(root, "move-custom-row").style.display = "none";
  el(root, "move-custom-hint").textContent = `for the whole ${days} day${days === 1 ? "" : "s"}`;

  showError(root, "move-error", null);
  openModal(root, "move-modal");
}

async function doMove() {
  if (!pendingMove) return;
  const { bookingId, toCarId, toName, newRate, dayDelta, newStart, newEnd } = pendingMove;
  const useNewRate = el(root, "move-new").checked;
  const useCustom = el(root, "move-custom").checked;

  let customTotal = null;
  if (useCustom) {
    const raw = val(root, "move-custom-total");
    customTotal = raw === "" ? null : parseFloat(raw);
    if (customTotal === null || !Number.isFinite(customTotal) || customTotal < 0) {
      showError(root, "move-error", "Enter the price for this rental, or pick one of the options above.");
      return;
    }
  }

  const btn = el(root, "move-confirm");
  btn.disabled = true; btn.textContent = "Moving...";
  setSync("saving");
  try {
    const update = { carId: toCarId, carName: toName };
    // A diagonal drag shifted the dates as well as the car; task-only
    // overrides are stale after a date change and go with it.
    if (dayDelta) {
      update.startDate = newStart; update.endDate = newEnd;
      const b = state.bookings.find(x => x.id === bookingId);
      if (b?.deliveryDate) update.deliveryDate = null;
      if (b?.recoveryDate) update.recoveryDate = null;
    }
    if (useNewRate) {
      // Clearing any agreed total as well, or the new rate would be recorded but
      // the invoice would go on using the old fixed price and quietly disagree.
      update.dailyRate = newRate;
      update.totalPrice = null;
    } else if (useCustom) {
      // The typed figure is the whole rental, so it is stored as the agreed
      // total. The daily rate is brought in line with the new car where it has
      // one, so the record does not keep quoting the old car's rate — the total
      // is what the invoice uses either way.
      update.totalPrice = customTotal;
      if (newRate > 0) update.dailyRate = newRate;
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
    // Capture is needed once dragging, or the drag dies the moment the pointer
    // crosses a bar. But taking it here retargets the click that follows to the
    // grid, so clicking a single day would stop opening the form. Taken on the
    // first real movement instead — see pointermove.
  });

  grid.addEventListener("pointermove", (e) => {
    if (!cellDrag) return;
    // Looked up by position rather than from the event target: once the pointer
    // is captured every move reports the grid itself, not the cell underneath.
    const cell = cellAtPoint(e.clientX, e.clientY);
    // Staying on the same vehicle keeps the gesture meaning one thing; dragging
    // diagonally across rows would be ambiguous about which car was intended.
    if (!cell || cell.dataset.row !== cellDrag.row) return;

    const idx = Number(cell.dataset.idx);
    if (idx === cellDrag.to) return;
    if (!cellDrag.moved) {
      grid.classList.add("picking-range");
      try { grid.setPointerCapture(e.pointerId); } catch {}
    }
    cellDrag.to = idx;
    cellDrag.moved = true;
    e.preventDefault();
    paintDragPreview();

    const lo = Math.min(cellDrag.from, cellDrag.to);
    const hi = Math.max(cellDrag.from, cellDrag.to);
    const s0 = lastRenderedDays[lo], e0 = lastRenderedDays[hi];
    if (s0 && e0) {
      const n = hi - lo + 1;
      showDragTip(e.clientX, e.clientY,
        `${formatDate(s0)} – ${formatDate(e0)} · ${n} day${n === 1 ? "" : "s"}`);
    }
  });

  const finish = (e) => {
    if (!cellDrag) return;
    const drag = cellDrag;
    cellDrag = null;
    if (drag.moved) { try { grid.releasePointerCapture(drag.pointerId); } catch {} }
    clearDragPreview();
    hideDragTip();

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

// The planner used to size itself to the window and scroll inside its own box.
// That created two nested vertical scrollbars — the wheel moved either the
// planner or the page depending on where the cursor hovered. The page owns all
// vertical scrolling now; nothing to fit. Clearing the inline style also
// removes any cap a previous version of this code left on the element.
function fitPlannerHeight() {
  const wrap = el(root, "timeline-wrap");
  if (wrap) wrap.style.maxHeight = "";
}

// ---------- Collapsible panels ----------
function applyPanels() {
  root.classList.toggle("hide-list", !showList);
  updateToggleLabels();
}

function togglePanel(which) {
  showList = !showList;
  savePref("bookingsShowList", showList);
  applyPanels();
  render();          // fills in whatever was just opened
}

function updateToggleLabels() {
  const n = filteredBookings().length;
  el(root, "toggle-list").textContent =
    `${showList ? "\u25be" : "\u25b8"} Booking list (${n})`;
}



// When a search matches bookings that are entirely outside the visible
// window, the window goes to them — the pilot searched a renter whose rental
// was in November while the planner sat on August, and the "result" was an
// invisible success. Rules: a match already on screen never moves the view;
// the target is the soonest upcoming match, or the most recent past one for
// customers whose rentals are behind us; the window opens two days early for
// context. Matching is on booking text (renter, locations) — a car-name match
// filters rows but shouldn't move the calendar.
// Drag the car column's right edge to make room for long car names — the
// pilot's ask (21 Aug). Pointer events cover mouse and touch; the width
// applies live to both grids (the frozen date row shares the columns) and
// saves on release. Double-click on the edge resets to the zoom default.
// The planner window as Excel — his "same format as on screen" (spreadsheet
// row, 24 Aug). The one format that carries CELL COLOURS without any new
// library is an HTML table saved as .xls: Excel and Google Sheets both open
// it, colours and all. Cars down the side, the visible days across, each
// booked day painted the chip's colour with the renter's name at its start.
function exportPlannerXls() {
  const days = [];
  for (let i = 0; i < timelineDays(); i++) {
    const d = new Date(timelineAnchor);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  const pad = n => String(n).padStart(2, "0");
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const cars = orderedCars().filter(c => !c.hidden);
  const esc2 = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  let html = `<table border="1"><tr><th>Car</th>` +
    days.map(d => `<th>${pad(d.getDate())}/${pad(d.getMonth() + 1)}</th>`).join("") + `</tr>`;
  cars.forEach(c => {
    html += `<tr><td><b>${esc2(bookingCarLabel({ carId: c.id }) || (c.make + " " + c.model))}</b> ${esc2(c.plate || "")}</td>`;
    days.forEach(d => {
      const ds = ymd(d);
      const b = state.bookings.find(x => x.carId === c.id && x.startDate <= ds && x.endDate >= ds);
      if (!b) { html += `<td></td>`; return; }
      const colour = b.colour || "#f5a623";
      const label = ds === b.startDate ? esc2(b.renter || "") : "";
      html += `<td style="background:${esc2(colour)};">${label}</td>`;
    });
    html += `</tr>`;
  });
  html += `</table>`;

  const blob = new Blob([`\ufeff<html><head><meta charset="UTF-8"></head><body>${html}</body></html>`],
    { type: "application/vnd.ms-excel" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `planner-${ymd(days[0])}.xls`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Tap a date in the header and its whole column tints — tap again (or tap
// another date) to move or clear it. Survives redraws. (Pilot's sheet, 23 Aug.)
let selectedDay = null;
function applyDayHighlight() {
  const grid = el(root, "timeline");
  const head = el(root, "timeline-head");
  [grid, head].forEach(g => g && g.querySelectorAll(".col-hl").forEach(n => n.classList.remove("col-hl")));
  if (!selectedDay || !grid) return;
  grid.querySelectorAll(`.tl-cell[data-add-date="${selectedDay}"]`).forEach(n => n.classList.add("col-hl"));
  if (head) {
    const dn = head.querySelector(`.tl-daynum[data-day="${selectedDay}"]`);
    if (dn) dn.classList.add("col-hl");
  }
}
function wireDayHighlight() {
  const head = el(root, "timeline-head");
  if (!head || head.dataset.dayWired) return;
  head.dataset.dayWired = "1";
  head.addEventListener("click", (e) => {
    const dn = e.target.closest(".tl-daynum");
    if (!dn || !dn.dataset.day) return;
    if (e.target.closest(".tl-colgrip")) return;
    selectedDay = selectedDay === dn.dataset.day ? null : dn.dataset.day;
    applyDayHighlight();
  });
}

function wireCarColumnDrag(grid) {
  if (grid.dataset.dragWired) return;
  grid.dataset.dragWired = "1";
  const EDGE = 8;
  let dragging = null;

  grid.addEventListener("pointerdown", (e) => {
    const car = e.target.closest(".tl-car");
    if (!car) return;
    const r = car.getBoundingClientRect();
    if (e.clientX < r.right - EDGE) return;
    dragging = { startX: e.clientX, startW: r.width };
    grid.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  grid.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const w = Math.round(Math.min(420, Math.max(110, dragging.startW + e.clientX - dragging.startX)));
    applyCarWidth(w);
  });
  const finish = () => {
    if (!dragging) return;
    dragging = null;
    const w = parseInt(el(root, "timeline").style.gridTemplateColumns) || 0;
    if (w) savePref("plannerCarW", w);
  };
  grid.addEventListener("pointerup", finish);
  grid.addEventListener("pointercancel", finish);

  // The visible handle in the frozen corner — the phone's way in, since the
  // column's bare edge loses every fight with touch scrolling (pilot, 22 Aug).
  const head = el(root, "timeline-head-wrap");   // the wrap holds the fixed corner overlay
  if (head && !head.dataset.gripWired) {
    head.dataset.gripWired = "1";
    head.addEventListener("pointerdown", (e) => {
      const grip = e.target.closest(".tl-colgrip");
      if (!grip) return;
      const corner = grip.closest(".tl-corner");
      dragging = { startX: e.clientX, startW: corner.getBoundingClientRect().width };
      head.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    head.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const w = Math.round(Math.min(420, Math.max(110, dragging.startW + e.clientX - dragging.startX)));
      applyCarWidth(w);
    });
    head.addEventListener("pointerup", finish);
    head.addEventListener("pointercancel", finish);
    head.addEventListener("dblclick", (e) => {
      if (!e.target.closest(".tl-colgrip")) return;
      savePref("plannerCarW", 0);
      render();
    });
  }
  grid.addEventListener("dblclick", (e) => {
    const car = e.target.closest(".tl-car");
    if (!car) return;
    const r = car.getBoundingClientRect();
    if (e.clientX < r.right - EDGE) return;
    savePref("plannerCarW", 0);
    render();
  });
}

function applyCarWidth(w) {
  const grid = el(root, "timeline");
  const head = el(root, "timeline-head");
  const rest = grid.style.gridTemplateColumns.replace(/^[\d.]+px/, w + "px");
  grid.style.gridTemplateColumns = rest;
  if (head) head.style.gridTemplateColumns = rest;
  const fixed = el(root, "tl-corner-fixed");
  if (fixed) fixed.style.width = w + "px";
}

function jumpToSearchMatch() {
  const q = el(root, "search").value.trim().toLowerCase();
  if (!q || !timelineAnchor) return;
  const matches = state.bookings.filter(b =>
    `${b.renter || ""} ${b.pickupLocation || ""} ${b.dropoffLocation || ""}`
      .toLowerCase().includes(q) && b.startDate && b.endDate);
  if (!matches.length) return;

  const pad = n => String(n).padStart(2, "0");
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const last = new Date(timelineAnchor);
  last.setDate(last.getDate() + timelineDays() - 1);
  const visFirst = ymd(timelineAnchor), visLast = ymd(last);
  if (matches.some(b => b.startDate <= visLast && b.endDate >= visFirst)) return;

  const t = todayStr();
  const upcoming = matches.filter(b => b.endDate >= t)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  const target = upcoming[0] ||
    matches.slice().sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
  const [y, m, d] = target.startDate.split("-").map(Number);
  timelineAnchor = new Date(y, m - 1, d - 2);
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
    // A previous render (another company on this device, or before a search)
    // left a pixel min-width on the grid; without clearing it the message sits
    // centred in a 2,800px box — pushed off-screen and clipped. First thing a
    // brand-new company would see.
    grid.style.minWidth = "";
    const hw = el(root, "timeline-head-wrap"); if (hw) hw.style.display = "none";
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
    grid.style.minWidth = "";
    const hw = el(root, "timeline-head-wrap"); if (hw) hw.style.display = "none";
    return;
  }

  const cfg = zoomCfg();
  const headWrap = el(root, "timeline-head-wrap");
  const headGrid = el(root, "timeline-head");
  if (headWrap) headWrap.style.display = "";
  // The car column's width: the person's own dragged width wins over the
  // zoom preset. Dragged on the column's right edge, remembered per device.
  const carW = Number(loadPref("plannerCarW", 0)) || cfg.label;
  const columnsSpec = `${carW}px repeat(${DAYS * 2}, minmax(${cfg.half}px, 1fr))`;
  grid.style.gridTemplateColumns = columnsSpec;
  if (headGrid) headGrid.style.gridTemplateColumns = columnsSpec;
  {
    const fixed = el(root, "tl-corner-fixed");
    if (fixed) fixed.style.width = carW + "px";
  }
  wireCarColumnDrag(grid);
  wireDayHighlight();

  // Width comes from the zoom level, never from the content. Stating it outright
  // means a day column is the same width whatever bookings happen to be on
  // screen, and it makes the planner wider than its frame so it scrolls.
  const gridWidth = cfg.label + DAYS * 2 * cfg.half;
  grid.style.minWidth = gridWidth + "px";
  if (headGrid) headGrid.style.minWidth = gridWidth + "px";

  // How wide a day column really is. Tracks stretch to fill the planner when the
  // frame is wider than the grid needs, so take whichever is larger — but never
  // guess: this now matches what is actually rendered, which the previous
  // estimate did not, and that mismatch was hiding labels from bars that had
  // ample room for them.
  const dayPx = Math.max(cfg.half * 2, (wrap.clientWidth - cfg.label) / DAYS);

  // The sticky renter name pins just past this column, so it needs the width
  grid.style.setProperty("--tl-label-w", cfg.label + "px");
  if (headGrid) headGrid.style.setProperty("--tl-label-w", cfg.label + "px");

  const dowShort = ["Su","Mo","Tu","We","Th","Fr","Sa"];

  // The date row is drawn into the sticky strip above the planner, not into
  // the planner grid itself — that is what keeps it on screen while the page
  // scrolls down a long fleet. Same columns, same widths, so it always lines
  // up with the body beneath it.
  // spacer only — the visible month+grip live in the fixed overlay on the
  // wrap, outside the scrolling coordinate system entirely: sticky inside a
  // programmatically-scrolled overflow:hidden strip proved unreliable (the
  // pilot's third month-scrolls-away screenshot, 25 Aug)
  let headHtml = `<div class="tl-corner" style="grid-row:1;grid-column:1;"></div>`;
  days.forEach((d, i) => {
    const ds = dstr(d);
    const dow = d.getDay();
    const cls = ds === t ? "today" : (dow === 0 || dow === 6) ? "weekend" : "";
    // The first of a month announces the month where the weekday would be, and
    // the column carries a marker line — so 31 sitting next to 1 can never be
    // read as the same month again.
    const monthStart = d.getDate() === 1;
    headHtml += `<div class="tl-daynum ${cls}${monthStart ? " month-start" : ""}" data-day="${ds}" style="grid-row:1;grid-column:${i * 2 + 2} / span 2;">
      <span class="dow">${monthStart ? MONTH_NAMES[d.getMonth()] : dowShort[dow]}</span>${d.getDate()}</div>`;
  });
  if (headGrid) headGrid.innerHTML = headHtml;

  let html = "";
  cars.forEach((car, i) => {
    const row = i + 1;
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
      const ms = d.getDate() === 1 ? " month-start" : "";
      // row and day index are carried on the cell so a drag can work out which
      // span it covers without having to measure anything on screen.
      html += `<div class="tl-cell addable ${cls}${ms}" data-add-car="${car.id}" data-add-date="${ds}"
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
          (b.broker ? `\nBroker: ${b.broker}` : "") +
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
          data-s0="${startOffset}" data-e0="${endOffset}"
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
  // Kept for the pinned month label, which has to turn a scroll position back
  // into a date whenever the planner moves sideways.
  tlMonthDays = days;
  tlMonthHalf = cfg.half;

  grid.innerHTML = html;
  applyDayHighlight();   // the selected date's tint survives redraws
  if (reanchored) {
    wrap.scrollLeft = 0;   // a new window, so start at its first day
    reanchored = false;
  } else {
    wrap.scrollLeft = keepLeft;
    wrap.scrollTop = keepTop;
  }
  updateTlMonth();

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
    <div class="item-card ${s}" data-booking-card="${b.id}">
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
        <span>Total: <strong>${fxPair(b, invoiceTotal(b), extrasTotal(b) === 0 ? b.fxTotal : null)}</strong> ${b.paid ? "(paid)" : "(unpaid)"}</span>
        ${b.phone ? `<span>Phone: <strong>${esc(b.phone)}</strong></span>` : ""}
      </div>
      ${(b.managedBy || b.deliveredBy || b.broker || b.notes) ? `
      <div class="card-details">
        ${b.broker ? `<span>Broker: <strong>${esc(b.broker)}</strong></span>` : ""}
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
  const b = state.bookings.find(x => x.id === id);
  if (!confirm(deleteBookingWarning(b))) return;
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
    const row = nodeAtPoint(e.clientX, e.clientY, "[data-carrow]");
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
    if (!to || to === from) return;

    // Asked before anything is saved: the order is shared by the whole
    // company, and on a phone a scroll near the grip can read as a drag —
    // which is exactly how the fleet got quietly rearranged by accident.
    const a = state.cars.find(c => c.id === from);
    const b = state.cars.find(c => c.id === to);
    if (!a || !b) return;
    if (!confirm(
      `Move ${a.make} ${a.model} (${a.plate || "no plate"}) to where ` +
      `${b.make} ${b.model} (${b.plate || "no plate"}) is in the list?\n\n` +
      `This changes the planner order for everyone in the company.`
    )) return;

    await commitCarOrder(from, to);
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
