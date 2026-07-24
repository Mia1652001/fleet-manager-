// Bookings view — calendar and reservations with conflict prevention.
import { db, setSync } from "./firebase-init.js";
import { collection, addDoc, updateDoc, deleteDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  state, onDataChange, esc, formatDate, todayStr, overlaps, bookingCarLabel, bookingState,
  el, val, setVal, openModal, closeModal, showError
} from "./store.js";

let root = null;
let filter = "all";
let editingBookingId = null;
let calYear, calMonth;
let planner = "timeline"; // "timeline" | "month"

export function mount(container) {
  root = container;
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth();

  el(root, "search").addEventListener("input", render);
  el(root, "new-booking").addEventListener("click", () => openBookingModal(null));
  el(root, "save-booking").addEventListener("click", saveBooking);
  el(root, "b-customer").addEventListener("change", toggleNewCustomer);

  el(root, "view-timeline").addEventListener("click", () => setPlanner("timeline"));
  el(root, "view-month").addEventListener("click", () => setPlanner("month"));

  // Clicking a booking bar in the timeline opens it for editing
  el(root, "timeline").addEventListener("click", (e) => {
    const bar = e.target.closest("[data-booking]");
    if (bar) openBookingModal(bar.dataset.booking);
  });

  el(root, "cal-prev").addEventListener("click", () => shiftMonth(-1));
  el(root, "cal-next").addEventListener("click", () => shiftMonth(1));
  el(root, "cal-today").addEventListener("click", () => {
    const d = new Date();
    calYear = d.getFullYear(); calMonth = d.getMonth();
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
  renderStats();
  if (planner === "timeline") renderTimeline(); else renderCalendar();
  renderList();
}

function setPlanner(which) {
  planner = which;
  el(root, "view-timeline").classList.toggle("active", which === "timeline");
  el(root, "view-month").classList.toggle("active", which === "month");
  el(root, "timeline-wrap").style.display = which === "timeline" ? "block" : "none";
  el(root, "calendar").style.display = which === "month" ? "grid" : "none";
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
  const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  el(root, "cal-title").textContent = `${monthNames[calMonth]} ${calYear}`;

  const wrap = el(root, "timeline-wrap");
  const grid = el(root, "timeline");
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const t = todayStr();
  const pad = n => String(n).padStart(2, "0");
  const dayStr = d => `${calYear}-${pad(calMonth + 1)}-${pad(d)}`;

  if (state.cars.length === 0) {
    grid.innerHTML = '<div class="tl-empty">No cars yet. Add cars on the Fleet view and they will appear here.</div>';
    grid.style.gridTemplateColumns = "1fr";
    return;
  }

  const cars = state.cars.slice().sort((a, b) =>
    (a.make + a.model).localeCompare(b.make + b.model));

  grid.style.gridTemplateColumns = `170px repeat(${daysInMonth}, 36px)`;

  const dowShort = ["Su","Mo","Tu","We","Th","Fr","Sa"];
  let html = `<div class="tl-corner" style="grid-row:1;grid-column:1;">Vehicle</div>`;

  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(calYear, calMonth, d).getDay();
    const cls = dayStr(d) === t ? "today" : (dow === 0 || dow === 6) ? "weekend" : "";
    html += `<div class="tl-daynum ${cls}" style="grid-row:1;grid-column:${d + 1};">
      <span class="dow">${dowShort[dow]}</span>${d}</div>`;
  }

  cars.forEach((car, i) => {
    const row = i + 2;
    const oos = !!car.outOfService;

    html += `<div class="tl-car ${oos ? "oos" : ""}" style="grid-row:${row};grid-column:1;">
      <strong>${esc(`${car.make} ${car.model}`)}</strong>
      <span>${esc(car.plate || "no plate")}</span>
    </div>`;

    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(calYear, calMonth, d).getDay();
      const cls = dayStr(d) === t ? "today" : (dow === 0 || dow === 6) ? "weekend" : "";
      html += `<div class="tl-cell ${cls}" style="grid-row:${row};grid-column:${d + 1};"></div>`;
    }

    if (oos) {
      html += `<div class="tl-oos-bar" style="grid-row:${row};grid-column:2 / ${daysInMonth + 2};">Out of service</div>`;
    }

    // Bookings for this car that touch the displayed month
    const first = dayStr(1);
    const last = dayStr(daysInMonth);
    state.bookings
      .filter(b => b.carId === car.id && b.startDate <= last && b.endDate >= first)
      .sort((a, b) => a.startDate.localeCompare(b.startDate))
      .forEach(b => {
        // Clip the bar to the visible month
        const startDay = b.startDate < first ? 1 : Number(b.startDate.slice(8, 10));
        const endDay = b.endDate > last ? daysInMonth : Number(b.endDate.slice(8, 10));
        if (!(startDay >= 1 && endDay >= startDay)) return;

        const s = bookingState(b);
        const span = endDay - startDay + 1;
        const label = span >= 3
          ? `${esc(b.renter)}`
          : span === 2 ? esc((b.renter || "").slice(0, 6)) : "";
        const title = `${b.renter} · ${formatDate(b.startDate)} – ${formatDate(b.endDate)}`;

        html += `<div class="tl-bar ${s}" data-booking="${b.id}" title="${esc(title)}"
          style="grid-row:${row};grid-column:${startDay + 1} / ${endDay + 2};">${label}</div>`;
      });
  });

  grid.innerHTML = html;

  // Scroll so today is visible when looking at the current month
  const now = new Date();
  if (now.getFullYear() === calYear && now.getMonth() === calMonth) {
    wrap.scrollLeft = Math.max(0, (now.getDate() - 3) * 36);
  } else {
    wrap.scrollLeft = 0;
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
      <span style="opacity:0.7;">Tap a booking to edit it</span>`;
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

function renderList() {
  const search = el(root, "search").value.toLowerCase();

  let list = state.bookings.filter(b => {
    const s = bookingState(b);
    const mf = filter === "all" ? s !== "completed" : s === filter;
    const ms = `${bookingCarLabel(b)} ${b.renter || ""}`.toLowerCase().includes(search);
    return mf && ms;
  });

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
        <span>Pick-up: <strong>${formatDate(b.startDate)}</strong></span>
        <span>Return: <strong>${formatDate(b.endDate)}</strong></span>
        <span>Phone: <strong>${esc(b.phone) || "—"}</strong></span>
      </div>
      <div class="card-actions">
        ${s !== "completed" ? `<button class="btn" data-act="complete" data-id="${b.id}">Mark returned</button>
        <button class="btn" data-act="edit" data-id="${b.id}">Edit</button>` : ""}
        <button class="btn danger" data-act="delete" data-id="${b.id}">Delete</button>
      </div>
    </div>`;
  }).join("");
}

// ---------- Create / edit ----------
function toggleNewCustomer() {
  const isNew = el(root, "b-customer").value === "__new__";
  el(root, "b-new-fields").style.display = isNew ? "block" : "none";
}

function openBookingModal(bookingId) {
  if (state.cars.length === 0) { alert("Add at least one car in the Fleet view first."); return; }

  editingBookingId = bookingId || null;
  const editing = editingBookingId ? state.bookings.find(b => b.id === editingBookingId) : null;
  el(root, "booking-modal-title").textContent = editing ? "Edit booking" : "New booking";

  const sel = el(root, "b-car");
  sel.innerHTML = state.cars.slice()
    .sort((a, b) => (a.make + a.model).localeCompare(b.make + b.model))
    .map(c => `<option value="${c.id}">${esc(`${c.year || ""} ${c.make} ${c.model} (${c.plate || "no plate"})`.trim())}</option>`)
    .join("");

  const csel = el(root, "b-customer");
  csel.innerHTML = state.customers.slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(c => `<option value="${c.id}">${esc(c.name)}${c.phone ? " · " + esc(c.phone) : ""}</option>`)
    .join("") + `<option value="__new__">+ New customer...</option>`;
  csel.value = state.customers.length ? csel.options[0].value : "__new__";

  ["b-name", "b-phone", "b-email", "b-start", "b-end"].forEach(n => setVal(root, n, ""));

  if (editing) {
    sel.value = editing.carId;
    setVal(root, "b-start", editing.startDate);
    setVal(root, "b-end", editing.endDate);
    if (editing.customerId && state.customers.some(c => c.id === editing.customerId)) {
      csel.value = editing.customerId;
    } else {
      csel.value = "__new__";
      setVal(root, "b-name", editing.renter || "");
      setVal(root, "b-phone", editing.phone || "");
    }
  }

  toggleNewCustomer();
  showError(root, "booking-error", null);
  openModal(root, "booking-modal");
}

async function saveBooking() {
  showError(root, "booking-error", null);

  const carId = el(root, "b-car").value;
  const choice = el(root, "b-customer").value;
  const startDate = val(root, "b-start");
  const endDate = val(root, "b-end");

  let customerId, renter, phone, email;
  if (choice === "__new__") {
    renter = val(root, "b-name");
    phone = val(root, "b-phone");
    email = val(root, "b-email");
    if (!renter) { showError(root, "booking-error", "Enter the new customer's name."); return; }
  } else {
    const c = state.customers.find(x => x.id === choice);
    if (!c) { showError(root, "booking-error", "Pick a customer."); return; }
    customerId = c.id; renter = c.name; phone = c.phone || "";
  }

  if (!carId || !startDate || !endDate) {
    showError(root, "booking-error", "Please fill in car and both dates."); return;
  }
  if (endDate < startDate) {
    showError(root, "booking-error", "Return date can't be before pick-up date."); return;
  }

  const clash = state.bookings.find(b =>
    b.id !== editingBookingId && b.carId === carId && b.status !== "completed" &&
    overlaps(startDate, endDate, b.startDate, b.endDate));
  if (clash) {
    showError(root, "booking-error", `This car is already booked ${formatDate(clash.startDate)} – ${formatDate(clash.endDate)} (${clash.renter}). Choose different dates or another car.`);
    return;
  }

  const btn = el(root, "save-booking");
  btn.disabled = true; btn.textContent = "Saving...";
  setSync("saving");
  try {
    if (!customerId) {
      const ref = await addDoc(collection(db, "customers"), {
        companyId: state.ctx.companyId, name: renter, phone, email: email || "",
        license: "", notes: "", createdAt: new Date().toISOString()
      });
      customerId = ref.id;
    }

    const car = state.cars.find(x => x.id === carId);
    const dailyRate = car?.dailyRate || 0;
    const carName = car ? `${car.year || ""} ${car.make} ${car.model} (${car.plate || "no plate"})`.trim() : "";

    if (editingBookingId) {
      await updateDoc(doc(db, "bookings", editingBookingId), { carId, customerId, renter, phone, startDate, endDate, dailyRate, carName });
    } else {
      await addDoc(collection(db, "bookings"), {
        companyId: state.ctx.companyId, carId, customerId, renter, phone, startDate, endDate,
        dailyRate, carName, paid: false, status: "open", createdAt: new Date().toISOString()
      });
    }
    closeModal(root, "booking-modal");
    editingBookingId = null;
  } catch (e) {
    showError(root, "booking-error", "Couldn't save the booking (" + (e.code || e.message) + ").");
    setSync("error");
  }
  btn.disabled = false; btn.textContent = "Save booking";
}

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
