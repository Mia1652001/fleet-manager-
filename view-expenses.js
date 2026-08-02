// Staff expenses — the money that goes out through the team's hands: car
// washes, small repairs, fuel, parking. One entry per spend, with who spent
// it, what for, and optionally which car it belongs to. Categories are the
// company's own, defined in Settings the way brokers and staff are.
import { db, setSync } from "./firebase-init.js";
import { collection, addDoc, updateDoc, deleteDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  state, onDataChange, esc, formatDate, formatAmount, todayStr,
  staffNames, expenseCategoryNames, orderedCars, initPanelToggle,
  el, val, setVal, openModal, closeModal, showError
} from "./store.js";

let root = null;
let editingId = null;
let periodYear = "";
let periodMonth = "";
let categoryFilter = "";
let mode = "board";                  // the pilot plans by category, so board leads
let staffFilter = new Set();         // empty = everyone; "__none__" = no name given
let summaryOpen = () => true;
let boardDrag = null;

const MONTH_NAMES = ["January","February","March","April","May","June",
  "July","August","September","October","November","December"];

export function mount(container) {
  root = container;

  el(root, "search").addEventListener("input", render);
  el(root, "add-expense").addEventListener("click", () => openExpenseModal(null));
  summaryOpen = initPanelToggle(root, "expensesShowSummary", "toggle-summary", "hide-summary", "Summary");

  root.querySelectorAll("[data-mode]").forEach(t => t.addEventListener("click", () => {
    mode = t.dataset.mode;
    root.querySelectorAll("[data-mode]").forEach(x => x.classList.toggle("active", x === t));
    render();
  }));

  // The staff filter, same dropdown-of-ticks the Tasks page uses.
  el(root, "staff-filter-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const panel = el(root, "staff-filter-panel");
    buildStaffPanel();
    panel.style.display = panel.style.display === "none" ? "block" : "none";
  });
  el(root, "staff-filter-panel").addEventListener("click", (e) => {
    e.stopPropagation();
    if (e.target.closest("[data-clear-staff]")) { staffFilter.clear(); render(); return; }
    const box = e.target.closest("input[data-staff]");
    if (!box) return;
    if (box.checked) staffFilter.add(box.dataset.staff); else staffFilter.delete(box.dataset.staff);
    render();
  });
  document.addEventListener("click", () => {
    const panel = el(root, "staff-filter-panel");
    if (panel) panel.style.display = "none";
  });

  wireBoard();
  el(root, "save-expense").addEventListener("click", saveExpense);

  el(root, "period-year").addEventListener("change", () => {
    periodYear = el(root, "period-year").value; render();
  });
  el(root, "period-month").addEventListener("change", () => {
    periodMonth = el(root, "period-month").value; render();
  });
  el(root, "period-category").addEventListener("change", () => {
    categoryFilter = el(root, "period-category").value; render();
  });

  root.querySelectorAll("[data-close]").forEach(b =>
    b.addEventListener("click", () => closeModal(root, b.dataset.close)));
  root.querySelectorAll(".overlay").forEach(o =>
    o.addEventListener("click", e => { if (e.target === o) o.classList.remove("open"); }));

  el(root, "list").addEventListener("click", async (e) => {
    const tick = e.target.closest("[data-tick]");
    if (tick) {
      const x = state.expenses.find(v => v.id === tick.dataset.tick);
      if (x) { try { await updateDoc(doc(db, "expenses", x.id), { done: !x.done }); } catch {} }
      return;
    }
    const btn = e.target.closest("button");
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.act === "edit") { openExpenseModal(id); return; }
    if (btn.dataset.act === "delete") {
      const x = state.expenses.find(v => v.id === id);
      if (!x) return;
      if (!confirm(
        `Delete this expense?\n\n${formatDate(x.date)} · ${formatAmount(x.amount)}` +
        `${x.category ? ` · ${x.category}` : ""}${x.staff ? ` · ${x.staff}` : ""}\n\n` +
        `It leaves the totals and the backups. This cannot be undone.`)) return;
      btn.disabled = true;
      setSync("saving");
      try { await deleteDoc(doc(db, "expenses", id)); }
      catch (err) { alert("Couldn't delete (" + (err.code || err.message) + ")."); setSync("error"); }
      return;
    }
  });

  onDataChange(() => { if (root.classList.contains("active")) render(); });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (root.classList.contains("active") && mode === "board") render();
    }, 150);
  });
}

function buildStaffPanel() {
  const names = staffNames();
  el(root, "staff-filter-panel").innerHTML =
    `<div class="multi-row"><button type="button" class="btn" data-clear-staff>Everyone</button></div>` +
    names.map(n => `<label class="multi-row"><input type="checkbox" data-staff="${esc(n)}"
      ${staffFilter.has(n) ? "checked" : ""}> ${esc(n)}</label>`).join("") +
    `<label class="multi-row"><input type="checkbox" data-staff="__none__"
      ${staffFilter.has("__none__") ? "checked" : ""}> No name given</label>`;
}

function matchesStaff(x) {
  if (!staffFilter.size) return true;
  return [...staffFilter].some(v =>
    v === "__none__"
      ? !(x.staff || "").trim()
      : (x.staff || "").trim().toLowerCase() === v.trim().toLowerCase());
}

function inPeriodFilter(x) {
  const d = x.date || "";
  if (periodYear && d.slice(0, 4) !== periodYear) return false;
  if (periodMonth && d.slice(5, 7) !== periodMonth) return false;
  if (categoryFilter &&
      (x.category || "").trim().toLowerCase() !== categoryFilter.trim().toLowerCase()) return false;
  return true;
}

function refreshFilterOptions() {
  // Years present in the data; months fixed; categories from Settings first,
  // typed values as fallback — same pattern as everywhere else names live.
  const ys = el(root, "period-year");
  const years = [...new Set(state.expenses.map(x => (x.date || "").slice(0, 4)).filter(Boolean))]
    .sort().reverse();
  const ySig = years.join("|");
  if (ys.dataset.built !== ySig) {
    ys.innerHTML = `<option value="">All years</option>` +
      years.map(y => `<option value="${y}">${y}</option>`).join("");
    ys.dataset.built = ySig;
    ys.value = years.includes(periodYear) ? periodYear : "";
    periodYear = ys.value;
  }

  const ms = el(root, "period-month");
  if (!ms.dataset.built) {
    ms.innerHTML = `<option value="">All months</option>` +
      MONTH_NAMES.map((m, i) =>
        `<option value="${String(i + 1).padStart(2, "0")}">${m}</option>`).join("");
    ms.dataset.built = "1";
    ms.value = periodMonth;
  }

  const cs = el(root, "period-category");
  const names = expenseCategoryNames();
  const cSig = names.join("|");
  if (cs.dataset.built !== cSig) {
    cs.innerHTML = `<option value="">All categories</option>` +
      names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
    cs.dataset.built = cSig;
    const keep = names.find(n => n.toLowerCase() === categoryFilter.toLowerCase());
    cs.value = keep || "";
    categoryFilter = cs.value;
  }
}

function carLabel(carId) {
  const c = state.cars.find(v => v.id === carId);
  return c ? `${c.make} ${c.model} (${c.plate || "no plate"})` : "";
}

export function render() {
  if (!root) return;
  refreshFilterOptions();
  fillSuggestions();
  const search = el(root, "search").value.toLowerCase();

  const t = todayStr();
  const thisMonth = state.expenses
    .filter(x => (x.date || "").slice(0, 7) === t.slice(0, 7))
    .reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const allTime = state.expenses.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  el(root, "stats").innerHTML = !summaryOpen() ? "" : `
    <div class="stat"><div class="stat-label">This month</div><div class="stat-val">${formatAmount(thisMonth)}</div></div>
    <div class="stat"><div class="stat-label">All time</div><div class="stat-val">${formatAmount(allTime)}</div></div>
  `;

  const list = state.expenses
    .filter(inPeriodFilter)
    .filter(matchesStaff)
    .filter(x => `${x.staff || ""} ${x.category || ""} ${x.note || ""} ${carLabel(x.carId)}`
      .toLowerCase().includes(search))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  el(root, "staff-filter-btn").textContent =
    staffFilter.size ? `Staff (${staffFilter.size})` : "All staff";

  const total = list.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const bits = [];
  if (periodYear || periodMonth) {
    bits.push(periodMonth ? `${MONTH_NAMES[Number(periodMonth) - 1]}${periodYear ? " " + periodYear : ""}` : periodYear);
  }
  if (categoryFilter) bits.push(categoryFilter);
  el(root, "list-total").textContent =
    `${list.length} expense${list.length === 1 ? "" : "s"}${bits.length ? ` · ${bits.join(" · ")}` : ""} · ${formatAmount(total)}`;

  el(root, "list").style.display = mode === "list" ? "" : "none";
  el(root, "xboard").style.display = mode === "board" ? "" : "none";
  if (mode === "board") { renderBoard(list); return; }

  const listEl = el(root, "list");
  if (list.length === 0) {
    listEl.innerHTML = (periodYear || periodMonth || categoryFilter || search)
      ? '<div class="empty">No expenses match these filters.</div>'
      : '<div class="empty">No expenses yet. Add the first with "+ Add expense".</div>';
    return;
  }

  listEl.innerHTML = list.map(x => `
    <div class="item-card available${x.done ? " expense-done" : ""}">
      <div class="card-top">
        <div style="display:flex;align-items:center;gap:10px;">
          <input type="checkbox" class="job-tick" data-tick="${x.id}" ${x.done ? "checked" : ""}
            title="Tick when this expense is settled">
          <div>
          <div class="card-title">${esc(formatAmount(x.amount))}${x.category ? ` — ${esc(x.category)}` : ""}</div>
          <div class="card-sub">${formatDate(x.date)}${x.staff ? ` · ${esc(x.staff)}` : ""}</div>
          </div>
        </div>
      </div>
      ${(x.carId || x.note) ? `
      <div class="card-details">
        ${x.carId ? `<span>Car: <strong>${esc(carLabel(x.carId))}</strong></span>` : ""}
        ${x.note ? `<span>${esc(x.note)}</span>` : ""}
      </div>` : ""}
      <div class="card-actions">
        <button class="btn" data-act="edit" data-id="${x.id}">Edit</button>
        <button class="btn danger" data-act="delete" data-id="${x.id}">Delete</button>
      </div>
    </div>`).join("");
}

function fillSuggestions() {
  const put = (id, names) => {
    const dl = document.getElementById(id);
    if (dl) dl.innerHTML = names.map(v => `<option value="${esc(v)}"></option>`).join("");
  };
  put("dl-expense-categories", expenseCategoryNames());
}

// Columns are the company's own categories, Settings order first — the same
// rule the Tasks board follows for staff. Days run down, newest first; every
// cell can be dropped on or added to.
function boardColumns(items) {
  const seen = new Map();
  expenseCategoryNames().forEach(n => seen.set(n.toLowerCase(), n));
  items.forEach(x => {
    const n = (x.category || "").trim();
    if (n && !seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n);
  });
  const cols = Array.from(seen.values());
  if (items.some(x => !(x.category || "").trim())) cols.push("");
  return cols;
}

function renderBoard(items) {
  const box = el(root, "xboard");
  const cols = boardColumns(items);
  const days = [...new Set(items.map(x => x.date).filter(Boolean))].sort().reverse();

  if (!days.length) {
    box.style.gridTemplateColumns = "1fr";
    box.innerHTML = '<div class="empty">No expenses here. Add one with "+ Add expense" — it lands in its category\'s column.</div>';
    return;
  }

  const phone = window.matchMedia("(max-width: 640px)").matches;
  box.style.gridTemplateColumns =
    `minmax(84px, 0.6fr) repeat(${cols.length}, minmax(${phone ? 170 : 130}px, 1fr))`;

  const head = `<div class="board-cell board-corner">Day</div>` +
    cols.map(cName => `<div class="board-cell board-head${cName ? "" : " unassigned"}">${cName ? esc(cName) : "Uncategorised"}</div>`).join("");

  const rows = days.map(ds => {
    const cells = cols.map(cName => {
      const mine = items.filter(x => x.date === ds &&
        ((x.category || "").trim().toLowerCase() === cName.toLowerCase()));
      const add = `<button type="button" class="board-add" data-add-day="${ds}"
        data-add-cat="${esc(cName)}" title="Add an expense here">+</button>`;
      return `<div class="board-cell${cName ? "" : " unassigned"}" data-cell-day="${ds}" data-cell-cat="${esc(cName)}">
        ${mine.map(x => `
          <div class="board-chip kind-task${x.done ? " done" : ""}" data-chip="${x.id}">
            <input type="checkbox" class="job-tick" data-tick="${x.id}" ${x.done ? "checked" : ""}>
            <span class="board-chip-main"><strong>${esc(formatAmount(x.amount))}</strong>${x.staff ? ` ${esc(x.staff)}` : ""}${x.note ? ` · ${esc(x.note)}` : ""}</span>
          </div>`).join("")}${add}</div>`;
    }).join("");
    return `<div class="board-cell board-day">${esc(formatDate(ds))}</div>${cells}`;
  }).join("");

  box.innerHTML = head + rows;
}

function wireBoard() {
  const box = el(root, "xboard");

  box.addEventListener("click", async (e) => {
    const tick = e.target.closest("[data-tick]");
    if (tick) {
      const x = state.expenses.find(v => v.id === tick.dataset.tick);
      if (x) { try { await updateDoc(doc(db, "expenses", x.id), { done: !x.done }); } catch {} }
      return;
    }
    const add = e.target.closest("[data-add-day]");
    if (add) { openExpenseModal(null, { date: add.dataset.addDay, category: add.dataset.addCat }); return; }
    if (boardDrag && boardDrag.moved) return;   // a drag's release is not a click
    const chip = e.target.closest("[data-chip]");
    if (chip) openExpenseModal(chip.dataset.chip);
  });

  // Dragging a chip to another cell moves the expense to that day and
  // category in one motion — a plain record, so no confirmation needed.
  box.addEventListener("pointerdown", (e) => {
    const chip = e.target.closest("[data-chip]");
    if (!chip || e.target.closest(".job-tick")) return;
    boardDrag = { id: chip.dataset.chip, x: e.clientX, y: e.clientY, moved: false, to: null };
  });
  box.addEventListener("pointermove", (e) => {
    if (!boardDrag) return;
    if (!boardDrag.moved) {
      if (Math.hypot(e.clientX - boardDrag.x, e.clientY - boardDrag.y) < 7) return;
      boardDrag.moved = true;
      try { box.setPointerCapture(e.pointerId); } catch {}
    }
    const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-cell-day]");
    box.querySelectorAll(".board-cell.drop-target").forEach(c => c.classList.remove("drop-target"));
    boardDrag.to = null;
    if (cell) { cell.classList.add("drop-target"); boardDrag.to = { day: cell.dataset.cellDay, cat: cell.dataset.cellCat }; }
    e.preventDefault();
  });
  const finish = async (e) => {
    if (!boardDrag) return;
    const drag = boardDrag;
    boardDrag = null;
    try { box.releasePointerCapture(e.pointerId); } catch {}
    box.querySelectorAll(".board-cell.drop-target").forEach(c => c.classList.remove("drop-target"));
    if (!drag.moved || !drag.to) return;
    try { await updateDoc(doc(db, "expenses", drag.id), { date: drag.to.day, category: drag.to.cat }); }
    catch (err) { alert("Couldn't move (" + (err.code || err.message) + ")."); }
  };
  box.addEventListener("pointerup", finish);
  box.addEventListener("pointercancel", finish);
}

function openExpenseModal(id, preset) {
  editingId = id;
  const x = id ? state.expenses.find(v => v.id === id) : null;
  el(root, "expense-title").textContent = x ? "Edit expense" : "Add expense";

  setVal(root, "x-date", x?.date || preset?.date || todayStr());
  setVal(root, "x-staff", x?.staff || "");
  setVal(root, "x-category", x?.category || preset?.category || "");
  setVal(root, "x-amount", x?.amount ?? "");
  setVal(root, "x-note", x?.note || "");

  const sel = el(root, "x-car");
  sel.innerHTML = `<option value="">— not car-related —</option>` +
    orderedCars().map(c =>
      `<option value="${c.id}">${esc(`${c.year || ""} ${c.make} ${c.model}`.trim())} (${esc(c.plate || "no plate")})</option>`).join("");
  sel.value = x?.carId || "";

  showError(root, "expense-error", null);
  openModal(root, "expense-modal");
}

async function saveExpense() {
  const date = val(root, "x-date");
  const amount = parseFloat(val(root, "x-amount"));
  if (!date) { showError(root, "expense-error", "Enter the date."); return; }
  if (!Number.isFinite(amount) || amount <= 0) {
    showError(root, "expense-error", "Enter the amount spent."); return;
  }

  const data = {
    date,
    staff: val(root, "x-staff"),
    category: val(root, "x-category"),
    amount,
    carId: el(root, "x-car").value || "",
    note: val(root, "x-note")
  };

  const btn = el(root, "save-expense");
  btn.disabled = true; btn.textContent = "Saving...";
  setSync("saving");
  try {
    if (editingId) {
      await updateDoc(doc(db, "expenses", editingId), data);
    } else {
      await addDoc(collection(db, "expenses"), {
        companyId: state.ctx.companyId,
        done: false,
        createdAt: new Date().toISOString(),
        by: state.ctx?.user?.email || "",
        ...data
      });
    }
    closeModal(root, "expense-modal");
    editingId = null;
  } catch (e) {
    showError(root, "expense-error", "Couldn't save (" + (e.code || e.message) + "). Try again.");
    setSync("error");
  }
  btn.disabled = false; btn.textContent = "Save";
}
