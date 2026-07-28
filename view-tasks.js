// Tasks view — the day's work list: cars to hand over, cars to collect,
// plus any manually added jobs. Booking-derived jobs stay in step with the
// bookings automatically; only manual tasks are stored separately.
import { db, setSync } from "./firebase-init.js";
import { collection, addDoc, updateDoc, deleteDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  state, onDataChange, esc, formatDate, todayStr, buildSchedule, staffNames,
  fillTimeOptions, getTime, setTime,
  initPanelToggle,
  el, val, setVal, openModal, closeModal, showError
} from "./store.js";

let root = null;
let summaryOpen = () => true;   // set on mount; see initPanelToggle
let range = "today";
let showDone = false;
let staffFilter = "";
let kindFilter = "";
let editingTaskId = null;

export function mount(container) {
  root = container;

  // The summary figures start closed so the working part of the view is
  // first on screen — the phone screens had almost nothing else visible.
  summaryOpen = initPanelToggle(root, "tasksShowSummary", "toggle-summary", "hide-summary", "Summary");

  fillTimeOptions(root, "t-time");
  el(root, "search").addEventListener("input", render);

  el(root, "staff-filter").addEventListener("change", () => {
    staffFilter = el(root, "staff-filter").value; render();
  });
  el(root, "kind-filter").addEventListener("change", () => {
    kindFilter = el(root, "kind-filter").value; render();
  });
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

// ---------- Helpers ----------
function shiftDate(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const DONE_LOOKBACK_DAYS = 7;

function rangeBounds() {
  // Showing completed work is a review action, so reach back a week. Without
  // this, "Today" plus "show completed" turns up nothing unless a job happened
  // to be finished today.
  const from = showDone ? shiftDate(-DONE_LOOKBACK_DAYS) : todayStr();
  if (range === "today") return { from, to: todayStr() };
  if (range === "week") return { from, to: shiftDate(6) };
  if (range === "month") return { from, to: shiftDate(29) };
  return { from, to: null }; // everything ahead
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
  const sel = el(root, "staff-filter");
  const names = staffNames();
  const wanted = ["", "__none__", ...names].join("|");
  if (sel.dataset.built === wanted) return;   // nothing changed
  sel.innerHTML =
    `<option value="">All staff</option>` +
    `<option value="__none__">Unassigned</option>` +
    names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
  sel.value = names.includes(staffFilter) || staffFilter === "__none__" ? staffFilter : "";
  staffFilter = sel.value;
  sel.dataset.built = wanted;
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
      !staffFilter ? true :
      staffFilter === "__none__" ? !j.staff && !j.managedBy && !j.deliveredBy && !j.recoveredBy :
      [j.staff, j.managedBy, j.deliveredBy, j.recoveredBy].includes(staffFilter);
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

  const listEl = el(root, "list");
  if (jobs.length === 0) {
    const filtered = staffFilter || kindFilter || search;
    listEl.innerHTML = filtered
      ? `<div class="empty">Nothing matches these filters. Try widening the date range or clearing the staff and job filters.</div>`
      : showDone
      ? `<div class="empty">Nothing completed in the last ${DONE_LOOKBACK_DAYS} days, and nothing outstanding in this range.</div>`
      : `<div class="empty">Nothing scheduled here. Jobs appear automatically from bookings — or add your own with "+ Add task".</div>`;
    return;
  }

  // Group by date
  const groups = [];
  jobs.forEach(j => {
    let g = groups.find(x => x.date === j.date);
    if (!g) { g = { date: j.date, items: [] }; groups.push(g); }
    g.items.push(j);
  });

  listEl.innerHTML = groups.map(g => `
    <div class="day-group">
      <div class="day-head">
        <span>${esc(dayHeading(g.date))}</span>
        <button class="day-add" data-add-on="${g.date}" title="Add a task on this day">+</button>
      </div>
      ${g.items.map(j => jobRow(j)).join("")}
    </div>
  `).join("");
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
    j.staff ? `<span class="job-staff">${esc(j.staff)}</span>` : ""
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

function openTaskModal(id, presetDate) {
  editingTaskId = id || null;
  const t = id ? state.tasks.find(x => x.id === id) : null;
  el(root, "task-modal-title").textContent = t ? "Edit task" : "Add task";
  setVal(root, "t-text", t?.text || "");
  setVal(root, "t-date", t?.date || presetDate || todayStr());
  setTime(root, "t-time", t?.time || "12:00");
  setVal(root, "t-staff", t?.staff || "");
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
