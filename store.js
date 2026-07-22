// Shared state and helpers for every view.
// Data is loaded once by app.js and kept here in memory, so switching
// between views is instant — no reloading, no refetching.

export const state = {
  ctx: null,        // { user, companyId, companyName }
  cars: [],
  bookings: [],
  customers: []
};

// Views register a render function; app.js calls this whenever data changes.
const listeners = new Set();
export function onDataChange(fn) { listeners.add(fn); }
export function notifyDataChange() { listeners.forEach(fn => fn()); }

// ---------- Formatting ----------
export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function formatDate(d) {
  if (!d) return "—";
  const p = String(d).split("-");
  if (p.length < 3) return "—";
  return `${p[2].slice(0, 2)}/${p[1]}/${p[0]}`;
}

export function formatAmount(n) {
  return Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// ---------- Shared domain logic ----------
export function carLabel(carId) {
  const c = state.cars.find(x => x.id === carId);
  return c ? `${c.year || ""} ${c.make} ${c.model} (${c.plate || "no plate"})`.trim() : "Unknown car";
}

export function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

// The booking that has a car out right now (started, not yet returned)
export function currentBooking(carId) {
  const t = todayStr();
  return state.bookings
    .filter(b => b.carId === carId && b.status !== "completed" && b.startDate <= t)
    .sort((a, b) => a.endDate.localeCompare(b.endDate))[0] || null;
}

export function nextUpcoming(carId) {
  const t = todayStr();
  return state.bookings
    .filter(b => b.carId === carId && b.status !== "completed" && b.startDate > t)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))[0] || null;
}

// "service" | "overdue" | "rented" | "available"
export function carStatus(car) {
  if (car.outOfService) return "service";
  const b = currentBooking(car.id);
  if (!b) return "available";
  return b.endDate < todayStr() ? "overdue" : "rented";
}

export function serviceDueByDate(c) {
  if (!c.nextServiceDate) return false;
  const soon = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  return c.nextServiceDate <= soon;
}
export function serviceDueByMileage(c) {
  return c.serviceMileage && c.mileage && Number(c.mileage) >= Number(c.serviceMileage);
}
export function serviceDue(c) {
  return serviceDueByDate(c) || serviceDueByMileage(c);
}

// Booking state used by the Bookings view
export function bookingState(b) {
  if (b.status === "completed") return "completed";
  const t = todayStr();
  if (b.endDate < t) return "overdue";
  if (b.startDate > t) return "upcoming";
  return "active-b";
}

// ---------- Billing maths ----------
export function rentalDays(b) {
  const ms = new Date(b.endDate) - new Date(b.startDate);
  return Math.max(1, Math.round(ms / 86400000) + 1);
}

export function rateFor(b) {
  if (typeof b.dailyRate === "number" && b.dailyRate > 0) return b.dailyRate;
  const c = state.cars.find(x => x.id === b.carId);
  return c?.dailyRate || 0;
}

export function rentalTotal(b) { return rentalDays(b) * rateFor(b); }
export function advancePaid(b) { return typeof b.advancePaid === "number" ? b.advancePaid : 0; }
export function balanceFor(b) { return Math.max(0, rentalTotal(b) - advancePaid(b)); }
export function securityHeld(b) {
  return (b.securityDeposit && b.securityStatus === "held") ? b.securityDeposit : 0;
}
export function settledAmount(b) {
  if (b.paid && typeof b.paidAmount === "number") return b.paidAmount;
  return balanceFor(b);
}
export function isBillable(b) {
  return b.startDate <= todayStr() || b.status === "completed";
}

// ---------- Small DOM helpers ----------
// Each view works inside its own container and uses data-el attributes,
// so element names can repeat across views without clashing.
export function el(root, name) {
  return root.querySelector(`[data-el="${name}"]`);
}
export function val(root, name) {
  const e = el(root, name);
  return e ? e.value.trim() : "";
}
export function setVal(root, name, v) {
  const e = el(root, name);
  if (e) e.value = v ?? "";
}
export function openModal(root, name) {
  const m = el(root, name);
  if (m) m.classList.add("open");
}
export function closeModal(root, name) {
  const m = el(root, name);
  if (m) m.classList.remove("open");
}
export function showError(root, name, msg) {
  const e = el(root, name);
  if (!e) return;
  if (msg) { e.textContent = msg; e.classList.add("show"); }
  else { e.classList.remove("show"); }
}
