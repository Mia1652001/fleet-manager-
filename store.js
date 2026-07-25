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

// Label for a booking's car. Falls back to the name saved on the booking when
// the car itself has since been removed from the fleet, so history survives.
export function bookingCarLabel(b) {
  const c = state.cars.find(x => x.id === b.carId);
  if (c) return `${c.year || ""} ${c.make} ${c.model} (${c.plate || "no plate"})`.trim();
  if (b.carName) return `${b.carName} (removed from fleet)`;
  return "Car no longer in fleet";
}

// The customer record behind a booking (may be missing if deleted)
export function customerForBooking(b) {
  return state.customers.find(c => c.id === b.customerId) || null;
}

// Bookings for a car that are not finished (active or upcoming)
export function openBookingsForCar(carId) {
  return state.bookings.filter(b => b.carId === carId && b.status !== "completed");
}

// Date-only overlap, kept for anything that reasons in whole days.
export function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

// ---------- Time-aware availability ----------
// A rental occupies an interval from pick-up date+time to return date+time.
// Comparing those intervals (rather than whole days) lets a car come back in
// the morning and go out again the same afternoon, which is normal practice.
// Sortable "YYYY-MM-DDTHH:MM" strings compare correctly as plain text.
export function bookingStartAt(b) { return `${b.startDate}T${startTime(b)}`; }
export function bookingEndAt(b) { return `${b.endDate}T${endTime(b)}`; }

// Strict comparison, so one rental ending exactly when the next begins is
// allowed rather than reported as a clash.
export function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// Finds the first booking that would clash with the proposed interval.
// `ignoreId` skips the booking being edited so it never clashes with itself.
export function findClash({ carId, startAt, endAt, ignoreId = null }) {
  return state.bookings.find(b =>
    b.id !== ignoreId &&
    b.carId === carId &&
    b.status !== "completed" &&
    intervalsOverlap(startAt, endAt, bookingStartAt(b), bookingEndAt(b))
  ) || null;
}

// Human-readable interval for error messages: "25/07 14:00 – 30/07 12:00"
export function describeInterval(b) {
  return `${formatDate(b.startDate)} ${startTime(b)} – ${formatDate(b.endDate)} ${endTime(b)}`;
}

// True when another booking for the same car hands over on this date, so the
// timeline can draw the two bars as half-days instead of stacking them.
export function sharesStartHandover(b) {
  return state.bookings.some(o => o.id !== b.id && o.carId === b.carId && o.endDate === b.startDate);
}
export function sharesEndHandover(b) {
  return state.bookings.some(o => o.id !== b.id && o.carId === b.carId && o.startDate === b.endDate);
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

// A manually entered total wins over the day-rate calculation, so staff can
// agree a bespoke price (long rental, negotiated deal) without changing the
// car's published rate.
export function hasManualTotal(b) {
  return typeof b.totalPrice === "number" && b.totalPrice > 0;
}
export function rentalTotal(b) {
  if (hasManualTotal(b)) return b.totalPrice;
  return rentalDays(b) * rateFor(b);
}
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

// ---------- Times and locations ----------
// Bookings created before times existed fall back to midday, so nothing
// displays as blank or shifts a rental to midnight.
export function startTime(b) { return b.startTime || "12:00"; }
export function endTime(b) { return b.endTime || "12:00"; }

// Compact label for the left of a timeline bar: "13:00 Airport (MRU)"
export function pickupLabel(b) {
  return [startTime(b), b.pickupLocation || ""].filter(Boolean).join(" ").trim();
}
// Compact label for the right of a timeline bar: "City delivery 19:30"
export function dropoffLabel(b) {
  return [b.dropoffLocation || "", endTime(b)].filter(Boolean).join(" ").trim();
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
