// Fleet view — inventory with status derived from bookings.
import { db, setSync } from "./firebase-init.js";
import { collection, addDoc, updateDoc, deleteDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  state, onDataChange, esc, formatDate, todayStr, overlaps,
  currentBooking, nextUpcoming, carStatus, serviceDue, openBookingsForCar,
  el, val, setVal, openModal, closeModal, showError
} from "./store.js";

let root = null;
let filter = "all";
let editingCarId = null;
let rentingCarId = null;

export function mount(container) {
  root = container;

  el(root, "search").addEventListener("input", render);
  el(root, "sort").addEventListener("change", render);
  el(root, "add-car").addEventListener("click", () => openCarModal(null));
  el(root, "save-car").addEventListener("click", saveCar);
  el(root, "confirm-rent").addEventListener("click", confirmRent);
  el(root, "r-customer").addEventListener("change", toggleRentNewCustomer);

  // Rate auto-calculation
  const rd = el(root, "c-rate"), rw = el(root, "c-rate-week"), rm = el(root, "c-rate-month");
  const r2 = x => Math.round(x * 100) / 100;
  rd.addEventListener("input", () => { const v = parseFloat(rd.value); if (!isNaN(v)) { rw.value = r2(v * 7); rm.value = r2(v * 30); } });
  rw.addEventListener("input", () => { const v = parseFloat(rw.value); if (!isNaN(v)) { rd.value = r2(v / 7); rm.value = r2((v / 7) * 30); } });
  rm.addEventListener("input", () => { const v = parseFloat(rm.value); if (!isNaN(v)) { rd.value = r2(v / 30); rw.value = r2((v / 30) * 7); } });

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
    if (btn.dataset.act === "rent") openRentModal(id);
    else if (btn.dataset.act === "return") markReturned(id);
    else if (btn.dataset.act === "editcar") openCarModal(id);
    else if (btn.dataset.act === "remove") removeCar(id);
  });

  onDataChange(() => { if (root.classList.contains("active")) render(); });
}

export function render() {
  if (!root) return;
  const search = el(root, "search").value.toLowerCase();
  const sort = el(root, "sort").value;

  const withStatus = state.cars.map(c => ({ ...c, _status: carStatus(c), _booking: currentBooking(c.id) }));
  const available = withStatus.filter(c => c._status === "available").length;
  const service = withStatus.filter(c => c._status === "service").length;
  const rented = withStatus.filter(c => c._status === "rented" || c._status === "overdue").length;

  el(root, "stats").innerHTML = `
    <div class="stat"><div class="stat-label">Total cars</div><div class="stat-val">${state.cars.length}</div></div>
    <div class="stat"><div class="stat-label">Available</div><div class="stat-val green">${available}</div></div>
    <div class="stat"><div class="stat-label">Rented out</div><div class="stat-val amber">${rented}</div></div>
    <div class="stat"><div class="stat-label">Out of service</div><div class="stat-val red">${service}</div></div>
  `;

  let list = withStatus.filter(c => {
    const status = c._status === "overdue" ? "rented" : c._status;
    const mf = filter === "all" || status === filter;
    const renterName = c._booking ? c._booking.renter : "";
    const ms = `${c.make} ${c.model} ${c.plate} ${renterName}`.toLowerCase().includes(search);
    return mf && ms;
  });

  if (sort === "name") list.sort((a, b) => (a.make + a.model).localeCompare(b.make + b.model));
  else list.sort((a, b) => a._status.localeCompare(b._status));

  const listEl = el(root, "list");
  if (list.length === 0) {
    listEl.innerHTML = '<div class="empty">No cars found. Add your first car with the button above.</div>';
    return;
  }

  listEl.innerHTML = list.map(c => {
    const s = c._status;
    const b = c._booking;
    const up = s === "available" ? nextUpcoming(c.id) : null;
    const cls = s === "service" ? "overdue" : s;
    return `
    <div class="item-card ${cls}">
      <div class="card-top">
        <div>
          <div class="card-title">${esc(c.year)} ${esc(c.make)} ${esc(c.model)}</div>
          <div class="card-sub">${esc(c.plate)}${c.dailyRate ? " · " + esc(c.dailyRate) + "/day" : ""}</div>
        </div>
        <span class="badge ${cls}">${s === "available" ? "Available" : s === "overdue" ? "Overdue" : s === "service" ? "Out of service" : "Rented"}</span>
      </div>
      ${serviceDue(c) && s !== "service" ? `<div class="card-details" style="border-top:none;padding-top:0;margin-top:6px;"><span style="color:var(--amber-text);">⚠ Service due ${formatDate(c.nextServiceDate)}</span></div>` : ""}
      ${(c.weeklyRate || c.monthlyRate) ? `
      <div class="card-details" style="border-top:none;padding-top:0;margin-top:6px;">
        <span>Rates: <strong>${esc(c.dailyRate || 0)}</strong>/day · <strong>${esc(c.weeklyRate || 0)}</strong>/week · <strong>${esc(c.monthlyRate || 0)}</strong>/month</span>
      </div>` : ""}
      ${b ? `
      <div class="card-details">
        <span>Renter: <strong>${esc(b.renter) || "—"}</strong></span>
        <span>Phone: <strong>${esc(b.phone) || "—"}</strong></span>
        <span>Return: <strong>${formatDate(b.endDate)}</strong></span>
      </div>` : up ? `
      <div class="card-details">
        <span>Next booking: <strong>${formatDate(up.startDate)}</strong> (${esc(up.renter)})</span>
      </div>` : ""}
      <div class="card-actions">
        ${s === "available"
          ? `<button class="btn" data-act="rent" data-id="${c.id}">Rent out now</button>`
          : s === "service" ? ""
          : `<button class="btn" data-act="return" data-id="${c.id}">Mark as returned</button>`}
        <button class="btn" data-act="editcar" data-id="${c.id}">Edit</button>
        <button class="btn danger" data-act="remove" data-id="${c.id}">Remove</button>
      </div>
    </div>`;
  }).join("");
}

// ---------- Car add / edit ----------
function openCarModal(id) {
  editingCarId = id;
  const c = id ? state.cars.find(x => x.id === id) : null;
  el(root, "car-modal-title").textContent = c ? "Edit car" : "Add new car";
  setVal(root, "c-make", c?.make);
  setVal(root, "c-model", c?.model);
  setVal(root, "c-year", c?.year);
  setVal(root, "c-plate", c?.plate);
  setVal(root, "c-rate", c?.dailyRate);
  setVal(root, "c-rate-week", c?.weeklyRate);
  setVal(root, "c-rate-month", c?.monthlyRate);
  openModal(root, "car-modal");
}

async function saveCar() {
  const make = val(root, "c-make");
  const model = val(root, "c-model");
  if (!make || !model) { alert("Please enter at least a make and model."); return; }

  const year = val(root, "c-year");
  const plate = val(root, "c-plate");
  let dailyRate = parseFloat(val(root, "c-rate")) || 0;
  const weeklyIn = parseFloat(val(root, "c-rate-week")) || 0;
  const monthlyIn = parseFloat(val(root, "c-rate-month")) || 0;
  if (!dailyRate && weeklyIn) dailyRate = Math.round((weeklyIn / 7) * 100) / 100;
  if (!dailyRate && monthlyIn) dailyRate = Math.round((monthlyIn / 30) * 100) / 100;
  const weeklyRate = weeklyIn || Math.round(dailyRate * 7 * 100) / 100;
  const monthlyRate = monthlyIn || Math.round(dailyRate * 30 * 100) / 100;

  const btn = el(root, "save-car");
  btn.disabled = true; btn.textContent = "Saving...";
  setSync("saving");
  try {
    if (editingCarId) {
      await updateDoc(doc(db, "cars", editingCarId), { make, model, year, plate, dailyRate, weeklyRate, monthlyRate });
    } else {
      await addDoc(collection(db, "cars"), {
        companyId: state.ctx.companyId, make, model, year, plate, dailyRate, weeklyRate, monthlyRate
      });
    }
    closeModal(root, "car-modal");
    editingCarId = null;
  } catch (e) {
    alert("Couldn't save the car (" + (e.code || e.message) + "). Try again.");
    setSync("error");
  }
  btn.disabled = false; btn.textContent = "Save car";
}

async function removeCar(id) {
  const open = openBookingsForCar(id);
  if (open.length > 0) {
    alert(
      `This car has ${open.length} booking(s) that aren't finished yet.\n\n` +
      "Mark them returned (or delete them) on the Bookings view before removing the car."
    );
    return;
  }
  const past = state.bookings.filter(b => b.carId === id).length;
  const msg = past > 0
    ? `Remove this car from the fleet?\n\nIts ${past} past rental(s) stay in Billing and customer history, listed as "removed from fleet".`
    : "Remove this car from the fleet?";
  if (!confirm(msg)) return;
  setSync("saving");
  try { await deleteDoc(doc(db, "cars", id)); }
  catch (e) { alert("Couldn't remove (" + (e.code || e.message) + ")."); setSync("error"); }
}

// ---------- Walk-in rental ----------
function toggleRentNewCustomer() {
  const isNew = el(root, "r-customer").value === "__new__";
  el(root, "r-new-fields").style.display = isNew ? "block" : "none";
}

function openRentModal(carId) {
  const car = state.cars.find(x => x.id === carId);
  if (car && car.outOfService) {
    alert("This car is out of service. Put it back in service on the Maintenance view before renting it out.");
    return;
  }
  rentingCarId = carId;

  const csel = el(root, "r-customer");
  csel.innerHTML = state.customers
    .slice().sort((a, b) => a.name.localeCompare(b.name))
    .map(c => `<option value="${c.id}">${esc(c.name)}${c.phone ? " · " + esc(c.phone) : ""}</option>`)
    .join("") + `<option value="__new__">+ New customer...</option>`;
  csel.value = state.customers.length ? csel.options[0].value : "__new__";
  toggleRentNewCustomer();

  ["r-name", "r-phone", "r-email", "r-date"].forEach(n => setVal(root, n, ""));
  showError(root, "rent-error", null);
  openModal(root, "rent-modal");
}

async function confirmRent() {
  if (!rentingCarId) return;
  showError(root, "rent-error", null);

  const startDate = todayStr();
  const endDate = val(root, "r-date");
  const choice = el(root, "r-customer").value;

  let customerId, renter, phone, email;
  if (choice === "__new__") {
    renter = val(root, "r-name");
    phone = val(root, "r-phone");
    email = val(root, "r-email");
    if (!renter) { showError(root, "rent-error", "Enter the customer's name."); return; }
  } else {
    const c = state.customers.find(x => x.id === choice);
    if (!c) { showError(root, "rent-error", "Pick a customer."); return; }
    customerId = c.id; renter = c.name; phone = c.phone || "";
  }

  if (!endDate) { showError(root, "rent-error", "Choose a return date."); return; }
  if (endDate < startDate) { showError(root, "rent-error", "Return date can't be in the past."); return; }

  const clash = state.bookings.find(b =>
    b.carId === rentingCarId && b.status !== "completed" && overlaps(startDate, endDate, b.startDate, b.endDate));
  if (clash) {
    showError(root, "rent-error", `This car is booked ${formatDate(clash.startDate)} – ${formatDate(clash.endDate)} (${clash.renter}). Choose an earlier return date or another car.`);
    return;
  }

  const btn = el(root, "confirm-rent");
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
    const car = state.cars.find(x => x.id === rentingCarId);
    await addDoc(collection(db, "bookings"), {
      companyId: state.ctx.companyId, carId: rentingCarId, customerId, renter, phone,
      startDate, endDate, dailyRate: car?.dailyRate || 0, paid: false,
      carName: car ? `${car.year || ""} ${car.make} ${car.model} (${car.plate || "no plate"})`.trim() : "",
      status: "open", createdAt: new Date().toISOString()
    });
    closeModal(root, "rent-modal");
    rentingCarId = null;
  } catch (e) {
    showError(root, "rent-error", "Couldn't save the rental (" + (e.code || e.message) + ").");
    setSync("error");
  }
  btn.disabled = false; btn.textContent = "Confirm rental";
}

async function markReturned(carId) {
  const b = currentBooking(carId);
  if (!b) return;
  setSync("saving");
  try { await updateDoc(doc(db, "bookings", b.id), { status: "completed" }); }
  catch (e) { alert("Couldn't update (" + (e.code || e.message) + ")."); setSync("error"); }
}
