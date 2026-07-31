// Shared state and helpers for every view.
// Data is loaded once by app.js and kept here in memory, so switching
// between views is instant — no reloading, no refetching.

export const state = {
  ctx: null,        // { user, companyId, companyName }
  settings: {},     // the company's own settings doc — see view-settings.js
  cars: [],
  bookings: [],
  customers: [],
  tasks: []     // manually added jobs, e.g. "follow up agency"
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

// Displayed amounts carry whatever symbol the company set on the Settings page
// ("Rs" in Mauritius). Exports deliberately do not use this — a spreadsheet needs
// bare numbers it can add up, not text with a symbol in front.
export function formatAmount(n) {
  const num = Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
  const symbol = state.settings?.currency || "";
  return symbol ? `${symbol} ${num}` : num;
}

// The company's own details, with sensible fallbacks so nothing shows "undefined"
// before the Settings page has been filled in.
export function companyName() {
  return state.settings?.companyName || state.ctx?.companyName || "";
}

// ---------- Foreign-currency bookings ----------
// Some clients pay in euros or dollars, in cash. The books stay in the
// company's own currency — every total, report and export adds up the home
// figures exactly as before — and the foreign amount rides alongside for
// display: the desk records both ("€300 = Rs 15,000"), which captures the
// rate actually agreed rather than a rate looked up somewhere.
export const FX_CURRENCIES = [
  { sym: "€", label: "Euro" },
  { sym: "$", label: "US dollar" },
  { sym: "£", label: "British pound" },
  { sym: "Rs", label: "Mauritian rupee" }
];

// "€ 300 (Rs 15,000)" when a foreign amount exists, plain "Rs 15,000" otherwise.
export function fxPair(b, homeAmount, fxAmount) {
  const sym = b?.fxCurrency;
  if (sym && typeof fxAmount === "number" && fxAmount > 0) {
    const n = Number(fxAmount).toLocaleString("en-US", { maximumFractionDigits: 2 });
    return `${sym} ${n} (${formatAmount(homeAmount)})`;
  }
  return formatAmount(homeAmount);
}

// The company's own exchange rate for a currency, set on the Settings page.
// A house rate rather than a market feed: it carries the margin the company
// actually gives at the desk, works offline, and converts the same booking the
// same way every time. Null when no rate has been set.
export function fxRate(sym) {
  const r = Number(state.settings?.fxRates?.[sym]);
  return Number.isFinite(r) && r > 0 ? r : null;
}

// The warning shown before a booking is deleted — shared by every delete
// button, so none of them can quietly understate what deletion means. An
// invoice IS its booking: deleting one erases billing history, and the bare
// "Delete this booking?" taught people to clean up finished rentals by
// deleting them, silently destroying their income records as they went.
export function deleteBookingWarning(b) {
  if (!b) return "Delete this booking?";
  const lines = [
    `Delete booking ${bookingRef(b)}${b.renter ? ` for ${b.renter}` : ""}?`,
    "",
    `This erases it everywhere: its invoice (${formatAmount(invoiceTotal(b))}) leaves Billing, its jobs leave Tasks, and every total changes with it. This cannot be undone.`
  ];
  if (b.paid) {
    lines.push("",
      `This invoice is marked PAID — deleting it removes ${formatAmount(settledAmount(b))} from your received-income records.`);
  }
  lines.push("",
    `A finished rental should be marked as returned instead — that keeps its invoice.`);
  return lines.join("\n");
}

export function companyTerms() { return state.settings?.terms || ""; }


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
  // Built from local date parts rather than toISOString, which reports UTC.
  // Mauritius is four hours ahead, so between midnight and 4am the old version
  // measured the fortnight from yesterday and the warning appeared a day late.
  const d = new Date();
  d.setDate(d.getDate() + 14);
  const soon = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
  // A booking with a missing or unreadable date used to make this NaN, which
  // then spread through the total, the balance and every figure built on them —
  // and "NaN" printed on screen and into the exports.
  if (!b || !b.startDate || !b.endDate) return 1;

  // The real pick-up and return moments, not just the calendar dates: a
  // 19:00-to-19:00 rental is exactly 10×24 hours, and counting it as 11 by
  // ignoring the time and adding a flat "+1" overcharged every booking whose
  // pick-up and return times matched. Each day the car is out for any part of
  // counts as a full day — round up, never down, minimum one.
  const startMs = new Date(bookingStartAt(b)).getTime();
  const endMs = new Date(bookingEndAt(b)).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 1;

  const diff = endMs - startMs;
  return Math.max(1, Math.ceil(diff / 86400000));
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
  // Zero counts. Requiring it to be above zero meant a complimentary rental,
  // entered deliberately as 0, fell through to days × daily rate and was billed
  // in full — the opposite of what was typed. A blank field is saved as null, so
  // "nothing entered" and "entered as free" stay distinguishable.
  return typeof b.totalPrice === "number" && Number.isFinite(b.totalPrice) && b.totalPrice >= 0;
}
export function rentalTotal(b) {
  // Clamped, because a negative rate or price typed by mistake would otherwise
  // show as a negative invoice and quietly reduce the outstanding total.
  if (hasManualTotal(b)) return Math.max(0, b.totalPrice);
  return Math.max(0, rentalDays(b) * rateFor(b));
}
export function advancePaid(b) { return typeof b.advancePaid === "number" ? b.advancePaid : 0; }
// ---------- Extra charges ----------
// Delivery, insurance and anything else agreed on top of the hire itself. Kept
// apart from the rental line so an invoice can show what the car cost and what
// the extras cost, rather than one number nobody can take apart.
export function deliveryCost(b) { return Math.max(0, Number(b?.deliveryCost) || 0); }
export function insuranceCost(b) { return Math.max(0, Number(b?.insuranceCost) || 0); }
export function otherCost(b) { return Math.max(0, Number(b?.otherCost) || 0); }

export function extrasTotal(b) {
  return deliveryCost(b) + insuranceCost(b) + otherCost(b);
}

// What the customer actually owes: the hire plus the extras. Everything to do
// with money owed, booked or received works from this, while rentalTotal stays
// the hire on its own so an invoice can still show the daily-rate arithmetic.
export function invoiceTotal(b) {
  return rentalTotal(b) + extrasTotal(b);
}

export function balanceFor(b) { return Math.max(0, invoiceTotal(b) - advancePaid(b)); }
export function securityHeld(b) {
  // Anything not explicitly refunded or kept is still in hand. Requiring the
  // status to say "held" meant a deposit recorded without one was left out of
  // "Deposits held" — understating money the company is actually holding.
  const amount = Number(b.securityDeposit) || 0;
  if (amount <= 0) return 0;
  const status = b.securityStatus;
  return (status === "refunded" || status === "kept") ? 0 : amount;
}
export function settledAmount(b) {
  if (b.paid && typeof b.paidAmount === "number") return b.paidAmount;
  return balanceFor(b);
}
// ---------- Collapsible panels ----------
// Several views open with a row of summary figures that push the working part
// of the screen out of sight, especially on a phone. This wires the small
// disclosure button they share. Closed by default; each person's choice is kept
// on their own device, so one member of staff opening it does not affect anyone
// else. Returns a getter so a view can skip drawing a panel nobody is looking at.
export function initPanelToggle(root, prefKey, elName, className, label, defaultOpen = false) {
  const btn = el(root, elName);
  if (!btn) return () => true;              // view without this panel
  let open = loadPref(prefKey, defaultOpen);
  const paint = () => {
    root.classList.toggle(className, !open);
    btn.textContent = `${open ? "\u25be" : "\u25b8"} ${label}`;
  };
  btn.addEventListener("click", () => {
    open = !open;
    savePref(prefKey, open);
    paint();
    notifyDataChange();                     // redraw whatever was just opened
  });
  paint();
  return () => open;
}

// ---------- The reporting period ----------
// Calendar months do not suit this business: rentals routinely start in one
// month and end in the next, so a month boundary cuts single rentals in half
// and every figure lurches on the 1st. A rolling window ending today is steady
// and always covers the same amount of trading.
export const PERIOD_DAYS = 30;

export function periodStart() {
  const d = new Date();
  d.setDate(d.getDate() - (PERIOD_DAYS - 1));   // today counts as day 1
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// True when a date falls inside the window. Accepts a plain date or a full
// timestamp, so paidAt and startDate can both be passed straight in.
export function inPeriod(dateStr) {
  if (!dateStr) return false;
  const d = String(dateStr).slice(0, 10);
  return d >= periodStart() && d <= todayStr();
}

// The day a booking's money came in, as well as it can be known. Bookings
// ticked as paid on the booking form before the app recorded a date have no
// paidAt at all, so it is inferred — and the answer can never be in the future,
// because money marked as received has already been received.
export function settledOn(b) {
  if (b.paidAt) return String(b.paidAt).slice(0, 10);
  const t = todayStr();

  // Rental finished: settled by the time the car came back, at the latest.
  if (b.endDate && b.endDate <= t) return b.endDate;

  // Car still out: cash normally changes hands at pick-up.
  if (b.startDate && b.startDate <= t) return b.startDate;

  // Not started yet but marked paid, so it was paid in advance. The rental
  // dates are no use here — they are both in the future — so fall back to the
  // day the booking was entered, which is the earliest the money could have
  // arrived. Without that, prepayments counted as received on a future date
  // and dropped out of the period entirely.
  const created = b.createdAt ? String(b.createdAt).slice(0, 10) : "";
  if (created && created <= t) return created;
  return t;
}

// ---------- Jumping to one record ----------
// Clicking a vehicle on the planner should land on that vehicle in Fleet, not
// merely on the Fleet page. The two views do not know about each other, so the
// request is left here and the receiving view picks it up on its next draw and
// clears it.
let pendingFocus = null;

export function requestFocus(view, id) {
  if (view && id) pendingFocus = { view, id };
}

export function takeFocus(view) {
  if (!pendingFocus || pendingFocus.view !== view) return null;
  const { id } = pendingFocus;
  pendingFocus = null;           // one jump per request, never repeated on a redraw
  return id;
}

// ---------- Brief confirmations ----------
// A save that closes a dialog and leaves no trace gives no assurance it worked,
// and there is nowhere to put a booking reference at that moment. This is a short
// notice that appears, then goes. Deliberately not a dialog: nothing here needs
// dismissing, and an extra click on every save would wear thin quickly.
export function showToast(message, tone = "ok") {
  if (!message) return;
  let host = document.getElementById("toast-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "toast-host";
    document.body.appendChild(host);
  }
  const note = document.createElement("div");
  note.className = `toast ${tone}`;
  note.textContent = message;
  host.appendChild(note);

  // Long enough to read and write down a reference, short enough not to linger.
  setTimeout(() => { note.classList.add("leaving"); }, 4200);
  setTimeout(() => { note.remove(); }, 4700);
}

// ---------- Booking reference ----------
// A short code staff can read out over the phone and quote on a confirmation.
// The alphabet deliberately leaves out 0, O, 1, I and L, because those are the
// characters people mishear and mistype; what is left is unambiguous spoken
// aloud. The YYMM prefix means a reference also tells you roughly when it was
// taken, and keeps codes from the same month grouped together.
const REF_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const REF_BODY_LEN = 4;

function refBody(fromRandom) {
  let out = "";
  for (let i = 0; i < REF_BODY_LEN; i++) {
    out += REF_ALPHABET[Math.floor(fromRandom() * REF_ALPHABET.length)];
  }
  return out;
}

function refPrefix(dateish) {
  const d = dateish ? new Date(dateish) : new Date();
  const use = isNaN(d) ? new Date() : d;
  return `${String(use.getFullYear()).slice(2)}${String(use.getMonth() + 1).padStart(2, "0")}`;
}

// Called once when a booking is created, so the reference is stored and never
// changes afterwards even if the dates or the car do. Checks what is already
// loaded and tries again on the small chance of a repeat.
export function makeBookingRef() {
  const prefix = refPrefix(null);
  for (let attempt = 0; attempt < 12; attempt++) {
    const candidate = `${prefix}-${refBody(Math.random)}`;
    if (!state.bookings.some(b => b.ref === candidate)) return candidate;
  }
  // Twelve collisions in a row is implausible; fall back to something certainly
  // unique rather than risk handing out a duplicate.
  return `${prefix}-${Date.now().toString(36).slice(-4).toUpperCase()}`;
}

// Bookings taken before references existed have no stored ref, so one is derived
// from the document id. It is stable, unique and in the same shape, which means
// every booking can show a reference without having to rewrite old records.
export function bookingRef(b) {
  if (!b) return "";
  if (b.ref) return b.ref;
  const id = b.id || "";
  if (!id) return "";
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  let body = "";
  for (let i = 0; i < REF_BODY_LEN; i++) {
    body += REF_ALPHABET[h % REF_ALPHABET.length];
    h = Math.floor(h / REF_ALPHABET.length) + 7;
  }
  return `${refPrefix(b.createdAt || b.startDate)}-${body}`;
}

// Has the rental actually begun? Only started rentals count towards money owed.
export function hasStarted(b) {
  return b.startDate <= todayStr() || b.status === "completed";
}

// Every booking has an invoice; future ones are simply marked as not started.
// (They used to be hidden completely, which made bookings look missing.)
export function isBillable(b) {
  return true;
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

// ---------- Delivery / recovery schedule ----------
// Every booking implies two jobs: hand the car over, and get it back. Those
// are generated from the booking itself rather than stored separately, so the
// schedule can never drift out of step with the bookings.
//
// A recovery being done is the same fact as the booking being finished, so the
// two are deliberately one flag (booking.status === "completed"). Hand-overs
// get their own `pickupDone` marker, which is purely operational.

export function deliveryDone(b) { return b.pickupDone === true; }
export function recoveryDone(b) { return b.status === "completed"; }

function bookingJobs(b) {
  const carText = bookingCarLabel(b);
  // A job normally sits on the booking's own date, but the desk can move the
  // job alone — drop the car at the airport two days before the rental starts —
  // without touching the booking or its price. That override lives in
  // deliveryDate / recoveryDate and is cleared whenever the booking's own
  // dates are edited, so the job follows the booking again.
  const outDate = b.deliveryDate || b.startDate;
  const inDate = b.recoveryDate || b.endDate;
  return [
    {
      id: `${b.id}:out`,
      kind: "delivery",
      bookingId: b.id,
      date: outDate,
      dateMoved: outDate !== b.startDate,
      time: startTime(b),
      car: carText,
      location: b.pickupLocation || "",
      customer: b.renter || "",
      staff: b.deliveredBy || b.managedBy || "",
      managedBy: b.managedBy || "",
      deliveredBy: b.deliveredBy || "",
      recoveredBy: b.recoveredBy || "",
      notes: b.notes || "",
      done: deliveryDone(b)
    },
    {
      id: `${b.id}:in`,
      kind: "recovery",
      bookingId: b.id,
      date: inDate,
      dateMoved: inDate !== b.endDate,
      time: endTime(b),
      car: carText,
      location: b.dropoffLocation || "",
      customer: b.renter || "",
      // Bringing a car back is often a different person's job from taking it
      // out, so this follows recoveredBy. It used to credit the recovery to
      // whoever delivered, which put the job on the wrong person's list.
      staff: b.recoveredBy || b.managedBy || "",
      managedBy: b.managedBy || "",
      deliveredBy: b.deliveredBy || "",
      recoveredBy: b.recoveredBy || "",
      notes: b.notes || "",
      done: recoveryDone(b)
    }
  ];
}

// A car with a service date due produces its own job, so servicing shows up
// in the same list as deliveries rather than only on the Maintenance screen.
function serviceJobs() {
  return state.cars
    .filter(c => c.nextServiceDate)
    .map(c => ({
      id: `service:${c.id}`,
      kind: "service",
      carId: c.id,
      date: c.nextServiceDate,
      time: "",
      car: `${c.year || ""} ${c.make} ${c.model} (${c.plate || "no plate"})`.trim(),
      location: "",
      customer: c.notes_maint || "Service due",
      staff: "",
      managedBy: "",
      deliveredBy: "",
      notes: c.notes_maint || "",
      done: false
    }));
}

function manualJob(t) {
  return {
    id: `task:${t.id}`,
    kind: "task",
    taskId: t.id,
    date: t.date,
    time: t.time || "",
    car: "",
    location: "",
    customer: t.text || "",
    staff: t.staff || "",
    managedBy: "",
    deliveredBy: "",
    notes: "",
    done: t.done === true
  };
}

// Every staff name that appears anywhere, so a filter can be built from the
// data rather than needing a separate list of employees to maintain.
// ---------- Suggestion lists ----------
// Two sources, deliberately. The list kept on the Settings page is the company's
// own — the people and places it actually uses. Everything already typed into a
// booking is added to it, so the suggestions are useful from the first day
// without anyone having to fill Settings in first, and a one-off destination
// typed for a single customer is never lost.

function settingsList(key) {
  const raw = state.settings?.[key];
  if (!Array.isArray(raw)) return [];
  return raw.map(x => String(x).trim()).filter(Boolean);
}

function mergeNames(...groups) {
  // Case-insensitive de-duplication, keeping the first spelling seen. Settings
  // is passed first, so the company's own spelling wins over whatever variants
  // have been typed into bookings over the months.
  const seen = new Map();
  groups.flat().forEach(v => {
    const name = String(v || "").trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (!seen.has(key)) seen.set(key, name);
  });
  return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
}

// Once a list has been set up on the Settings page it is the only source. These
// used to also gather every value ever typed into a booking, which kept old
// placeholders and one-off spellings — "Popo", "staff", "BB" — in the suggestion
// lists for good, with no way to be rid of them short of editing old records.
//
// Before the list is filled in there is nothing to offer, so it still falls back
// to what the data contains. That keeps the app useful from the first day, and
// means filling in Settings tidies the lists rather than being a precondition.
// Same case-insensitive de-duplication as mergeNames, but keeping the order
// the names were written in — used where the Settings order is the point.
function dedupeKeepOrder(list) {
  const seen = new Map();
  list.forEach(v => {
    const name = String(v || "").trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (!seen.has(key)) seen.set(key, name);
  });
  return Array.from(seen.values());
}

export function staffNames() {
  // Settings order preserved, so the staff filter, the suggestion lists and
  // the board columns all present people in the same order the company wrote.
  const own = settingsList("staff");
  if (own.length) return dedupeKeepOrder(own);
  return mergeNames(
    state.bookings.flatMap(b => [b.deliveredBy, b.managedBy, b.recoveredBy]),
    (state.tasks || []).map(t => t.staff)
  );
}

export function locationNames() {
  const own = settingsList("locations");
  if (own.length) return mergeNames(own);
  return mergeNames(state.bookings.flatMap(b => [b.pickupLocation, b.dropoffLocation]));
}

export function brokerNames() {
  const own = settingsList("brokers");
  if (own.length) return mergeNames(own);
  return mergeNames(state.bookings.map(b => b.broker));
}

// Returns jobs within [from, to], plus anything overdue and still not done —
// an unfinished job from last week must not quietly disappear.
export function buildSchedule({ from, to, includeDone }) {
  const t = todayStr();
  let jobs = [];
  state.bookings.forEach(b => { jobs = jobs.concat(bookingJobs(b)); });
  // Guarded like the other collections: this runs on a timer from the dashboard,
  // and a list that has not arrived yet would otherwise stop the whole schedule.
  (state.tasks || []).forEach(x => { jobs.push(manualJob(x)); });
  jobs = jobs.concat(serviceJobs());

  jobs = jobs.filter(j => {
    if (!j.date) return false;
    const inRange = (!from || j.date >= from) && (!to || j.date <= to);
    const lateAndOpen = j.date < t && !j.done;
    if (!includeDone && j.done) return false;
    return inRange || lateAndOpen;
  });

  jobs.forEach(j => { j.overdue = j.date < t && !j.done; });

  jobs.sort((a, b) =>
    a.date.localeCompare(b.date) || (a.time || "99").localeCompare(b.time || "99"));
  return jobs;
}

// ---------- 24-hour time selects ----------
// Native <input type="time"> renders in whatever format the operating system
// prefers, which on many machines is 12-hour AM/PM. That makes it impossible
// to type 14:00, and clashes with the 24-hour times shown everywhere else in
// the app. Explicit dropdowns remove the ambiguity entirely.

const MINUTE_STEP = 5;

export function fillTimeOptions(root, name) {
  const h = el(root, `${name}-h`), m = el(root, `${name}-m`);
  if (!h || !m) return;
  if (h.options.length === 0) {
    let out = "";
    for (let i = 0; i < 24; i++) {
      const v = String(i).padStart(2, "0");
      out += `<option value="${v}">${v}</option>`;
    }
    h.innerHTML = out;
  }
  if (m.options.length === 0) {
    let out = "";
    for (let i = 0; i < 60; i += MINUTE_STEP) {
      const v = String(i).padStart(2, "0");
      out += `<option value="${v}">${v}</option>`;
    }
    m.innerHTML = out;
  }
}

export function getTime(root, name) {
  const h = el(root, `${name}-h`), m = el(root, `${name}-m`);
  if (!h || !m) return "";
  return `${h.value}:${m.value}`;
}

export function setTime(root, name, value) {
  const h = el(root, `${name}-h`), m = el(root, `${name}-m`);
  if (!h || !m) return;
  const [hh, mm] = String(value || "12:00").split(":");
  h.value = String(Number(hh) || 0).padStart(2, "0");
  const mv = String(Number(mm) || 0).padStart(2, "0");
  // An older booking may hold a minute that is not on the step (e.g. 09:07).
  // Add it rather than snapping, so re-saving never quietly changes the time.
  if (!Array.from(m.options).some(o => o.value === mv)) {
    m.insertAdjacentHTML("beforeend", `<option value="${mv}">${mv}</option>`);
  }
  m.value = mv;
}

// Runs a callback when either half of a time pair changes
export function onTimeChange(root, name, fn) {
  const h = el(root, `${name}-h`), m = el(root, `${name}-m`);
  if (h) h.addEventListener("change", fn);
  if (m) m.addEventListener("change", fn);
}

// ---------- Device preferences ----------
// Interface choices (zoom level, panels hidden) belong to the device, not the
// company, so they live in the browser rather than the database. Wrapped in
// try/catch because private browsing can block storage entirely.
export function loadPref(key, fallback) {
  try {
    const v = localStorage.getItem("fleet:" + key);
    return v === null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
export function savePref(key, value) {
  try { localStorage.setItem("fleet:" + key, JSON.stringify(value)); } catch {}
}

// ---------- Car ordering ----------
// Cars carry an explicit sortOrder so the planner can be arranged to match how
// a company thinks about its fleet. Anything without one falls in after the
// ordered cars, alphabetically, so existing fleets look unchanged until moved.
export function orderedCars() {
  return state.cars.slice().sort((a, b) => {
    const ao = typeof a.sortOrder === "number" ? a.sortOrder : Number.MAX_SAFE_INTEGER;
    const bo = typeof b.sortOrder === "number" ? b.sortOrder : Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return `${a.make} ${a.model}`.localeCompare(`${b.make} ${b.model}`);
  });
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

export function getSwatch(root, name) {
  const group = el(root, name);
  if (!group) return "";
  const sel = group.querySelector(".swatch.selected");
  return sel ? sel.dataset.colour : "";
}

export function setSwatch(root, name, value) {
  const group = el(root, name);
  if (!group) return;
  group.querySelectorAll(".swatch").forEach(b =>
    b.classList.toggle("selected", b.dataset.colour === (value || "")));
}

export function checked(root, name) {
  const e = el(root, name);
  return e ? e.checked === true : false;
}
export function setChecked(root, name, v) {
  const e = el(root, name);
  if (e) e.checked = v === true;
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
  if (!msg) { e.classList.remove("show"); return; }

  e.textContent = msg;
  e.classList.add("show");

  // Modals are long enough to scroll, so a message at the top can sit out of
  // sight while the user is looking at a field further down — which reads as
  // "nothing happened". Bring it into view and flash it.
  const modal = e.closest(".modal");
  if (modal && modal.scrollTop > 0) {
    modal.scrollTo({ top: 0, behavior: "smooth" });
  }
  e.classList.remove("flash");
  void e.offsetWidth;          // restart the animation
  e.classList.add("flash");
}
