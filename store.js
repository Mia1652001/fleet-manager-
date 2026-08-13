// Shared state and helpers for every view.
// Data is loaded once by app.js and kept here in memory, so switching
// between views is instant — no reloading, no refetching.

export const state = {
  ctx: null,        // { user, companyId, companyName }
  settings: {},     // the company's own settings doc — see view-settings.js
  cars: [],
  bookings: [],
  customers: [],
  tasks: [],    // manually added jobs, e.g. "follow up agency"
  expenses: []  // staff spends: car washes, repairs, fuel — see view-expenses.js
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

// ---------- Car documents ----------
// The five dated documents every Mauritian operator tracks on paper: each is
// optional, and each warns ahead of its expiry. The registration date is a
// fact about the car, not an expiry — stored and shown, never warned about.
export const CAR_DOC_FIELDS = [
  { key: "licenceExpiry", label: "Licence" },
  { key: "roadTaxExpiry", label: "Road tax" },
  { key: "insuranceExpiry", label: "Insurance" },
  { key: "fitnessExpiry", label: "Fitness" },
  { key: "leaseExpiry", label: "Lease" }
];

// The car's documents that are expired or expiring within the horizon —
// 30 days by default, because renewals in Mauritius need queueing time, not
// same-day heroics. Returns [{ key, label, date, expired }], soonest first.
export function carDocsDue(c, withinDays = 30) {
  const t = todayStr();
  const h = new Date(t + "T12:00");
  h.setDate(h.getDate() + withinDays);
  const horizon = `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, "0")}-${String(h.getDate()).padStart(2, "0")}`;
  const out = [];
  CAR_DOC_FIELDS.forEach(f => {
    const d = c?.[f.key];
    if (!d) return;
    if (d < t) out.push({ ...f, date: d, expired: true });
    else if (d <= horizon) out.push({ ...f, date: d, expired: false });
  });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// The company's plan limit on cars, set only from the Firebase console (the
// security rules forbid any client changing it). Null means unlimited — which
// is what every company is until a plan says otherwise, so free pilots need
// nothing set at all.
export function carLimit() {
  const n = Number(state.settings?.carLimit);
  return Number.isFinite(n) && n > 0 ? n : null;
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

// ---------- Bank charge on card payments ----------
// A client paying by credit card carries the processor's fee rather than the
// company absorbing it: a percentage of everything charged, added on top.
// Rs 3,500 of rental and extras at 3% is Rs 3,605 due.
//
// It is deliberately NOT part of invoiceTotal. The company collects this money
// and hands it straight to the bank, so it is not rental income — folding it in
// would inflate Booked and every monthly figure built on it. invoiceTotal stays
// what the rental is worth; amountDue is what the customer hands over.
//
// The rate is snapshotted on the booking, exactly as the daily rate is.
// Changing the company default later must never rewrite what was agreed on a
// booking already signed.
export function bankChargePct(b) {
  if (!b?.cardPayment) return 0;
  const p = Number(b.bankChargePct);
  return Number.isFinite(p) && p > 0 ? p : 0;
}

export function bankCharge(b) {
  const pct = bankChargePct(b);
  if (!pct) return 0;
  // Rounded to the cent: 3.5% of an odd total is otherwise a figure no invoice
  // can print and no till can take.
  return Math.round(invoiceTotal(b) * pct) / 100;
}

// What the customer actually pays. Everything owed, settled or outstanding
// works from this; invoiceTotal remains the rental's own worth.
export function amountDue(b) { return invoiceTotal(b) + bankCharge(b); }

// The company's standard rate, set once on the Settings page and copied onto a
// booking when the card box is ticked.
export function defaultBankChargePct() {
  const p = Number(state.settings?.bankChargePct);
  return Number.isFinite(p) && p > 0 ? p : 0;
}

export function balanceFor(b) { return Math.max(0, amountDue(b) - advancePaid(b)); }
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
// The money figures used to run on a rolling 30-day window ending today. It
// was steady, but it answered a question no accountant asks: "Received (30
// days)" gave a number nobody could tie to a month, could not be compared with
// last month, and could not be seen for a month still to come. Money is now
// reported by calendar month. The rolling window survives below for the
// customer count, which is a trend rather than a figure anyone books.
export const MONTH_NAMES = ["January","February","March","April","May","June",
                            "July","August","September","October","November","December"];

// A month is a plain "YYYY-MM" string, so it sorts and compares as text.
export function monthOf(dateStr) { return String(dateStr || "").slice(0, 7); }
export function thisMonth() { return todayStr().slice(0, 7); }

export function shiftMonth(key, delta) {
  const y = Number(key.slice(0, 4)), m = Number(key.slice(5, 7));
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function monthLabel(key) {
  const m = Number(key.slice(5, 7));
  return `${MONTH_NAMES[m - 1] || "?"} ${key.slice(0, 4)}`;
}

// The money figures for one reporting period, in one place, so the Dashboard
// card and the Billing summary can never drift apart. `inScope(dateStr)` says
// whether a date belongs to the period being shown — one calendar month on the
// Dashboard, whatever the dropdowns say on Billing.
//
// Note which date each figure is filed under. Outstanding, Booked and Deposits
// go by the day the rental starts, which is how the desk files an invoice
// ("the August invoices" are the rentals that began in August). Received goes
// by the day the money actually arrived, which is not the same day at all: an
// advance taken in August on a September rental was received in August. That
// distinction is the whole point of reporting by month.
// The day an advance arrived. Recorded explicitly from now on
// (advanceRecordedAt, stamped by the Deposits dialog); for the advances taken
// before that field existed, inferred the way settledOn infers — the booking's
// creation day, since a deposit is normally taken when the booking is made —
// and never a future date.
export function advanceReceivedOn(b) {
  const explicit = String(b.advanceRecordedAt || "").slice(0, 10);
  if (explicit) return explicit;
  const created = String(b.createdAt || "").slice(0, 10);
  const t = todayStr();
  const guess = created || String(b.startDate || "").slice(0, 10) || t;
  return guess > t ? t : guess;
}

export function moneySummary(bookings, inScope) {
  const ofPeriod = bookings.filter(b => inScope(b.startDate));
  // Owed means owed now. A rental that has not started yet owes nothing, and
  // sits under Booked instead — the same rule the Billing tabs use, so the
  // headline figure and the Unpaid tab always tell the same story.
  const owed = ofPeriod.filter(b => !b.paid && hasStarted(b));
  return {
    outstanding: owed.reduce((s, b) => s + balanceFor(b), 0),
    unpaidCount: owed.length,
    booked: ofPeriod.reduce((s, b) => s + invoiceTotal(b), 0),
    deposits: ofPeriod.reduce((s, b) => s + securityHeld(b), 0),
    // Received is cash that actually arrived in the period: every advance by
    // the day it was taken, plus every settled balance by the day it settled.
    // The two cannot double-count — settledAmount is the balance only, the
    // advance having been subtracted when the balance was struck. Before
    // Aug 2026 advances were counted nowhere, which is why Booked, Received
    // and Outstanding refused to reconcile: the gap was every deposit ever
    // taken, plus rentals not yet started.
    received:
      bookings
        .filter(b => Number(b.advancePaid) > 0 && inScope(advanceReceivedOn(b)))
        .reduce((s, b) => s + Number(b.advancePaid), 0)
      + bookings
        .filter(b => b.paid && inScope(settledOn(b)))
        .reduce((s, b) => s + settledAmount(b), 0)
  };
}

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

// ---------- Receipt numbers ----------
// The Mauritius Revenue Authority wants a serial number on a receipt, and a
// serial number means consecutive. The booking reference cannot serve: it is
// deliberately scrambled from the record id so it is unique and hard to
// mistype, which is the opposite of what a serial number is for. So a receipt
// carries its own number, allocated the first time one is issued and then
// fixed on the booking for good — reprint a receipt years later and it shows
// the number the customer was given.
//
// Numbering restarts each year, which is ordinary practice and puts the year on
// the face of the document.

// The company's own prefix, e.g. "OCR". Letters, digits and dashes only, so a
// stray space or slash cannot make a number that reads as two.
export function receiptPrefix() {
  return String(state.settings?.receiptPrefix || "")
    .toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 8);
}

// "OCR-2026-0001", or "2026-0001" for a company that has set no prefix.
export function formatReceiptNo(seq, year, prefix) {
  const p = prefix === undefined ? receiptPrefix() : String(prefix || "");
  const body = `${year}-${String(seq).padStart(4, "0")}`;
  return p ? `${p}-${body}` : body;
}

// The number on a booking's receipt, or "" if none has been issued yet.
export function receiptNo(b) { return String(b?.receiptNo || ""); }
export function hasReceiptNo(b) { return !!receiptNo(b); }

// Every receipt number already handed out, so a manual entry cannot repeat one.
// Compared on letters and digits only, so spelling differences do not let the
// same number through twice: "ocr 2026 0001", "OCR-2026-0001" and
// "OCR/2026/0001" are one number to everyone except a computer.
function normaliseReceiptNo(v) {
  return String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// ---------- Themes ----------
// Per-company appearance, stored on the settings document so everyone who
// signs in to the company sees the same app. A theme is a full, curated set
// of the CSS variables the stylesheet runs on — curated, because arbitrary
// combinations are how text ends up unreadable on its own background. On top
// of a preset, two custom colours may override: the page background, and the
// accent (header, primary buttons, active tabs), whose text colour is chosen
// automatically for contrast. Printed documents are untouched on purpose: an
// agreement or invoice is paper, whatever the screen looks like.

const THEME_PRESETS = {
  cream:    { name: "Cream",       bg: "#f5f2eb", surface: "#ffffff", border: "#e0dbd0", text: "#1a1814", muted: "#7a7568", accent: "#1a1814", ink: "#f5f2eb" },
  paper:    { name: "Paper",       bg: "#f7f7f5", surface: "#ffffff", border: "#e2e2df", text: "#1a1a1c", muted: "#71737a", accent: "#1a1a1c", ink: "#f7f7f5" },
  ocean:    { name: "Ocean",       bg: "#edf3f5", surface: "#ffffff", border: "#d3e1e6", text: "#132f38", muted: "#54707c", accent: "#0f4c5c", ink: "#f2f8fa" },
  forest:   { name: "Forest",      bg: "#f0f4ec", surface: "#ffffff", border: "#d9e2cf", text: "#1c291c", muted: "#647159", accent: "#2f5d2f", ink: "#f2f7ee" },
  sand:     { name: "Sand",        bg: "#f7f0e3", surface: "#fffdf8", border: "#e7d9c0", text: "#2b2115", muted: "#8a7455", accent: "#7a4a1f", ink: "#faf4e8" },
  lavender: { name: "Lavender",    bg: "#f3f0f8", surface: "#ffffff", border: "#ddd6ea", text: "#251d36", muted: "#6f6788", accent: "#5b3d8a", ink: "#f5f1fa" },
  rose:     { name: "Rose",        bg: "#f9f0f2", surface: "#ffffff", border: "#ebd5db", text: "#331d24", muted: "#8a6d76", accent: "#963a55", ink: "#faf2f4" },
  night:    { name: "Night (beta)", bg: "#15171c", surface: "#1e222a", border: "#343a46", text: "#e7e5e0", muted: "#98a0ac", accent: "#d8b45a", ink: "#15171c",
              greenBg: "#1c2f1f", greenText: "#93cf9a", amberBg: "#322a12", amberText: "#e0bb63",
              redBg: "#331b1b", redText: "#e28a8a", blueBg: "#1a2534", blueText: "#93b4dc" }
};

export const THEME_LIST = Object.entries(THEME_PRESETS)
  .map(([key, p]) => ({ key, name: p.name, bg: p.bg, accent: p.accent }));

export function themePresetOf(s) {
  const k = String(s?.themePreset || "");
  return THEME_PRESETS[k] ? k : "cream";
}

function cleanHex(v) {
  return /^#[0-9a-fA-F]{6}$/.test(String(v || "")) ? String(v).toLowerCase() : "";
}

// Black or near-white ink, whichever reads better on the given colour.
function readableOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 150 ? "#1a1814" : "#f7f5f0";
}

export function themeVars(s) {
  const p = THEME_PRESETS[themePresetOf(s)];
  const vars = {
    "--bg": p.bg, "--surface": p.surface, "--border": p.border,
    "--text": p.text, "--muted": p.muted,
    "--accent": p.accent, "--accent-ink": p.ink,
    "--green-bg": p.greenBg || "#e8f4e8", "--green-text": p.greenText || "#2d6a2d",
    "--amber-bg": p.amberBg || "#fdf3dc", "--amber-text": p.amberText || "#8a5c00",
    "--red-bg": p.redBg || "#fdeaea", "--red-text": p.redText || "#8a2020",
    "--blue-bg": p.blueBg || "#e8eef6", "--blue-text": p.blueText || "#2d4a6a"
  };
  const bg = cleanHex(s?.themeBg);
  if (bg) vars["--bg"] = bg;
  const accent = cleanHex(s?.themeAccent);
  if (accent) { vars["--accent"] = accent; vars["--accent-ink"] = readableOn(accent); }
  return vars;
}

export function applyTheme(s) {
  const vars = themeVars(s);
  const rootEl = document.documentElement;
  Object.entries(vars).forEach(([k, v]) => rootEl.style.setProperty(k, v));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", vars["--accent"]);
}

// ---------- Invoice numbers ----------
// Same discipline as receipts, two independent series: INV for ordinary
// invoices, VAT for VAT invoices — "different invoice numbers for each so it's
// easily identifiable" (pilot, Aug 2026). Which series a company issues from
// is decided by the VAT-registered box on Settings at the moment of issue.

export function invoiceKindFor() {
  return state.settings?.vatRegistered ? "vat" : "normal";
}

// The VAT rate from Settings; 15 when unset. Snapshotted onto the booking at
// issue so a later rate change never rewrites an invoice already sent.
export function vatRatePct() {
  const n = Number(state.settings?.vatRate);
  return Number.isFinite(n) && n > 0 ? n : 15;
}

// Prices are VAT-inclusive (accountant, Aug 2026): the customer's total never
// changes; the invoice states how much of it is VAT. The card charge sits
// inside the base — "VAT on the whole amount after the 3%".
export function vatSplit(total, pct) {
  const rate = (typeof pct === "number" && pct > 0 ? pct : vatRatePct()) / 100;
  const t = Number(total) || 0;
  const excl = Math.round((t / (1 + rate)) * 100) / 100;
  return { excl, vat: Math.round((t - excl) * 100) / 100 };
}

export function formatInvoiceNo(seq, year, kind, prefix) {
  const p = prefix === undefined ? receiptPrefix() : String(prefix || "");
  const tag = kind === "vat" ? "VAT" : "INV";
  const body = `${tag}-${year}-${String(seq).padStart(4, "0")}`;
  return p ? `${p}-${body}` : body;
}

export function invoiceNo(b) { return String(b?.invoiceNo || ""); }
export function hasInvoiceNo(b) { return !!invoiceNo(b); }
export function invoiceSeqField(kind) { return kind === "vat" ? "vatInvoiceSeq" : "invoiceSeq"; }

export function invoiceNoTaken(candidate, exceptBookingId) {
  const norm = normaliseReceiptNo(candidate);
  if (!norm) return false;
  return state.bookings.some(b =>
    b.id !== exceptBookingId && normaliseReceiptNo(b.invoiceNo) === norm);
}

export function receiptNoTaken(candidate, exceptBookingId) {
  const want = normaliseReceiptNo(candidate);
  if (!want) return false;
  return state.bookings.some(b =>
    b.id !== exceptBookingId && normaliseReceiptNo(b.receiptNo) === want);
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

export function expenseCategoryNames() {
  const own = settingsList("expenseCategories");
  if (own.length) return dedupeKeepOrder(own);
  return mergeNames(state.expenses.map(x => x.category));
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

// ---------- Reports: the grids finance keeps by hand ----------
// One row per vehicle, one column per month, a total and an average down the
// right. Revenue and expenses share the shape, so they share the machinery —
// two reports that disagreed about how a row is totalled would be worse than
// no second report at all.
//
// Both are filed by date the same way the rest of the app files things, so a
// column here reconciles against the Billing summary for the same month.

function blankYear() { return new Array(12).fill(0); }

function carRows() {
  return orderedCars().map(c => ({
    carId: c.id,
    label: `${c.year || ""} ${c.make} ${c.model}`.trim(),
    plate: c.plate || "",
    months: blankYear()
  }));
}

// Totals, averages and the footer row. Averages are over the months that
// actually had something in them, never over twelve: a car bought in October
// would otherwise show a twelfth of its takings and read as the worst vehicle
// in the fleet.
function finishGrid(y, rows) {
  rows.forEach(r => {
    r.total = r.months.reduce((s, v) => s + v, 0);
    r.activeMonths = r.months.filter(v => v > 0).length;
    r.average = r.activeMonths ? r.total / r.activeMonths : 0;
  });

  const totals = blankYear();
  rows.forEach(r => r.months.forEach((v, i) => { totals[i] += v; }));
  const grandTotal = totals.reduce((s, v) => s + v, 0);
  const busy = totals.filter(v => v > 0).length;

  return { year: y, rows, totals, grandTotal, average: busy ? grandTotal / busy : 0 };
}

// What each vehicle earned. Filed by the day a rental starts — "the August
// invoices" are the rentals that began in August — so a rental crossing a
// month boundary counts wholly in the month it started. Bank charges are
// excluded, for the reason they are excluded everywhere: the company collects
// them for the bank, so they are not what the car earned.
export function revenueByCarMonth(year) {
  const y = String(year);
  const rows = carRows();
  const byId = new Map(rows.map(r => [r.carId, r]));

  // A car sold last year still earned money while it was here. Dropping its
  // bookings would leave the report short of the year's real takings, and a
  // total that does not match Billing is a report nobody trusts again.
  const gone = { carId: "", label: "Cars no longer in the fleet", plate: "", months: blankYear() };

  state.bookings.forEach(b => {
    const d = String(b.startDate || "");
    if (d.slice(0, 4) !== y) return;
    const m = Number(d.slice(5, 7)) - 1;
    if (!(m >= 0 && m < 12)) return;
    (byId.get(b.carId) || gone).months[m] += invoiceTotal(b);
  });

  const out = rows.slice();
  if (gone.months.some(v => v > 0)) out.push(gone);
  return finishGrid(y, out);
}

// What each vehicle cost. Same grid, from the Expenses page, matched by the
// car and the date recorded on each expense.
//
// Money spent without a car against it — office costs, a bulk purchase — gets
// its own row rather than being dropped. A per-car report whose total is
// quietly less than the Expenses page is the first thing an accountant catches
// and the last time they trust the report.
export function expensesByCarMonth(year) {
  const y = String(year);
  const rows = carRows();
  const byId = new Map(rows.map(r => [r.carId, r]));

  const gone = { carId: "", label: "Cars no longer in the fleet", plate: "", months: blankYear() };
  const noCar = { carId: "", label: "Not car-specific", plate: "", months: blankYear() };

  (state.expenses || []).forEach(x => {
    const d = String(x.date || "");
    if (d.slice(0, 4) !== y) return;
    const m = Number(d.slice(5, 7)) - 1;
    if (!(m >= 0 && m < 12)) return;
    const amount = Math.max(0, Number(x.amount) || 0);
    const row = x.carId ? (byId.get(x.carId) || gone) : noCar;
    row.months[m] += amount;
  });

  const out = rows.slice();
  if (gone.months.some(v => v > 0)) out.push(gone);
  if (noCar.months.some(v => v > 0)) out.push(noCar);
  return finishGrid(y, out);
}

// ---------- Month by month: occupancy, income, expenses, net ----------

export function daysInMonth(year, monthIndex) {
  return new Date(Number(year), monthIndex + 1, 0).getDate();
}

function nextDay(ds) {
  const d = new Date(ds + "T12:00");
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Every calendar day a rental holds the car. The return day is not counted —
// the car comes back and can go out again — which makes a 3rd-to-6th rental
// three days, the same answer the invoice gives. A same-day rental still
// occupies the day it happened on.
function occupiedDays(b, fn) {
  const start = String(b.startDate || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return;
  const end = String(b.endDate || "");
  const stop = (end > start) ? end : nextDay(start);
  let cur = start, guard = 0;
  while (cur < stop && guard++ < 800) { fn(cur); cur = nextDay(cur); }
}

// The pilot's own monthly sheet: one row per month, occupancy beside the money.
//
// Income is what was invoiced — the same figure as Booked and as the revenue
// grid above, so the three always agree. Expenses are what the Expenses page
// recorded in that month. Net is simply one minus the other.
//
// Occupancy is days rented divided by days available, where available is the
// fleet size times the days in the month. One caveat worth knowing: the fleet
// size is today's fleet, because that is the only one the app can know — a car
// sold in March still widens the denominator for January. With a steady fleet
// it is accurate; through a big change it drifts, which is why the figure is
// labelled on screen rather than left to speak for itself.
export function monthlySummary(year) {
  const y = String(year);
  const months = Array.from({ length: 12 }, (_, i) => ({
    month: i, income: 0, expenses: 0, rentedDays: 0
  }));

  state.bookings.forEach(b => {
    const d = String(b.startDate || "");
    if (d.slice(0, 4) === y) {
      const m = Number(d.slice(5, 7)) - 1;
      if (m >= 0 && m < 12) months[m].income += invoiceTotal(b);
    }
    // Occupancy is counted day by day, so a rental spanning two months adds
    // its days to both — unlike the money, which belongs to one month only.
    occupiedDays(b, ds => {
      if (ds.slice(0, 4) !== y) return;
      const m = Number(ds.slice(5, 7)) - 1;
      if (m >= 0 && m < 12) months[m].rentedDays += 1;
    });
  });

  (state.expenses || []).forEach(x => {
    const d = String(x.date || "");
    if (d.slice(0, 4) !== y) return;
    const m = Number(d.slice(5, 7)) - 1;
    if (m >= 0 && m < 12) months[m].expenses += Math.max(0, Number(x.amount) || 0);
  });

  const fleet = state.cars.length;
  months.forEach(mm => {
    mm.net = mm.income - mm.expenses;
    mm.availableDays = fleet * daysInMonth(y, mm.month);
    mm.occupancy = mm.availableDays > 0 ? mm.rentedDays / mm.availableDays : 0;
    mm.active = mm.income > 0 || mm.expenses > 0 || mm.rentedDays > 0;
  });

  const sum = f => months.reduce((s, m) => s + f(m), 0);
  const activeMonths = months.filter(m => m.active);
  const active = activeMonths.length;
  // Occupancy for the year is weighted across the months that actually traded,
  // not across all twelve. Dividing a part-finished year by a whole year of
  // available days is arithmetically true and practically a lie: five busy
  // months at 15% came out as 6% for the year, sitting under a column of
  // fifteens. A full year of trading has twelve active months, so a completed
  // year is unaffected.
  const rentedDays = activeMonths.reduce((s, m) => s + m.rentedDays, 0);
  const availableDays = activeMonths.reduce((s, m) => s + m.availableDays, 0);

  return {
    year: y,
    months,
    fleet,
    total: {
      income: sum(m => m.income),
      expenses: sum(m => m.expenses),
      net: sum(m => m.net),
      // Weighted across the whole year rather than an average of averages, so
      // a quiet February cannot count for as much as a full August.
      occupancy: availableDays > 0 ? rentedDays / availableDays : 0
    },
    average: {
      months: active,
      income: active ? sum(m => m.income) / active : 0,
      expenses: active ? sum(m => m.expenses) / active : 0,
      net: active ? sum(m => m.net) / active : 0,
      occupancy: active ? months.filter(m => m.active).reduce((s, m) => s + m.occupancy, 0) / active : 0
    }
  };
}

// Every year that has a booking in it, newest first, so the report's year
// picker offers exactly the years there is something to show.
export function bookingYears() {
  const years = new Set();
  const add = d => {
    const y = String(d || "").slice(0, 4);
    if (/^\d{4}$/.test(y)) years.add(y);
  };
  state.bookings.forEach(b => add(b.startDate));
  // Expenses too: a year with spending but no rentals still has a report worth
  // opening, and leaving it out of the list makes it unreachable.
  (state.expenses || []).forEach(x => add(x.date));
  years.add(todayStr().slice(0, 4));
  return [...years].sort().reverse();
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
  // A dialog that is not inside the root asking for it can never open, and
  // returning quietly makes that look like a dead button. It cost a released
  // version once: the receipt dialog was written into the billing page while
  // the booking form was the one opening it, so the button did nothing at all.
  if (!m) { console.warn(`openModal: no dialog "${name}" inside`, root); return; }
  m.classList.add("open");
  // A dialog is a scrolling box that keeps the position it was left at, so
  // reopening one landed wherever the last person stopped reading. On the
  // booking form — the longest of them — a new booking opened at the colour
  // swatches and the Save button, well past the customer fields, and looked
  // like a half-finished form rather than an empty one. Every dialog opens at
  // its first field. (showError scrolls back to the top for the same reason.)
  const box = m.querySelector(".modal");
  if (box) {
    box.scrollTop = 0;
    modalSnapshots.set(box, formSnapshot(box));
  }
}

// ---------- Has this dialog been touched? ----------
// Clicking the dark surround closes a dialog, which is the usual way out and
// also the usual way to lose twenty minutes of typing — the pilot clicked
// beside the booking form and the whole thing went. A caller can ask whether
// anything has actually been entered before it throws the form away.
//
// The answer comes from a reading of every field taken when the dialog opened,
// compared with the same reading now, rather than a "changed" flag each
// control would have to set — which every field added later would have to
// remember to do. Typing something and typing it back out again reads as
// untouched, which is the honest answer.
const modalSnapshots = new WeakMap();

function formSnapshot(box) {
  const parts = [];
  box.querySelectorAll("input, select, textarea").forEach(f => {
    parts.push(f.type === "checkbox" || f.type === "radio" ? (f.checked ? "1" : "0") : f.value);
  });
  // Not everything a dialog holds is a field: the planner colour is a chosen
  // swatch, the damage marks are drawn into an SVG, and a signature is pixels
  // on a canvas. All three are work someone would hate to lose.
  box.querySelectorAll(".swatch.selected").forEach(s => parts.push(s.dataset.colour || ""));
  box.querySelectorAll("svg").forEach(s => parts.push(s.innerHTML));
  box.querySelectorAll("canvas").forEach(c => {
    try { parts.push(c.toDataURL()); } catch (e) { /* tainted canvas — skip it */ }
  });
  // Joined on a control character no field can contain, so "ab" + "c" cannot
  // read the same as "a" + "bc".
  return parts.join("\u0001");
}

// True when something has been entered since the dialog opened. A dialog with
// no recorded snapshot counts as untouched, so this can never block a close
// on a dialog it does not know about.
export function modalTouched(overlay) {
  const box = overlay && overlay.querySelector(".modal");
  if (!box) return false;
  const before = modalSnapshots.get(box);
  return before !== undefined && before !== formSnapshot(box);
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
