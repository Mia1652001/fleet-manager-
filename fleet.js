// Fleet page — car inventory whose status is derived from bookings.
// A car is "rented" when a booking covers today; walk-in rentals create bookings.
import { db, auth, signInWithEmailAndPassword, requireAuth, setCompanyLabel, setSync, wireLogout } from "./firebase-init.js";
import { collection, query, where, onSnapshot, addDoc, updateDoc, deleteDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let cars = [];
let bookings = [];
let customers = [];
let filter = "all";
let rentingCarId = null;
let editingCarId = null; // null = adding
let ctx = null;

// ---------- Login handling ----------
async function doLogin() {
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const errEl = document.getElementById("login-error");
  const btn = document.getElementById("login-btn");
  errEl.classList.remove("show");
  if (!email || !password) { errEl.textContent = "Enter your email and password."; errEl.classList.add("show"); return; }
  btn.disabled = true; btn.textContent = "Signing in...";
  try {
    await signInWithEmailAndPassword(auth, email, password);
    window.location.reload();
  } catch (e) {
    errEl.textContent = "Incorrect email or password.";
    errEl.classList.add("show");
    btn.disabled = false; btn.textContent = "Sign in";
  }
}

// ---------- Boot ----------
(async function init() {
  ctx = await requireAuth({ isLoginPage: true });
  document.getElementById("boot").style.display = "none";

  if (!ctx) {
    document.getElementById("login").style.display = "flex";
    document.getElementById("login-btn").addEventListener("click", doLogin);
    document.getElementById("login-password").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
    return;
  }

  document.getElementById("app").style.display = "block";
  setCompanyLabel(ctx.companyName);
  wireLogout();
  wireUi();

  onSnapshot(query(collection(db, "cars"), where("companyId", "==", ctx.companyId)), (snap) => {
    cars = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    setSync("live");
    render();
  }, () => setSync("error"));

  onSnapshot(query(collection(db, "bookings"), where("companyId", "==", ctx.companyId)), (snap) => {
    bookings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
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

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

// The booking that has this car out right now: started on/before today
// and not yet marked returned (includes overdue ones past their end date).
function currentBooking(carId) {
  const t = todayStr();
  const open = bookings
    .filter(b => b.carId === carId && b.status !== "completed" && b.startDate <= t)
    .sort((a, b) => a.endDate.localeCompare(b.endDate));
  return open[0] || null;
}

// Earliest future reservation for this car
function nextUpcoming(carId) {
  const t = todayStr();
  return bookings
    .filter(b => b.carId === carId && b.status !== "completed" && b.startDate > t)
    .sort((a,b) => a.startDate.localeCompare(b.startDate))[0] || null;
}

// Derived status: "service" (out of service) | "rented" | "overdue" | "available"
function carStatus(car) {
  if (car.outOfService) return "service";
  const b = currentBooking(car.id);
  if (!b) return "available";
  return b.endDate < todayStr() ? "overdue" : "rented";
}

// Is a car's next service due within 14 days (or overdue)?
function serviceDueSoon(car) {
  if (!car.nextServiceDate) return false;
  const t = todayStr();
  const soon = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  return car.nextServiceDate <= soon; // due within 2 weeks or already past
}

// ---------- UI wiring ----------
function wireUi() {
  document.getElementById("search").addEventListener("input", render);
  document.getElementById("sortBy").addEventListener("change", render);
  document.getElementById("add-car-btn").addEventListener("click", () => openCarModal(null));
  document.getElementById("save-car-btn").addEventListener("click", saveCar);
  document.getElementById("confirm-rent-btn").addEventListener("click", confirmRent);
  document.getElementById("r-customer").addEventListener("change", toggleRentNewCustomer);

  // Rate auto-calculation: type one, the other two follow (week = 7 days, month = 30 days)
  const rd = document.getElementById("a-rate");
  const rw = document.getElementById("a-rate-week");
  const rm = document.getElementById("a-rate-month");
  const r2 = x => Math.round(x * 100) / 100;
  rd.addEventListener("input", () => { const v = parseFloat(rd.value); if (!isNaN(v)) { rw.value = r2(v * 7); rm.value = r2(v * 30); } });
  rw.addEventListener("input", () => { const v = parseFloat(rw.value); if (!isNaN(v)) { rd.value = r2(v / 7); rm.value = r2((v / 7) * 30); } });
  rm.addEventListener("input", () => { const v = parseFloat(rm.value); if (!isNaN(v)) { rd.value = r2(v / 30); rw.value = r2((v / 30) * 7); } });

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

  document.getElementById("car-list").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.act === "rent") openRentModal(id);
    else if (btn.dataset.act === "return") markReturned(id);
    else if (btn.dataset.act === "editcar") openCarModal(id);
    else if (btn.dataset.act === "remove") removeCar(id);
  });
}

// ---------- Render ----------
function render() {
  const search = document.getElementById("search").value.toLowerCase();
  const sort = document.getElementById("sortBy").value;

  const withStatus = cars.map(c => ({ ...c, _status: carStatus(c), _booking: currentBooking(c.id) }));
  const available = withStatus.filter(c => c._status === "available").length;
  const service = withStatus.filter(c => c._status === "service").length;
  const rented = withStatus.filter(c => c._status === "rented" || c._status === "overdue").length;

  document.getElementById("stats").innerHTML = `
    <div class="stat"><div class="stat-label">Total cars</div><div class="stat-val">${cars.length}</div></div>
    <div class="stat"><div class="stat-label">Available</div><div class="stat-val green">${available}</div></div>
    <div class="stat"><div class="stat-label">Rented out</div><div class="stat-val amber">${rented}</div></div>
    <div class="stat"><div class="stat-label">In service</div><div class="stat-val red">${service}</div></div>
  `;

  let list = withStatus.filter(c => {
    const status = c._status === "overdue" ? "rented" : c._status; // overdue counts as rented for filtering
    const mf = filter === "all" || status === filter;
    void status;
    const renterName = c._booking ? c._booking.renter : "";
    const ms = `${c.make} ${c.model} ${c.plate} ${renterName}`.toLowerCase().includes(search);
    return mf && ms;
  });

  if (sort === "name") list.sort((a,b) => (a.make+a.model).localeCompare(b.make+b.model));
  else list.sort((a,b) => a._status.localeCompare(b._status));

  const el = document.getElementById("car-list");
  if (list.length === 0) { el.innerHTML = '<div class="empty">No cars found. Add your first car with the button above.</div>'; return; }

  el.innerHTML = list.map(c => {
    const s = c._status;
    const b = c._booking;
    const up = s === "available" ? nextUpcoming(c.id) : null;
    return `
    <div class="item-card ${s === "overdue" ? "overdue" : s === "service" ? "overdue" : s}">
      <div class="card-top">
        <div>
          <div class="card-title">${esc(c.year)} ${esc(c.make)} ${esc(c.model)}</div>
          <div class="card-sub">${esc(c.plate)}${c.dailyRate ? " · " + esc(c.dailyRate) + "/day" : ""}</div>
        </div>
        <span class="badge ${s === "overdue" ? "overdue" : s === "service" ? "overdue" : s}">${s === "available" ? "Available" : s === "overdue" ? "Overdue" : s === "service" ? "In service" : "Rented"}</span>
      </div>
      ${serviceDueSoon(c) && s !== "service" ? `<div class="card-details" style="border-top:none;padding-top:0;margin-top:6px;"><span style="color:var(--amber-text);">⚠ Service due ${formatDate(c.nextServiceDate)}</span></div>` : ""}
      ${c.weeklyRate || c.monthlyRate ? `
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
          : s === "service"
          ? ""
          : `<button class="btn" data-act="return" data-id="${c.id}">Mark as returned</button>`}
        <button class="btn" data-act="editcar" data-id="${c.id}">Edit</button>
        <button class="btn danger" data-act="remove" data-id="${c.id}">Remove</button>
      </div>
    </div>`;
  }).join("");
}

// ---------- Actions ----------
function openCarModal(id) {
  editingCarId = id;
  const c = id ? cars.find(x => x.id === id) : null;
  document.getElementById("car-modal-title").textContent = c ? "Edit car" : "Add new car";
  document.getElementById("a-make").value = c?.make || "";
  document.getElementById("a-model").value = c?.model || "";
  document.getElementById("a-year").value = c?.year || "";
  document.getElementById("a-plate").value = c?.plate || "";
  document.getElementById("a-rate").value = c?.dailyRate ?? "";
  document.getElementById("a-rate-week").value = c?.weeklyRate ?? "";
  document.getElementById("a-rate-month").value = c?.monthlyRate ?? "";
  document.getElementById("add-modal").classList.add("open");
}

async function saveCar() {
  const make = document.getElementById("a-make").value.trim();
  const model = document.getElementById("a-model").value.trim();
  const year = document.getElementById("a-year").value.trim();
  const plate = document.getElementById("a-plate").value.trim();
  let dailyRate = parseFloat(document.getElementById("a-rate").value) || 0;
  const weeklyIn = parseFloat(document.getElementById("a-rate-week").value) || 0;
  const monthlyIn = parseFloat(document.getElementById("a-rate-month").value) || 0;
  if (!dailyRate && weeklyIn) dailyRate = Math.round((weeklyIn / 7) * 100) / 100;
  if (!dailyRate && monthlyIn) dailyRate = Math.round((monthlyIn / 30) * 100) / 100;
  const weeklyRate = weeklyIn || Math.round(dailyRate * 7 * 100) / 100;
  const monthlyRate = monthlyIn || Math.round(dailyRate * 30 * 100) / 100;
  if (!make || !model) { alert("Please enter at least a make and model."); return; }
  const btn = document.getElementById("save-car-btn");
  btn.disabled = true; btn.textContent = "Saving...";
  setSync("saving");
  try {
    if (editingCarId) {
      await updateDoc(doc(db, "cars", editingCarId), { make, model, year, plate, dailyRate, weeklyRate, monthlyRate });
    } else {
      await addDoc(collection(db, "cars"), { companyId: ctx.companyId, make, model, year, plate, dailyRate, weeklyRate, monthlyRate });
    }
    document.getElementById("add-modal").classList.remove("open");
    editingCarId = null;
  } catch (e) {
    alert("Couldn't save the car (" + (e.code || e.message) + "). Try again.");
    setSync("error");
  }
  btn.disabled = false; btn.textContent = "Save car";
}

function toggleRentNewCustomer() {
  const isNew = document.getElementById("r-customer").value === "__new__";
  document.getElementById("rent-new-customer-fields").style.display = isNew ? "block" : "none";
}

function openRentModal(carId) {
  const car = cars.find(x => x.id === carId);
  if (car && car.outOfService) { alert("This car is out of service. Put it back in service (Maintenance page) before renting."); return; }
  rentingCarId = carId;

  const csel = document.getElementById("r-customer");
  csel.innerHTML = customers
    .slice()
    .sort((a,b) => a.name.localeCompare(b.name))
    .map(c => `<option value="${c.id}">${esc(c.name)}${c.phone ? " · " + esc(c.phone) : ""}</option>`)
    .join("") + `<option value="__new__">+ New customer...</option>`;
  csel.value = customers.length ? csel.options[0].value : "__new__";
  toggleRentNewCustomer();

  ["r-name","r-phone","r-email","r-date"].forEach(i => document.getElementById(i).value = "");
  document.getElementById("rent-error").classList.remove("show");
  document.getElementById("rent-modal").classList.add("open");
}

async function confirmRent() {
  if (!rentingCarId) return;
  const errEl = document.getElementById("rent-error");
  errEl.classList.remove("show");

  const startDate = todayStr();
  const endDate = document.getElementById("r-date").value;
  const customerChoice = document.getElementById("r-customer").value;

  let customerId, renter, phone, email;
  if (customerChoice === "__new__") {
    renter = document.getElementById("r-name").value.trim();
    phone = document.getElementById("r-phone").value.trim();
    email = document.getElementById("r-email").value.trim();
    if (!renter) { errEl.textContent = "Enter the customer's name."; errEl.classList.add("show"); return; }
  } else {
    const c = customers.find(x => x.id === customerChoice);
    if (!c) { errEl.textContent = "Pick a customer."; errEl.classList.add("show"); return; }
    customerId = c.id; renter = c.name; phone = c.phone || "";
  }

  if (!endDate) { errEl.textContent = "Choose a return date."; errEl.classList.add("show"); return; }
  if (endDate < startDate) { errEl.textContent = "Return date can't be in the past."; errEl.classList.add("show"); return; }

  // Conflict check against existing reservations for this car
  const clash = bookings.find(b =>
    b.carId === rentingCarId && b.status !== "completed" && overlaps(startDate, endDate, b.startDate, b.endDate)
  );
  if (clash) {
    errEl.textContent = `This car is booked ${formatDate(clash.startDate)} – ${formatDate(clash.endDate)} (${clash.renter}). Choose an earlier return date or another car.`;
    errEl.classList.add("show");
    return;
  }

  const btn = document.getElementById("confirm-rent-btn");
  btn.disabled = true; btn.textContent = "Saving...";
  setSync("saving");

  try {
    if (!customerId) {
      const ref = await addDoc(collection(db, "customers"), {
        companyId: ctx.companyId, name: renter, phone, email: email || "", license: "", notes: "",
        createdAt: new Date().toISOString()
      });
      customerId = ref.id;
    }

    const rentedCar = cars.find(x => x.id === rentingCarId);
    await addDoc(collection(db, "bookings"), {
      companyId: ctx.companyId, carId: rentingCarId, customerId, renter, phone, startDate, endDate,
      dailyRate: rentedCar?.dailyRate || 0, paid: false,
      status: "open", createdAt: new Date().toISOString()
    });

    document.getElementById("rent-modal").classList.remove("open");
    rentingCarId = null;
  } catch (e) {
    errEl.textContent = "Couldn't save the rental (" + (e.code || e.message || "unknown error") + "). Check your connection and try again.";
    errEl.classList.add("show");
    setSync("error");
  }
  btn.disabled = false; btn.textContent = "Confirm rental";
}

async function markReturned(carId) {
  const b = currentBooking(carId);
  if (!b) return;
  setSync("saving");
  await updateDoc(doc(db, "bookings", b.id), { status: "completed" });
}

async function removeCar(id) {
  if (!confirm("Remove this car from the fleet?")) return;
  setSync("saving");
  await deleteDoc(doc(db, "cars", id));
}
