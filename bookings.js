// Bookings page — reservation calendar with conflict prevention
import { db, requireAuth, setCompanyLabel, setSync, wireLogout } from "./firebase-init.js";
import { collection, query, where, onSnapshot, addDoc, updateDoc, deleteDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let bookings = [];
let cars = [];
let customers = [];
let filter = "all";
let ctx = null;
let calYear, calMonth; // currently displayed month

(async function init() {
  ctx = await requireAuth();
  if (!ctx) return;
  document.getElementById("boot").style.display = "none";
  document.getElementById("app").style.display = "block";
  setCompanyLabel(ctx.companyName);
  wireLogout();
  wireUi();

  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth();

  // Live listeners for both collections
  onSnapshot(query(collection(db, "bookings"), where("companyId", "==", ctx.companyId)), (snap) => {
    bookings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    setSync("live");
    render();
  }, () => setSync("error"));

  onSnapshot(query(collection(db, "cars"), where("companyId", "==", ctx.companyId)), (snap) => {
    cars = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  });

  onSnapshot(query(collection(db, "customers"), where("companyId", "==", ctx.companyId)), (snap) => {
    customers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  });
})();

// ---------- Helpers ----------
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatDate(d) {
  if (!d) return "—";
  const p = d.split("-");
  return `${p[2]}/${p[1]}/${p[0]}`;
}

// A booking's effective status, derived from dates + stored status
function bookingState(b) {
  if (b.status === "completed") return "completed";
  const t = todayStr();
  if (b.endDate < t) return "overdue";     // past return date, not marked returned
  if (b.startDate > t) return "upcoming";  // starts in the future
  return "active-b";                        // currently ongoing
}

function stateLabel(s) {
  return { "active-b": "Active", upcoming: "Upcoming", overdue: "Overdue", completed: "Completed" }[s] || s;
}

function carLabel(carId) {
  const c = cars.find(x => x.id === carId);
  return c ? `${c.year || ""} ${c.make} ${c.model} (${c.plate || "no plate"})`.trim() : "Unknown car";
}

// Date-range overlap: two bookings clash if their ranges intersect
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

// ---------- UI wiring ----------
function wireUi() {
  document.getElementById("search").addEventListener("input", render);
  document.getElementById("new-booking-btn").addEventListener("click", openBookingModal);
  document.getElementById("save-booking-btn").addEventListener("click", saveBooking);
  document.getElementById("b-customer").addEventListener("change", toggleNewCustomerFields);

  document.getElementById("cal-prev").addEventListener("click", () => { shiftMonth(-1); });
  document.getElementById("cal-next").addEventListener("click", () => { shiftMonth(1); });
  document.getElementById("cal-today").addEventListener("click", () => {
    const now = new Date();
    calYear = now.getFullYear(); calMonth = now.getMonth();
    render();
  });

  document.querySelectorAll("#filters .tab").forEach(t => t.addEventListener("click", () => {
    filter = t.dataset.f;
    document.querySelectorAll("#filters .tab").forEach(x => x.classList.remove("active"));
    t.classList.add("active");
    render();
  }));

  document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => {
    document.getElementById(b.dataset.close).classList.remove("open");
  }));

  document.querySelectorAll(".overlay").forEach(o => o.addEventListener("click", e => {
    if (e.target === o) o.classList.remove("open");
  }));

  document.getElementById("booking-list").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.act === "complete") completeBooking(id);
    else if (btn.dataset.act === "delete") deleteBooking(id);
  });
}

function shiftMonth(delta) {
  calMonth += delta;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  if (calMonth > 11) { calMonth = 0; calYear++; }
  render();
}

// ---------- Render ----------
function render() {
  renderStats();
  renderCalendar();
  renderList();
}

function renderStats() {
  const states = bookings.map(bookingState);
  const count = s => states.filter(x => x === s).length;
  document.getElementById("stats").innerHTML = `
    <div class="stat"><div class="stat-label">Active now</div><div class="stat-val green">${count("active-b")}</div></div>
    <div class="stat"><div class="stat-label">Upcoming</div><div class="stat-val amber">${count("upcoming")}</div></div>
    <div class="stat"><div class="stat-label">Overdue</div><div class="stat-val red">${count("overdue")}</div></div>
    <div class="stat"><div class="stat-label">Completed</div><div class="stat-val">${count("completed")}</div></div>
  `;
}

function renderCalendar() {
  const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  document.getElementById("cal-title").textContent = `${monthNames[calMonth]} ${calYear}`;

  const first = new Date(calYear, calMonth, 1);
  // Monday-first weekday index
  let startDow = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const t = todayStr();

  let html = ["Mo","Tu","We","Th","Fr","Sa","Su"].map(d => `<div class="cal-dow">${d}</div>`).join("");

  // Leading blanks (previous month)
  for (let i = 0; i < startDow; i++) html += `<div class="cal-day other-month"></div>`;

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${calYear}-${String(calMonth+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
    const dayBookings = bookings.filter(b => b.status !== "completed" && b.startDate <= dateStr && dateStr <= b.endDate);
    const isToday = dateStr === t;

    const shown = dayBookings.slice(0, 2);
    const extra = dayBookings.length - shown.length;

    html += `
      <div class="cal-day${isToday ? " today" : ""}">
        <div class="cal-day-num">${day}</div>
        ${shown.map(b => `<div class="cal-booking ${bookingState(b)}">${esc(b.renter)}</div>`).join("")}
        ${extra > 0 ? `<div class="cal-more">+${extra} more</div>` : ""}
        <div class="cal-dots">${dayBookings.slice(0,4).map(b => `<div class="cal-dot ${bookingState(b)}"></div>`).join("")}</div>
      </div>`;
  }

  document.getElementById("calendar").innerHTML = html;
}

function renderList() {
  const search = document.getElementById("search").value.toLowerCase();

  let list = bookings.filter(b => {
    const s = bookingState(b);
    const mf = filter === "all" ? s !== "completed" : s === filter;
    const ms = `${carLabel(b.carId)} ${b.renter || ""}`.toLowerCase().includes(search);
    return mf && ms;
  });

  // Overdue first, then by start date
  const order = { overdue: 0, "active-b": 1, upcoming: 2, completed: 3 };
  list.sort((a,b) => (order[bookingState(a)] - order[bookingState(b)]) || a.startDate.localeCompare(b.startDate));

  const el = document.getElementById("booking-list");
  if (list.length === 0) { el.innerHTML = '<div class="empty">No bookings here yet. Create one with the button above.</div>'; return; }

  el.innerHTML = list.map(b => {
    const s = bookingState(b);
    return `
    <div class="item-card ${s}">
      <div class="card-top">
        <div>
          <div class="card-title">${esc(b.renter)}</div>
          <div class="card-sub">${esc(carLabel(b.carId))}</div>
        </div>
        <span class="badge ${s}">${stateLabel(s)}</span>
      </div>
      <div class="card-details">
        <span>Pick-up: <strong>${formatDate(b.startDate)}</strong></span>
        <span>Return: <strong>${formatDate(b.endDate)}</strong></span>
        <span>Phone: <strong>${esc(b.phone) || "—"}</strong></span>
      </div>
      <div class="card-actions">
        ${s !== "completed" ? `<button class="btn" data-act="complete" data-id="${b.id}">Mark returned</button>` : ""}
        <button class="btn danger" data-act="delete" data-id="${b.id}">Delete</button>
      </div>
    </div>`;
  }).join("");
}

// ---------- Actions ----------
function openBookingModal() {
  const sel = document.getElementById("b-car");
  if (cars.length === 0) { alert("Add at least one car in the Fleet page first."); return; }
  sel.innerHTML = cars
    .slice()
    .sort((a,b) => (a.make+a.model).localeCompare(b.make+b.model))
    .map(c => `<option value="${c.id}">${esc(`${c.year || ""} ${c.make} ${c.model} (${c.plate || "no plate"})`.trim())}</option>`)
    .join("");

  // Customer dropdown: existing customers + "new customer" option
  const csel = document.getElementById("b-customer");
  csel.innerHTML = customers
    .slice()
    .sort((a,b) => a.name.localeCompare(b.name))
    .map(c => `<option value="${c.id}">${esc(c.name)}${c.phone ? " · " + esc(c.phone) : ""}</option>`)
    .join("") + `<option value="__new__">+ New customer...</option>`;
  csel.value = customers.length ? csel.options[0].value : "__new__";
  toggleNewCustomerFields();

  ["b-name","b-phone","b-start","b-end"].forEach(i => document.getElementById(i).value = "");
  document.getElementById("booking-error").classList.remove("show");
  document.getElementById("booking-modal").classList.add("open");
}

function toggleNewCustomerFields() {
  const isNew = document.getElementById("b-customer").value === "__new__";
  document.getElementById("new-customer-fields").style.display = isNew ? "block" : "none";
}

async function saveBooking() {
  const errEl = document.getElementById("booking-error");
  errEl.classList.remove("show");

  const carId = document.getElementById("b-car").value;
  const customerChoice = document.getElementById("b-customer").value;
  const startDate = document.getElementById("b-start").value;
  const endDate = document.getElementById("b-end").value;

  let customerId, renter, phone;
  if (customerChoice === "__new__") {
    renter = document.getElementById("b-name").value.trim();
    phone = document.getElementById("b-phone").value.trim();
    if (!renter) { errEl.textContent = "Enter the new customer's name."; errEl.classList.add("show"); return; }
  } else {
    const c = customers.find(x => x.id === customerChoice);
    if (!c) { errEl.textContent = "Pick a customer."; errEl.classList.add("show"); return; }
    customerId = c.id; renter = c.name; phone = c.phone || "";
  }

  // Validation
  if (!carId || !startDate || !endDate) {
    errEl.textContent = "Please fill in car and both dates."; errEl.classList.add("show"); return;
  }
  if (endDate < startDate) {
    errEl.textContent = "Return date can't be before pick-up date."; errEl.classList.add("show"); return;
  }

  // Conflict check: same car, overlapping dates, not completed
  const clash = bookings.find(b =>
    b.carId === carId && b.status !== "completed" && overlaps(startDate, endDate, b.startDate, b.endDate)
  );
  if (clash) {
    errEl.textContent = `This car is already booked ${formatDate(clash.startDate)} – ${formatDate(clash.endDate)} (${clash.renter}). Choose different dates or another car.`;
    errEl.classList.add("show");
    return;
  }

  setSync("saving");

  // If a new customer was typed in, save them to the register first
  if (!customerId) {
    const ref = await addDoc(collection(db, "customers"), {
      companyId: ctx.companyId, name: renter, phone, email: "", license: "", notes: "",
      createdAt: new Date().toISOString()
    });
    customerId = ref.id;
  }

  await addDoc(collection(db, "bookings"), {
    companyId: ctx.companyId, carId, customerId, renter, phone, startDate, endDate,
    status: "open", createdAt: new Date().toISOString()
  });
  document.getElementById("booking-modal").classList.remove("open");
}

async function completeBooking(id) {
  setSync("saving");
  await updateDoc(doc(db, "bookings", id), { status: "completed" });
}

async function deleteBooking(id) {
  if (!confirm("Delete this booking?")) return;
  setSync("saving");
  await deleteDoc(doc(db, "bookings", id));
}
