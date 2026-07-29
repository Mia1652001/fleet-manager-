// Tasks view — the day's work list: cars to hand over, cars to collect,
// plus any manually added jobs. Booking-derived jobs stay in step with the
// bookings automatically; only manual tasks are stored separately.
import { db, setSync } from "./firebase-init.js";
import { collection, addDoc, updateDoc, deleteDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { openBookingModal } from "./booking-form.js";
import {
  state, onDataChange, esc, formatDate, formatAmount, todayStr, buildSchedule, staffNames,
  fillTimeOptions, getTime, setTime,
  findClash, describeInterval, startTime, endTime,
  rentalDays, rateFor, rentalTotal, hasManualTotal,
  initPanelToggle, loadPref, savePref,
  el, val, setVal, openModal, closeModal, showError,
  showToast
} from "./store.js";

let root = null;
let summaryOpen = () => true;   // set on mount; see initPanelToggle
let range = "today";
let showDone = false;
// Empty means everyone. Otherwise a set of names, plus "__none__" standing for
// jobs with nobody assigned, which is a filter in its own right.
let staffFilter = new Set();
let kindFilter = "";
let editingTaskId = null;
// "list" to work through a day, "board" to see across the team. Remembered per
// device, since it is a working preference rather than company data.
let mode = loadPref("tasksView", "list");

export function mount(container) {
  root = container;

  // The summary figures start closed so the working part of the view is
  // first on screen — the phone screens had almost nothing else visible.
  summaryOpen = initPanelToggle(root, "tasksShowSummary", "toggle-summary", "hide-summary", "Summary");

  fillTimeOptions(root, "t-time");
  el(root, "search").addEventListener("input", render);

  el(root, "staff-filter-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const panel = el(root, "staff-filter-panel");
    panel.style.display = panel.style.display === "none" ? "block" : "none";
  });

  el(root, "staff-filter-panel").addEventListener("click", (e) => {
    e.stopPropagation();
    if (e.target.closest("[data-clear-staff]")) { staffFilter.clear(); render(); return; }
    const box = e.target.closest("input[data-staff]");
    if (!box) return;
    const v = box.dataset.staff;
    if (box.checked) staffFilter.add(v); else staffFilter.delete(v);
    render();
  });

  // Clicking anywhere else puts the list away, which is what a dropdown does.
  document.addEventListener("click", () => {
    const panel = el(root, "staff-filter-panel");
    if (panel) panel.style.display = "none";
  });
  el(root, "kind-filter").addEventListener("change", () => {
    kindFilter = el(root, "kind-filter").value; render();
  });
  wireBoardDrag();
  wireTaskMoveModal();

  el(root, "job-detail-open").addEventListener("click", (e) => {
    const id = e.currentTarget.dataset.booking;
    closeModal(root, "job-detail");
    if (id) openBookingModal(id);
  });
  el(root, "job-detail-edit").addEventListener("click", (e) => {
    const id = e.currentTarget.dataset.task;
    closeModal(root, "job-detail");
    if (id) openTaskModal(id);
  });

  el(root, "view-list").addEventListener("click", () => setMode("list"));
  el(root, "view-board").addEventListener("click", () => setMode("board"));
  applyMode();

  el(root, "add-task").addEventListener("click", () => openTaskModal(null));
  el(root, "save-task").addEventListener("click", saveTask);
  el(root, "delete-task").addEventListener("click", removeTask);

  el(root, "toggle-done").addEventListener("click", () => {
    showDone = !showDone;
    const btn = el(root, "toggle-done");
    btn.classList.toggle("active", showDone);
    btn.textContent = showDone ? "Hide completed" : "Show completed";
    render();
  });

  el(root, "filters").addEventListener("click", (e) => {
    const t = e.target.closest(".tab");
    if (!t) return;
    range = t.dataset.f;
    el(root, "filters").querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
    t.classList.add("active");
    render();
  });

  root.querySelectorAll("[data-close]").forEach(b =>
    b.addEventListener("click", () => closeModal(root, b.dataset.close)));
  root.querySelectorAll(".overlay").forEach(o =>
    o.addEventListener("click", e => { if (e.target === o) o.classList.remove("open"); }));

  // Ticking a chip on the board does the same as ticking a row in the list —
  // it would be odd to be able to see the work but not mark it done.
  el(root, "board").addEventListener("click", async (e) => {
    const add = e.target.closest("[data-add-day]");
    if (add) { openTaskModal(null, add.dataset.addDay, add.dataset.addStaff); return; }

    // The tick box marks a job done; the rest of the chip opens it. A chip is
    // too narrow to show everything, and on a phone there is no hover to fall
    // back on, so tapping it has to be the way to read the detail.
    const box = e.target.closest("[data-tickbox]");
    if (box) {
      const chip = box.closest("[data-tick]");
      if (chip && chip.dataset.kind !== "service") {
        await toggleDone(chip.dataset.tick, chip.dataset.kind, chip.dataset.ref);
      }
      return;
    }

    const chip = e.target.closest("[data-tick]");
    if (chip) openJobDetail(chip.dataset.tick);
  });

  el(root, "list").addEventListener("click", async (e) => {
    const tick = e.target.closest("[data-tick]");
    if (tick) { await toggleDone(tick.dataset.tick, tick.dataset.kind, tick.dataset.ref); return; }

    const edit = e.target.closest("[data-edit-task]");
    if (edit) { openTaskModal(edit.dataset.editTask); return; }

    // "+" on a day heading adds a task already dated to that day
    const add = e.target.closest("[data-add-on]");
    if (add) { openTaskModal(null, add.dataset.addOn); return; }
  });

  onDataChange(() => { if (root.classList.contains("active")) render(); });
}

// ---------- List or board ----------
function setMode(next) {
  mode = next;
  savePref("tasksView", mode);
  applyMode();
  render();
}

function applyMode() {
  el(root, "view-list").classList.toggle("active", mode === "list");
  el(root, "view-board").classList.toggle("active", mode === "board");
  el(root, "list").style.display = mode === "list" ? "" : "none";
  el(root, "board").style.display = mode === "board" ? "" : "none";
}

// ---------- Helpers ----------
function shiftDate(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const DONE_LOOKBACK_DAYS = 7;

// Declared here because rangeBounds needs them too: the board has to fetch
// every day it intends to draw, or the extra rows come out empty.
const BOARD_MIN_DAYS = 7;    // a board showing one day is not a board
const BOARD_MAX_DAYS = 31;   // and an open-ended range must not draw a year

// "Everything ahead" draws a solid month of days before gaps start being
// skipped — a solid stretch is what makes drag-and-drop land where it looks
// like it will land.
const DENSE_AHEAD_DAYS = 30;

function addDay(ds) {
  const d = new Date(ds + "T12:00");
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// The rows the list and the board both draw: every single day of the chosen
// range — empty ones included, so any date can be added to or dropped on —
// plus the day of any job outside it (overdue leftovers, far-ahead bookings).
// Where days are skipped between drawn ones, a marker row is emitted, because
// two adjacent rows months apart is exactly how a booking got dragged to
// 31/10 when 31/08 was meant.
//
// Returns a list of { kind: "day", date } and { kind: "gap", skipped } rows.
function dayRows(from, to, jobs, minDays) {
  const start = from || todayStr();

  // The dense stretch: the chosen range itself, or a month ahead when the
  // range is open-ended, never fewer than minDays (the board's week).
  let horizon = to;
  if (!horizon) {
    const h = new Date(start + "T12:00");
    h.setDate(h.getDate() + DENSE_AHEAD_DAYS - 1);
    horizon = `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, "0")}-${String(h.getDate()).padStart(2, "0")}`;
  }
  if (minDays) {
    const l = new Date(start + "T12:00");
    l.setDate(l.getDate() + minDays - 1);
    const least = `${l.getFullYear()}-${String(l.getMonth() + 1).padStart(2, "0")}-${String(l.getDate()).padStart(2, "0")}`;
    if (horizon < least) horizon = least;
  }

  const dates = new Set();
  let ds = start, n = 0;
  while (ds <= horizon && n < BOARD_MAX_DAYS) { dates.add(ds); ds = addDay(ds); n++; }

  // Days that carry a job outside the dense stretch still get a row of their
  // own — a chip must never lose the row it sits in.
  jobs.forEach(j => { if (j.date) dates.add(j.date); });

  const all = [...dates].sort();
  const rows = [];
  all.forEach((d, i) => {
    if (i > 0 && addDay(all[i - 1]) !== d) {
      const skipped = Math.round(
        (new Date(d + "T12:00") - new Date(all[i - 1] + "T12:00")) / 86400000) - 1;
      rows.push({ kind: "gap", skipped });
    }
    rows.push({ kind: "day", date: d });
  });
  return rows;
}

function rangeBounds() {
  // Showing completed work is a review action, so reach back a week. Without
  // this, "Today" plus "show completed" turns up nothing unless a job happened
  // to be finished today.
  const from = showDone ? shiftDate(-DONE_LOOKBACK_DAYS) : todayStr();
  let to =
    range === "today" ? todayStr() :
    range === "week" ? shiftDate(6) :
    range === "month" ? shiftDate(29) :
    null;                                   // everything ahead

  // The board always draws a week of rows, however narrow the range. Fetching
  // only the range meant those extra rows were drawn empty — the jobs existed,
  // the board just had not asked for them, so "Today" looked like a quiet week
  // and two people on different tabs saw genuinely different amounts of work.
  if (mode === "board" && to !== null) {
    const least = shiftDate(BOARD_MIN_DAYS - 1);
    if (to < least) to = least;
  }

  return { from, to };
}

function dayHeading(dateStr) {
  const t = todayStr();
  if (dateStr === t) return `Today · ${formatDate(dateStr)}`;
  if (dateStr === shiftDate(1)) return `Tomorrow · ${formatDate(dateStr)}`;
  if (dateStr === shiftDate(-1)) return `Yesterday · ${formatDate(dateStr)}`;
  const d = new Date(dateStr + "T12:00");
  const weekday = d.toLocaleDateString("en-GB", { weekday: "long" });
  return `${weekday} · ${formatDate(dateStr)}`;
}

function kindLabel(kind) {
  return { delivery: "Deliver", recovery: "Recover", task: "Task", service: "Service" }[kind] || kind;
}

// ---------- Render ----------
function refreshStaffOptions() {
  const panel = el(root, "staff-filter-panel");
  const names = staffNames();

  // Anyone who has left since a filter was set should not keep filtering.
  [...staffFilter].forEach(v => {
    if (v !== "__none__" && !names.includes(v)) staffFilter.delete(v);
  });

  const wanted = ["__none__", ...names].join("|");
  if (panel.dataset.built !== wanted) {
    panel.innerHTML =
      `<button type="button" class="multi-clear" data-clear-staff>Everyone</button>` +
      [["__none__", "Unassigned"], ...names.map(n => [n, n])]
        .map(([v, label]) => `
          <label class="multi-row">
            <input type="checkbox" data-staff="${esc(v)}"> <span>${esc(label)}</span>
          </label>`).join("");
    panel.dataset.built = wanted;
  }

  panel.querySelectorAll("input[data-staff]").forEach(b => {
    b.checked = staffFilter.has(b.dataset.staff);
  });

  // The button says who is selected, so the filter is visible without opening it.
  const chosen = [...staffFilter].map(v => v === "__none__" ? "Unassigned" : v);
  el(root, "staff-filter-btn").textContent =
    chosen.length === 0 ? "All staff"
    : chosen.length <= 2 ? chosen.join(", ")
    : `${chosen.length} of ${names.length + 1} selected`;
}

export function render() {
  if (!root) return;
  refreshStaffOptions();
  const search = el(root, "search").value.toLowerCase();
  const { from, to } = rangeBounds();

  const all = buildSchedule({ from, to, includeDone: showDone });

  const jobs = all.filter(j => {
    const matchesSearch = `${j.car} ${j.customer} ${j.location} ${j.staff}`.toLowerCase().includes(search);
    const matchesKind = !kindFilter || j.kind === kindFilter;
    // Match either role, so a job managed by one person and delivered by
    // another shows up for both of them.
    const matchesStaff =
      staffFilter.size === 0 ? true :
      // Any one of the chosen people being on the job is enough — picking three
      // staff should show all their work together, not only jobs shared by all.
      [...staffFilter].some(v =>
        v === "__none__"
          ? !j.staff && !j.managedBy && !j.deliveredBy && !j.recoveredBy
          : [j.staff, j.managedBy, j.deliveredBy, j.recoveredBy].includes(v));
    return matchesSearch && matchesKind && matchesStaff;
  });

  // Stats always reflect the real workload, not the current filter
  const t = todayStr();
  const todayJobs = buildSchedule({ from: t, to: t, includeDone: false });
  const weekJobs = buildSchedule({ from: t, to: shiftDate(6), includeDone: false });
  const lateJobs = buildSchedule({ from: null, to: null, includeDone: false }).filter(j => j.overdue);

  if (summaryOpen()) el(root, "stats").innerHTML = `
    <div class="stat"><div class="stat-label">Due today</div><div class="stat-val">${todayJobs.filter(j => !j.overdue).length}</div></div>
    <div class="stat"><div class="stat-label">Next 7 days</div><div class="stat-val blue">${weekJobs.filter(j => !j.overdue).length}</div></div>
    <div class="stat"><div class="stat-label">Running late</div><div class="stat-val red">${lateJobs.length}</div></div>
  `;

  if (mode === "board") { renderBoard(jobs, from, to); return; }

  const listEl = el(root, "list");

  // With filters or a search active and nothing matching, thirty empty day
  // headings would bury the answer; a sentence says it better.
  if (jobs.length === 0 && (staffFilter.size || kindFilter || search)) {
    listEl.innerHTML =
      `<div class="empty">Nothing matches these filters. Try widening the date range or clearing the staff and job filters.</div>`;
    return;
  }

  // Every day of the chosen range is shown, empty ones included, each with its
  // own "+" — so a task can be put on any date, not only on dates that already
  // have work. Days beyond the range that carry a job still appear, separated
  // by an explicit marker so distant dates never look adjacent.
  const rows = dayRows(from, to, jobs, 0);
  listEl.innerHTML = rows.map(r => {
    if (r.kind === "gap") {
      return `<div class="day-gap">· · · ${r.skipped} empty day${r.skipped === 1 ? "" : "s"} skipped · · ·</div>`;
    }
    const items = jobs.filter(j => j.date === r.date);
    return `
    <div class="day-group${items.length ? "" : " empty"}">
      <div class="day-head">
        <span>${esc(dayHeading(r.date))}</span>
        <button class="day-add" data-add-on="${r.date}" title="Add a task on ${formatDate(r.date)}">+</button>
      </div>
      ${items.map(j => jobRow(j)).join("")}
    </div>`;
  }).join("");
}

// ---------- The staff board ----------
// One column per person, one row per day: read across a row for everyone's
// Tuesday, down a column for one person's week. The Unassigned column is the
// point of it — that is where the Saturday collection nobody has been given
// shows up, which a per-person filter can never reveal.

function boardColumns(jobs) {
  // Two sources, and deliberately not every name the app has ever seen. The
  // Settings staff list gets a column whether or not anyone is busy, so you can
  // see who is free. Beyond that, only people who actually have a job in view.
  //
  // Using every historical name filled the board with empty columns for
  // placeholders and one-off spellings typed into old bookings, which pushed the
  // real people off the edge of the screen.
  const fromSettings = Array.isArray(state.settings?.staff)
    ? state.settings.staff.map(x => String(x).trim()).filter(Boolean)
    : [];
  const busyNow = jobs.map(j => (j.staff || "").trim()).filter(Boolean);

  // With no staff list set up yet, fall back to whoever is busy, or the board
  // would have nothing but an Unassigned column.
  const source = fromSettings.length ? [...fromSettings, ...busyNow] : busyNow;

  const seen = new Map();
  source.forEach(n => {
    const k = n.toLowerCase();
    if (k && !seen.has(k)) seen.set(k, n);
  });
  return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
}

function boardChip(j) {
  const kindShort = { delivery: "Out", recovery: "Back", task: "Task", service: "Service" }[j.kind] || j.kind;
  const ref = j.kind === "task" ? j.taskId : j.kind === "service" ? j.carId : j.bookingId;
  const label = j.kind === "task" ? j.customer : j.car;
  const sub = [j.kind !== "task" ? j.customer : "", j.location].filter(Boolean).join(" · ");
  return `
    <div class="board-chip kind-${j.kind}${j.done ? " done" : ""}${j.overdue ? " late" : ""}"
         data-tick="${j.id}" data-kind="${j.kind}" data-ref="${ref}"
         title="${esc(`${j.time || ""} ${label} ${sub}${j.dateMoved ? " · moved, booking unchanged" : ""}`.trim())}">
      ${j.kind === "service"
        ? `<span class="board-tick disabled">\u2699</span>`
        : `<span class="board-tick" data-tickbox="1" title="${j.done ? "Mark as not done" : "Mark as done"}">${j.done ? "\u2713" : ""}</span>`}
      <span class="board-chip-time">${j.time ? esc(j.time) : "—"}</span>
      <span class="board-chip-kind">${kindShort}</span>
      <span class="board-chip-main">${esc(label || "")}${sub ? ` <span class="board-dim">${esc(sub)}</span>` : ""}</span>
    </div>`;
}

// ---------- Drag a job to another person or another day ----------
// Reassigning by dragging is the whole point of a board: you can see who is
// overloaded and move something across without opening anything. Mouse and
// trackpad only — on a touchscreen the same gesture scrolls the board sideways,
// and taking that over would make the board unusable to gain a shortcut.
//
// Dropping on a different day moves the job's date as well. For a manual task
// that is a plain postponement and happens straight away. For a delivery or a
// collection the date IS the booking's pick-up or return date, which changes
// what the customer is charged — so those always stop for confirmation and are
// checked against the rest of the calendar first, exactly like editing the
// booking would be.

let chipDrag = null;

function wireBoardDrag() {
  const board = el(root, "board");
  if (!board) return;

  board.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch" || e.button !== 0) return;
    if (e.target.closest("[data-tickbox]") || e.target.closest("[data-add-day]")) return;
    const chip = e.target.closest("[data-tick]");
    if (!chip || chip.dataset.kind === "service") return;   // servicing has nobody to assign

    const cell = chip.closest("[data-cell-day]");
    if (!cell) return;

    chipDrag = {
      jobId: chip.dataset.tick,
      kind: chip.dataset.kind,
      ref: chip.dataset.ref,
      fromStaff: cell.dataset.cellStaff || "",
      day: cell.dataset.cellDay,
      moved: false,
      pointerId: e.pointerId
    };
    // Capture is taken only once this turns out to be a drag — see pointermove.
    // Capturing here retargets the follow-up click to the board, so a plain tap
    // never reached the chip and opening a job stopped working entirely.
  });

  board.addEventListener("pointermove", (e) => {
    if (!chipDrag) return;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const cell = under && under.closest && under.closest("[data-cell-day]");

    board.querySelectorAll(".board-cell.drop-target").forEach(c => c.classList.remove("drop-target"));
    if (!cell) { chipDrag.toDay = undefined; return; }   // off the board: no target
    // Any cell that differs in person or day is a target; the origin cell is
    // not — and it clears the target, so dragging away and back drops nothing.
    const sameSpot = cell.dataset.cellDay === chipDrag.day &&
                     (cell.dataset.cellStaff || "") === chipDrag.fromStaff;
    if (sameSpot) { chipDrag.toDay = undefined; return; }

    if (!chipDrag.moved) {
      try { board.setPointerCapture(e.pointerId); } catch {}
    }
    chipDrag.moved = true;
    chipDrag.toStaff = cell.dataset.cellStaff || "";
    chipDrag.toDay = cell.dataset.cellDay;
    cell.classList.add("drop-target");
    board.classList.add("dragging-chip");
    e.preventDefault();
  });

  const finish = async () => {
    if (!chipDrag) return;
    const drag = chipDrag;
    chipDrag = null;
    if (drag.moved) { try { board.releasePointerCapture(drag.pointerId); } catch {} }
    board.classList.remove("dragging-chip");
    board.querySelectorAll(".board-cell.drop-target").forEach(c => c.classList.remove("drop-target"));

    if (!drag.moved || drag.toDay === undefined) return;

    // The click that follows a drag would otherwise open the job detail panel.
    board.addEventListener("click", ev => {
      ev.preventDefault(); ev.stopPropagation();
    }, { capture: true, once: true });

    await applyBoardDrop(drag);
  };

  board.addEventListener("pointerup", finish);
  board.addEventListener("pointercancel", () => {
    // Same as the planner: a cancel before any movement is the browser starting
    // a selection, not the user letting go.
    if (chipDrag && !chipDrag.moved) return;
    chipDrag = null;
    board.classList.remove("dragging-chip");
    board.querySelectorAll(".board-cell.drop-target").forEach(c => c.classList.remove("drop-target"));
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && chipDrag) {
      chipDrag = null;
      board.classList.remove("dragging-chip");
      board.querySelectorAll(".board-cell.drop-target").forEach(c => c.classList.remove("drop-target"));
    }
  });
}

// A drop can change the person, the day, or both. Which field the person goes
// into depends on the kind of job: a hand-over belongs to whoever delivers, a
// collection to whoever recovers, and a manual task has a staff field of its
// own. Dropping into Unassigned clears it.
//
// A day change on a manual task is a plain postponement and applies straight
// away. On a delivery or collection the day carries a real decision — move the
// job alone (the car is dropped early, the rental unchanged) or move the
// booking's own date with it — so those open a dialog that asks which, and
// nothing at all changes until it is answered.
async function applyBoardDrop({ kind, ref, fromStaff, day, toStaff, toDay }) {
  const name = toStaff || "";
  const staffChanged = name !== fromStaff;
  const dayChanged = toDay !== day;

  try {
    if (kind === "task") {
      const update = {};
      if (staffChanged) update.staff = name;
      if (dayChanged) update.date = toDay;
      if (!Object.keys(update).length) return;
      setSync("saving");
      await updateDoc(doc(db, "tasks", ref), update);
      showToast(dayChanged
        ? `Moved to ${formatDate(toDay)}${staffChanged ? (name ? `, ${name}` : ", Unassigned") : ""}`
        : (name ? `Moved to ${name}` : "Moved to Unassigned"));
      return;
    }

    const b = state.bookings.find(x => x.id === ref);
    if (!b) return;

    if (!dayChanged) {
      // Person only — no dialog needed, nothing about the dates is touched.
      if (!staffChanged) return;
      setSync("saving");
      await updateDoc(doc(db, "bookings", ref),
        { [kind === "delivery" ? "deliveredBy" : "recoveredBy"]: name });
      showToast(name ? `Moved to ${name}` : "Moved to Unassigned");
      return;
    }

    openTaskMoveModal({ kind, booking: b, toDay, staffChanged, name });
  } catch (e) {
    alert("Couldn't move it (" + (e.code || e.message) + "). Try again.");
    setSync("error");
  }
}

// ---------- The move dialog for deliveries and collections ----------
// Two different things can be meant by dragging a hand-over to another day,
// and they have very different consequences, so the choice is made explicit:
//
//   * Move the task only — the job goes on the new day's work list, the
//     booking and its price stay exactly as they are. This is the airport
//     case: the car is dropped on the 30th for a rental starting the 1st.
//   * Move the booking too — the pick-up or return date itself changes, the
//     price changes with the number of days, and the calendar is checked for
//     clashes first.

let pendingTaskMove = null;

function wireTaskMoveModal() {
  el(root, "tm-confirm").addEventListener("click", confirmTaskMove);
  root.querySelectorAll('[data-close="task-move-modal"]').forEach(btn =>
    btn.addEventListener("click", () => { pendingTaskMove = null; closeModal(root, "task-move-modal"); }));
}

function openTaskMoveModal({ kind, booking: b, toDay, staffChanged, name }) {
  const what = kind === "delivery" ? "hand-over" : "collection";
  const bookingField = kind === "delivery" ? "Pick-up" : "Return";
  const fromDay = kind === "delivery" ? (b.deliveryDate || b.startDate) : (b.recoveryDate || b.endDate);

  // Everything option B would do is worked out now, so an impossible move is
  // greyed out with its reason instead of failing after being chosen.
  const newStart = kind === "delivery" ? toDay : b.startDate;
  const newEnd = kind === "recovery" ? toDay : b.endDate;
  const newStartAt = `${newStart}T${startTime(b)}`;
  const newEndAt = `${newEnd}T${endTime(b)}`;

  let bookingBlocked = "";
  if (newEndAt <= newStartAt) {
    bookingBlocked = kind === "delivery"
      ? "Not possible: the pick-up would be after the return."
      : "Not possible: the return would be before the pick-up.";
  } else {
    const clash = findClash({ carId: b.carId, startAt: newStartAt, endAt: newEndAt, ignoreId: b.id });
    if (clash) bookingBlocked = `Not possible: the car is already out ${describeInterval(clash)} (${clash.renter}).`;
  }

  const newDays = rentalDays({ startDate: newStart, endDate: newEnd });
  const priceLine = hasManualTotal(b)
    ? `${newDays} day${newDays === 1 ? "" : "s"}; the agreed price stays ${formatAmount(rentalTotal(b))}.`
    : `${newDays} day${newDays === 1 ? "" : "s"}; the total becomes ${formatAmount(newDays * rateFor(b))}.`;

  pendingTaskMove = { kind, bookingId: b.id, toDay, staffChanged, name, bookingBlocked };

  el(root, "tm-title").textContent = `Move this ${what}`;
  el(root, "tm-summary").innerHTML = `
    <div class="jd-row"><span class="jd-k">Booking</span><span class="jd-v">${esc(b.renter || "")} · ${formatDate(b.startDate)} – ${formatDate(b.endDate)}</span></div>
    <div class="jd-row"><span class="jd-k">${esc(what[0].toUpperCase() + what.slice(1))}</span><span class="jd-v">${formatDate(fromDay)} → ${formatDate(toDay)}</span></div>`;

  el(root, "tm-task-hint").textContent =
    `The ${what} goes on ${formatDate(toDay)}'s work list. The booking stays ` +
    `${formatDate(b.startDate)} – ${formatDate(b.endDate)} and the price does not change.`;

  el(root, "tm-booking-label").textContent = `Move the booking's ${bookingField.toLowerCase()} date too`;
  el(root, "tm-booking-hint").textContent = bookingBlocked ||
    `${bookingField} becomes ${formatDate(toDay)} — ${priceLine}`;

  const optTask = el(root, "tm-task-only");
  const optBooking = el(root, "tm-booking-too");
  optBooking.disabled = !!bookingBlocked;
  optTask.checked = true;
  optBooking.checked = false;

  showError(root, "tm-error", null);
  openModal(root, "task-move-modal");
}

async function confirmTaskMove() {
  if (!pendingTaskMove) return;
  const { kind, bookingId, toDay, staffChanged, name, bookingBlocked } = pendingTaskMove;
  const b = state.bookings.find(x => x.id === bookingId);
  if (!b) { closeModal(root, "task-move-modal"); pendingTaskMove = null; return; }

  const moveBooking = el(root, "tm-booking-too").checked;
  if (moveBooking && bookingBlocked) {
    showError(root, "tm-error", bookingBlocked);
    return;
  }

  const update = {};
  if (staffChanged) update[kind === "delivery" ? "deliveredBy" : "recoveredBy"] = name;

  if (moveBooking) {
    // The booking's own date moves, and any task-only override is cleared so
    // the job follows the booking again rather than sitting on a stale day.
    if (kind === "delivery") { update.startDate = toDay; update.deliveryDate = null; }
    else { update.endDate = toDay; update.recoveryDate = null; }
  } else {
    // Only the work list changes. Setting the override back to the booking's
    // own date means "no override" — dragging a job home undoes the move.
    if (kind === "delivery") update.deliveryDate = toDay === b.startDate ? null : toDay;
    else update.recoveryDate = toDay === b.endDate ? null : toDay;
  }

  const btn = el(root, "tm-confirm");
  btn.disabled = true; btn.textContent = "Moving...";
  setSync("saving");
  try {
    await updateDoc(doc(db, "bookings", bookingId), update);
    closeModal(root, "task-move-modal");
    pendingTaskMove = null;
    showToast(moveBooking
      ? `${kind === "delivery" ? "Pick-up" : "Return"} moved to ${formatDate(toDay)}`
      : `${kind === "delivery" ? "Hand-over" : "Collection"} moved to ${formatDate(toDay)} — booking unchanged`);
  } catch (e) {
    showError(root, "tm-error", "Couldn't move it (" + (e.code || e.message) + "). Try again.");
    setSync("error");
  }
  btn.disabled = false; btn.textContent = "Move";
}

// A chip cannot show everything at its size, and on a phone there is no hover to
// reveal the rest. Tapping one opens the full detail, which is the only way this
// information is reachable on a touchscreen at all.
function openJobDetail(jobId) {
  const all = buildSchedule({ from: null, to: null, includeDone: true });
  const j = all.find(x => x.id === jobId);
  if (!j) return;

  const kindName = { delivery: "Hand over", recovery: "Collect", task: "Task", service: "Service" }[j.kind] || j.kind;
  // A moved job shows the booking's own dates too, or a hand-over sitting two
  // days before its rental would read as a data error rather than a decision.
  const jb = j.bookingId ? state.bookings.find(x => x.id === j.bookingId) : null;
  const rows = [
    ["When", `${formatDate(j.date)}${j.time ? ` at ${j.time}` : ""}${j.dateMoved ? " (moved — booking unchanged)" : ""}`],
    ["Booking period", j.dateMoved && jb ? `${formatDate(jb.startDate)} – ${formatDate(jb.endDate)}` : ""],
    ["Job", kindName],
    [j.kind === "task" ? "Task" : "Vehicle", j.kind === "task" ? j.customer : j.car],
    [j.kind === "task" ? "" : "Customer", j.kind === "task" ? "" : j.customer],
    ["Place", j.location],
    ["Staff", j.staff],
    ["Managed by", j.managedBy],
    ["Delivered by", j.deliveredBy],
    ["Recovered by", j.recoveredBy],
    ["Notes", j.notes],
    ["Status", j.done ? "Done" : j.overdue ? "Running late" : "Outstanding"]
  ].filter(([k, v]) => k && v);

  el(root, "job-detail-body").innerHTML = rows
    .map(([k, v]) => `<div class="jd-row"><span class="jd-k">${esc(k)}</span><span class="jd-v">${esc(v)}</span></div>`)
    .join("");

  // Opening the booking is the useful next step from a delivery or a collection.
  const openBtn = el(root, "job-detail-open");
  openBtn.style.display = (j.kind === "delivery" || j.kind === "recovery") ? "inline-block" : "none";
  openBtn.dataset.booking = j.bookingId || "";

  const editBtn = el(root, "job-detail-edit");
  editBtn.style.display = j.kind === "task" ? "inline-block" : "none";
  editBtn.dataset.task = j.taskId || "";

  openModal(root, "job-detail");
}

function renderBoard(jobs, from, to) {
  const box = el(root, "board");

  // Servicing has no person to assign it to, so it would sit in Unassigned for
  // ever and drown the column that is meant to be actionable.
  const assignable = jobs.filter(j => j.kind !== "service");

  const rowsSpec = dayRows(from, to, assignable, BOARD_MIN_DAYS);
  const people = boardColumns(assignable);
  const columns = [...people, null];        // null is the Unassigned column

  if (columns.length === 1 && assignable.length === 0 && !people.length && !state.settings?.staff?.length) {
    // No staff set up and nothing to show: the board would be a wall of empty
    // Unassigned cells, so a pointer to Settings says more.
    box.innerHTML = `<div class="empty">Nothing to show here. Jobs appear from bookings — or add staff on the Settings page to plan by person.</div>`;
    return;
  }

  const head = `<div class="board-cell board-corner">Day</div>` +
    columns.map(p => `<div class="board-cell board-head${p ? "" : " unassigned"}">${p ? esc(p) : "Unassigned"}</div>`).join("");

  const rows = rowsSpec.map(r => {
    if (r.kind === "gap") {
      return `<div class="board-gap">· · · ${r.skipped} empty day${r.skipped === 1 ? "" : "s"} skipped · · ·</div>`;
    }
    const ds = r.date;
    const dayJobs = assignable.filter(j => j.date === ds);
    const cells = columns.map(p => {
      const mine = dayJobs.filter(j =>
        p ? (j.staff || "").trim().toLowerCase() === p.toLowerCase() : !(j.staff || "").trim());
      // A task added from a cell already knows its day and its person, which is
      // most of the form filled in before it opens.
      const add = `<button type="button" class="board-add" data-add-day="${ds}"
          data-add-staff="${esc(p || "")}" title="Add a task on ${formatDate(ds)}">+</button>`;
      return `<div class="board-cell${p ? "" : " unassigned"}"
        data-cell-day="${ds}" data-cell-staff="${esc(p || "")}"
        >${mine.map(boardChip).join("")}${add}</div>`;
    }).join("");
    return `<div class="board-cell board-day${ds === todayStr() ? " today" : ""}">${esc(dayHeading(ds))}</div>${cells}`;
  }).join("");

  // Narrower minimum than before so more people fit before it has to scroll.
  // A chip truncates rather than forcing its column open, so 120px still reads.
  box.style.gridTemplateColumns =
    `minmax(96px, 0.7fr) repeat(${columns.length}, minmax(120px, 1fr))`;
  box.innerHTML = head + rows;
}

function jobRow(j) {
  const ref = j.kind === "task" ? j.taskId : j.kind === "service" ? j.carId : j.bookingId;
  const cls = [
    "job-row",
    j.done ? "done" : "",
    j.overdue ? "late" : "",
    `kind-${j.kind}`
  ].join(" ");

  const main = j.kind === "task"
    ? esc(j.customer)
    : `${esc(j.car)}`;

  const sub = [
    j.kind !== "task" && j.customer ? esc(j.customer) : "",
    j.location ? esc(j.location) : "",
    j.staff ? `<span class="job-staff">${esc(j.staff)}</span>` : "",
    j.dateMoved ? `<span title="This job was moved on its own — the booking's dates are unchanged">moved · booking unchanged</span>` : ""
  ].filter(Boolean).join(" · ");

  return `
    <div class="${cls}">
      ${j.kind === "service"
        ? `<span class="job-tick disabled" title="Mark this serviced on the Maintenance view">\u2699</span>`
        : `<button class="job-tick" data-tick="${j.id}" data-kind="${j.kind}" data-ref="${ref}"
             title="${j.done ? "Mark as not done" : "Mark as done"}">${j.done ? "\u2713" : ""}</button>`}
      <div class="job-time">${j.time ? esc(j.time) : "—"}</div>
      <div class="job-kind ${j.kind}">${kindLabel(j.kind)}</div>
      <div class="job-main">
        <div class="job-title">${main}</div>
        ${sub ? `<div class="job-sub">${sub}</div>` : ""}
      </div>
      ${j.overdue ? `<div class="job-flag">Late</div>` : ""}
      ${j.kind === "task" ? `<button class="btn job-edit" data-edit-task="${j.taskId}">Edit</button>` : ""}
    </div>`;
}

// ---------- Actions ----------
async function toggleDone(jobId, kind, ref) {
  setSync("saving");
  try {
    if (kind === "task") {
      const t = state.tasks.find(x => x.id === ref);
      await updateDoc(doc(db, "tasks", ref), { done: !(t?.done === true) });
    } else if (kind === "delivery") {
      const b = state.bookings.find(x => x.id === ref);
      await updateDoc(doc(db, "bookings", ref), { pickupDone: !(b?.pickupDone === true) });
    } else if (kind === "recovery") {
      // A car being recovered is the same fact as the booking being finished,
      // so this reuses the booking's own status rather than a second flag.
      const b = state.bookings.find(x => x.id === ref);
      const nowDone = b?.status === "completed";
      await updateDoc(doc(db, "bookings", ref), { status: nowDone ? "open" : "completed" });
    }
  } catch (e) {
    alert("Couldn't update (" + (e.code || e.message) + "). Try again.");
    setSync("error");
  }
}

function openTaskModal(id, presetDate, presetStaff) {
  editingTaskId = id || null;
  const t = id ? state.tasks.find(x => x.id === id) : null;
  el(root, "task-modal-title").textContent = t ? "Edit task" : "Add task";
  setVal(root, "t-text", t?.text || "");
  setVal(root, "t-date", t?.date || presetDate || todayStr());
  setTime(root, "t-time", t?.time || "12:00");
  // From a cell on the board, the person is already known from the column.
  setVal(root, "t-staff", t?.staff || presetStaff || "");
  el(root, "delete-task").style.display = t ? "inline-block" : "none";
  showError(root, "task-error", null);
  openModal(root, "task-modal");
}

async function saveTask() {
  showError(root, "task-error", null);
  const text = val(root, "t-text");
  const date = val(root, "t-date");
  if (!text) { showError(root, "task-error", "Describe what needs doing."); return; }
  if (!date) { showError(root, "task-error", "Choose a date."); return; }

  const data = { text, date, time: getTime(root, "t-time"), staff: val(root, "t-staff") };

  const btn = el(root, "save-task");
  btn.disabled = true; btn.textContent = "Saving...";
  setSync("saving");
  try {
    if (editingTaskId) {
      await updateDoc(doc(db, "tasks", editingTaskId), data);
    } else {
      await addDoc(collection(db, "tasks"), {
        companyId: state.ctx.companyId, done: false,
        createdAt: new Date().toISOString(), ...data
      });
    }
    closeModal(root, "task-modal");
    editingTaskId = null;
  } catch (e) {
    showError(root, "task-error", "Couldn't save (" + (e.code || e.message) + "). Try again.");
    setSync("error");
  }
  btn.disabled = false; btn.textContent = "Save task";
}

async function removeTask() {
  if (!editingTaskId) return;
  if (!confirm("Delete this task?")) return;
  setSync("saving");
  try {
    await deleteDoc(doc(db, "tasks", editingTaskId));
    closeModal(root, "task-modal");
    editingTaskId = null;
  } catch (e) {
    showError(root, "task-error", "Couldn't delete (" + (e.code || e.message) + ").");
    setSync("error");
  }
}
