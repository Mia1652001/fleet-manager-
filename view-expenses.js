// Staff expenses — the money that goes out through the team's hands: car
// washes, small repairs, fuel, parking. One entry per spend, with who spent
// it, what for, and optionally which car it belongs to. Categories are the
// company's own, defined in Settings the way brokers and staff are.
import { db, setSync } from "./firebase-init.js";
import { collection, addDoc, updateDoc, deleteDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  state, onDataChange, esc, formatDate, formatAmount, todayStr,
  staffNames, expenseCategoryNames, orderedCars,
  el, val, setVal, openModal, closeModal, showError
} from "./store.js";

let root = null;
let editingId = null;
let periodYear = "";
let periodMonth = "";
let categoryFilter = "";

const MONTH_NAMES = ["January","February","March","April","May","June",
  "July","August","September","October","November","December"];

export function mount(container) {
  root = container;

  el(root, "search").addEventListener("input", render);
  el(root, "add-expense").addEventListener("click", () => openExpenseModal(null));
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
  el(root, "stats").innerHTML = `
    <div class="stat"><div class="stat-label">This month</div><div class="stat-val">${formatAmount(thisMonth)}</div></div>
    <div class="stat"><div class="stat-label">All time</div><div class="stat-val">${formatAmount(allTime)}</div></div>
  `;

  const list = state.expenses
    .filter(inPeriodFilter)
    .filter(x => `${x.staff || ""} ${x.category || ""} ${x.note || ""} ${carLabel(x.carId)}`
      .toLowerCase().includes(search))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const total = list.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const bits = [];
  if (periodYear || periodMonth) {
    bits.push(periodMonth ? `${MONTH_NAMES[Number(periodMonth) - 1]}${periodYear ? " " + periodYear : ""}` : periodYear);
  }
  if (categoryFilter) bits.push(categoryFilter);
  el(root, "list-total").textContent =
    `${list.length} expense${list.length === 1 ? "" : "s"}${bits.length ? ` · ${bits.join(" · ")}` : ""} · ${formatAmount(total)}`;

  const listEl = el(root, "list");
  if (list.length === 0) {
    listEl.innerHTML = (periodYear || periodMonth || categoryFilter || search)
      ? '<div class="empty">No expenses match these filters.</div>'
      : '<div class="empty">No expenses yet. Add the first with "+ Add expense".</div>';
    return;
  }

  listEl.innerHTML = list.map(x => `
    <div class="item-card available">
      <div class="card-top">
        <div>
          <div class="card-title">${esc(formatAmount(x.amount))}${x.category ? ` — ${esc(x.category)}` : ""}</div>
          <div class="card-sub">${formatDate(x.date)}${x.staff ? ` · ${esc(x.staff)}` : ""}</div>
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

function openExpenseModal(id) {
  editingId = id;
  const x = id ? state.expenses.find(v => v.id === id) : null;
  el(root, "expense-title").textContent = x ? "Edit expense" : "Add expense";

  setVal(root, "x-date", x?.date || todayStr());
  setVal(root, "x-staff", x?.staff || "");
  setVal(root, "x-category", x?.category || "");
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
