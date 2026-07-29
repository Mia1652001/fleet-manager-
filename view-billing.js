// Billing view — each started booking is an invoice, with advance and
// security deposits tracked separately.
import { db, setSync } from "./firebase-init.js";
import { openBookingModal } from "./booking-form.js";
import { updateDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  state, onDataChange, esc, formatDate, formatAmount, bookingCarLabel, customerForBooking, companyName,
  rentalDays, rateFor, rentalTotal, hasManualTotal, advancePaid, balanceFor, securityHeld,
  settledAmount, isBillable, hasStarted, inPeriod, settledOn, PERIOD_DAYS,
  initPanelToggle,
  el, val, setVal, openModal, closeModal, showError,
  bookingRef,
  invoiceTotal,
  deliveryCost, insuranceCost, otherCost, extrasTotal
} from "./store.js";

// The badge on a card names the same category the tabs sort by, so a card can
// never be labelled one thing and filed under another.
const BADGE = {
  paid:     { cls: "available", text: "Paid" },
  unpaid:   { cls: "overdue",   text: "Unpaid" },
  upcoming: { cls: "upcoming",  text: "Not started" }
};

let root = null;
let summaryOpen = () => true;   // set on mount; see initPanelToggle
let filter = "unpaid";
// Both default to "", meaning no restriction. They work independently: a year
// alone gives that whole year, a month alone gives that month in every year, and
// the two together give one month of one year.
let periodYear = "";
let periodMonth = "";
let depositBookingId = null;

export function mount(container) {
  root = container;

  // The summary figures start closed so the working part of the view is
  // first on screen — the phone screens had almost nothing else visible.
  summaryOpen = initPanelToggle(root, "billingShowSummary", "toggle-summary", "hide-summary", "Summary");

  buildMonthOptions();
  el(root, "period-year").addEventListener("change", () => {
    periodYear = el(root, "period-year").value; render();
  });
  el(root, "period-month").addEventListener("change", () => {
    periodMonth = el(root, "period-month").value; render();
  });

  el(root, "search").addEventListener("input", render);
  el(root, "save-deposit").addEventListener("click", saveDeposits);

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

  el(root, "list").addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const id = btn.dataset.id;
    const b = state.bookings.find(x => x.id === id);
    if (!b) return;

    if (btn.dataset.act === "deposits") { openDepositModal(id); return; }
    if (btn.dataset.act === "open") { openBookingModal(id); return; }
    if (btn.dataset.act === "email") { contactByEmail(b); return; }
    if (btn.dataset.act === "sms") { contactBySms(b); return; }

    btn.disabled = true;
    setSync("saving");
    try {
      if (btn.dataset.act === "markpaid") {
        await updateDoc(doc(db, "bookings", id), {
          paid: true, paidAmount: settledAmount(b), paidAt: new Date().toISOString()
        });
      } else if (btn.dataset.act === "markunpaid") {
        await updateDoc(doc(db, "bookings", id), { paid: false, paidAmount: null, paidAt: null });
      } else if (btn.dataset.act === "refund") {
        await updateDoc(doc(db, "bookings", id), { securityStatus: "refunded" });
      } else if (btn.dataset.act === "keep") {
        await updateDoc(doc(db, "bookings", id), { securityStatus: "kept" });
      }
    } catch (err) {
      alert("Couldn't update (" + (err.code || err.message) + "). Try again.");
      setSync("error");
    }
    btn.disabled = false;
  });

  onDataChange(() => { if (root.classList.contains("active")) render(); });
}

export function render() {
  if (!root) return;
  const search = el(root, "search").value.toLowerCase();
  const billable = state.bookings.filter(isBillable);

  // Same definition the Unpaid tab uses, so the headline count and the number
  // of cards in that tab are always the same number.
  const unpaid = billable.filter(b => categoryOf(b) === "unpaid");
  const outstanding = unpaid.reduce((sum, b) => sum + balanceFor(b), 0);

  // Money in over the window. settledOn() rather than paidAt directly, so
  // bookings ticked as paid on the booking form are counted too.
  const received = billable
    .filter(b => b.paid && inPeriod(settledOn(b)))
    .reduce((sum, b) => sum + settledAmount(b), 0);

  // What the period is worth in rentals, settled or not, by when they started.
  const booked = billable
    .filter(b => inPeriod(b.startDate))
    .reduce((sum, b) => sum + invoiceTotal(b), 0);

  const depositsHeld = billable.reduce((sum, b) => sum + securityHeld(b), 0);

  if (summaryOpen()) el(root, "stats").innerHTML = `
    <div class="stat"><div class="stat-label">Outstanding</div><div class="stat-val red">${formatAmount(outstanding)}</div></div>
    <div class="stat"><div class="stat-label">Unpaid invoices</div><div class="stat-val amber">${unpaid.length}</div></div>
    <div class="stat"><div class="stat-label">Booked (${PERIOD_DAYS} days)</div><div class="stat-val">${formatAmount(booked)}</div></div>
    <div class="stat"><div class="stat-label">Received (${PERIOD_DAYS} days)</div><div class="stat-val green">${formatAmount(received)}</div></div>
    <div class="stat"><div class="stat-label">Deposits held</div><div class="stat-val blue">${formatAmount(depositsHeld)}</div></div>
  `;

  refreshPeriodOptions();
  renderTabCounts(search);
  let list = invoicesFor(filter, search);
  list.sort((a, b) => (a.paid - b.paid) || b.startDate.localeCompare(a.startDate));
  renderListTotals(list);

  const listEl = el(root, "list");
  if (list.length === 0) {
    // Say which period is empty, or "February 2026 shows nothing" looks like a
    // fault rather than an accurate answer.
    listEl.innerHTML = (periodYear || periodMonth)
      ? `<div class="empty">No invoices in ${esc(periodLabel())}. Widen the period above to see more.</div>`
      : '<div class="empty">No invoices here. Invoices appear when a booking starts.</div>';
    return;
  }

  listEl.innerHTML = list.map(b => {
    const days = rentalDays(b);
    const rate = rateFor(b);
    const total = rentalTotal(b);
    const adv = advancePaid(b);
    const balance = balanceFor(b);
    const sec = b.securityDeposit || 0;
    const secStatus = b.securityStatus || "held";
    // Looked up once: the buttons and the missing-contact note below all need it.
    const cust = customerForBooking(b);
    const hasEmail = !!(b.email || cust?.email);
    const hasPhone = !!(b.phone || cust?.phone);
    return `
    <div class="item-card ${b.paid ? "completed" : "upcoming"}">
      <div class="card-top">
        <div>
          <div class="card-title">${esc(b.renter)} — ${formatAmount(b.paid ? total : balance)}${b.paid ? "" : " owed"}</div>
          <div class="card-sub">${esc(bookingCarLabel(b))} · <span class="ref">${esc(bookingRef(b))}</span></div>
        </div>
        <span class="badge ${BADGE[categoryOf(b)].cls}">${BADGE[categoryOf(b)].text}</span>
      </div>
      <div class="card-details">
        <span>Period: <strong>${formatDate(b.startDate)} – ${formatDate(b.endDate)}</strong></span>
        ${b.broker ? `<span>Broker: <strong>${esc(b.broker)}</strong></span>` : ""}
        ${hasManualTotal(b)
          ? `<span>Agreed price: <strong>${formatAmount(total)}</strong> <span style="opacity:0.7;">(${days} day${days === 1 ? "" : "s"})</span></span>`
          : `<span>${days} day${days === 1 ? "" : "s"} × <strong>${formatAmount(rate)}</strong>/day = <strong>${formatAmount(total)}</strong></span>`}
        ${deliveryCost(b) > 0 ? `<span>Delivery: <strong>${formatAmount(deliveryCost(b))}</strong></span>` : ""}
        ${insuranceCost(b) > 0 ? `<span>Insurance: <strong>${formatAmount(insuranceCost(b))}</strong></span>` : ""}
        ${otherCost(b) > 0 ? `<span>Other: <strong>${formatAmount(otherCost(b))}</strong></span>` : ""}
        ${extrasTotal(b) > 0 ? `<span>Invoice total: <strong>${formatAmount(invoiceTotal(b))}</strong></span>` : ""}
        ${adv > 0 ? `<span>Advance paid: <strong>-${formatAmount(adv)}</strong></span>` : ""}
        ${adv > 0 && !b.paid ? `<span>Balance: <strong>${formatAmount(balance)}</strong></span>` : ""}
        ${b.paid && b.paidAt ? `<span>Paid on: <strong>${formatDate(b.paidAt.slice(0, 10))}</strong></span>` : ""}
        ${b.paid && settledAmount(b) !== total ? `<span>Counted as received: <strong>${formatAmount(settledAmount(b))}</strong> <span style="opacity:0.7;">(the advance came in earlier)</span></span>` : ""}
        ${(rate === 0 && !hasManualTotal(b)) ? `<span style="color:var(--red-text);">No daily rate set on this car — edit the car in Fleet, or enter a total on the booking</span>` : ""}
      </div>
      ${sec > 0 ? `
      <div class="card-details" style="margin-top:6px;">
        <span>Security deposit: <strong>${formatAmount(sec)}</strong></span>
        <span>Status: <strong>${secStatus === "held" ? "Held (refundable)" : secStatus === "refunded" ? "Refunded" : "Kept"}</strong></span>
      </div>` : ""}
      ${!b.paid && !hasPhone && !hasEmail ? `
      <div class="card-details" style="border-top:none;padding-top:0;margin-top:6px;">
        <span style="color:var(--muted);">No phone or email saved — open the booking and add one, then a reminder can be sent</span>
      </div>` : ""}
      <div class="card-actions">
        ${b.paid
          ? `<button class="btn" data-act="markunpaid" data-id="${b.id}">Mark as unpaid</button>`
          : `<button class="btn" data-act="markpaid" data-id="${b.id}">Mark balance paid</button>`}
        <button class="btn" data-act="deposits" data-id="${b.id}">Deposits</button>
        <button class="btn" data-act="open" data-id="${b.id}">View booking</button>
        ${!b.paid && hasEmail ? `<button class="btn" data-act="email" data-id="${b.id}">Email reminder</button>` : ""}
        ${!b.paid && hasPhone ? `<button class="btn" data-act="sms" data-id="${b.id}">SMS reminder</button>` : ""}
        ${sec > 0 && secStatus === "held" ? `
          <button class="btn" data-act="refund" data-id="${b.id}">Refund deposit</button>
          <button class="btn" data-act="keep" data-id="${b.id}">Keep deposit</button>` : ""}
      </div>
    </div>`;
  }).join("");
}

// ---------- Categories ----------
// One definition, used for the tab counts, the totals line and the list itself,
// so those three can never drift apart. Every invoice lands in exactly one
// category, which means the three counts always add up to All. Previously a
// booking paid in advance of its start date fell into both Paid and Not
// started, so the counts came to more than the total.
function categoryOf(b) {
  if (b.paid) return "paid";                       // money in, whenever it starts
  return hasStarted(b) ? "unpaid" : "upcoming";    // owed now, or nothing due yet
}

function matchesSearch(b, search) {
  return `${b.renter || ""} ${bookingCarLabel(b)}`.toLowerCase().includes(search);
}

// ---------- Period ----------
// Invoices are filed by when the rental starts, which is how the desk thinks of
// them: "the August invoices" means the rentals that began in August.
const MONTHS = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"];

// All twelve months, always. An earlier version listed only months that already
// had invoices, which meant most of the year was simply missing from the menu.
function buildMonthOptions() {
  el(root, "period-month").innerHTML =
    `<option value="">All months</option>` +
    MONTHS.map((m, i) =>
      `<option value="${String(i + 1).padStart(2, "0")}">${m}</option>`).join("");
}

// Years the company has bookings in, plus a couple either side of today so
// forward planning is possible before anything is booked that far ahead.
function refreshPeriodOptions() {
  const sel = el(root, "period-year");
  const thisYear = new Date().getFullYear();
  const years = new Set([thisYear - 1, thisYear, thisYear + 1, thisYear + 2]);
  state.bookings.filter(isBillable).forEach(b => {
    const y = (b.startDate || "").slice(0, 4);
    if (/^\d{4}$/.test(y)) years.add(Number(y));
  });

  const sorted = [...years].sort((a, b) => b - a);
  const signature = sorted.join(",");
  if (sel.dataset.built === signature) return;   // unchanged; leave the choice alone

  sel.innerHTML = `<option value="">All years</option>` +
    sorted.map(y => `<option value="${y}">${y}</option>`).join("");
  sel.dataset.built = signature;
  sel.value = periodYear;
}

// The two conditions are checked separately, which is what lets either one work
// on its own. The previous version made the month meaningless unless a year was
// also chosen, so picking "October" quietly filtered nothing at all.
function inChosenPeriod(b) {
  const d = b.startDate || "";
  if (periodYear && d.slice(0, 4) !== periodYear) return false;
  if (periodMonth && d.slice(5, 7) !== periodMonth) return false;
  return true;
}

function periodLabel() {
  const m = periodMonth ? MONTHS[Number(periodMonth) - 1] : "";
  if (m && periodYear) return `${m} ${periodYear}`;
  if (m) return `every ${m}`;
  if (periodYear) return periodYear;
  return "all dates";
}

function invoicesFor(f, search) {
  return state.bookings.filter(isBillable)
    .filter(b => (f === "all" || categoryOf(b) === f)
              && inChosenPeriod(b)
              && matchesSearch(b, search));
}

// Totals for exactly the invoices listed below — the figure that has to
// reconcile against what is on screen, whatever filter or search is applied.
function renderListTotals(list) {
  const sum = (arr, fn) => arr.reduce((s, b) => s + fn(b), 0);
  const n = list.length;
  const count = `${n} invoice${n === 1 ? "" : "s"}`;

  let money;
  if (filter === "paid") {
    const received = sum(list, settledAmount);
    const inWindow = sum(list.filter(b => inPeriod(settledOn(b))), settledAmount);
    money = `${formatAmount(received)} received in total` +
      (inWindow !== received ? ` · ${formatAmount(inWindow)} of it in the last ${PERIOD_DAYS} days` : "");
  } else if (filter === "unpaid") {
    money = `${formatAmount(sum(list, balanceFor))} owed`;
  } else if (filter === "upcoming") {
    money = `${formatAmount(sum(list, invoiceTotal))} booked, nothing due yet`;
  } else {
    const owed = sum(list.filter(b => categoryOf(b) === "unpaid"), balanceFor);
    money = `${formatAmount(sum(list, invoiceTotal))} in rentals · ${formatAmount(owed)} still owed`;
  }

  // Naming the period matters: without it a filtered total looks like the whole
  // picture, and someone could read "3 invoices" as the company's entire ledger.
  const scope = (periodYear || periodMonth) ? ` · ${periodLabel()}` : "";
  el(root, "list-total").textContent = `${count}${scope} · ${money}`;
}

// The count on each tab is what clicking it will show, search included.
function renderTabCounts(search) {
  const labels = { unpaid: "Unpaid", paid: "Paid", upcoming: "Not started", all: "All" };
  el(root, "filters").querySelectorAll(".tab").forEach(tab => {
    const f = tab.dataset.f;
    tab.textContent = `${labels[f] || f} (${invoicesFor(f, search).length})`;
  });
}

function openDepositModal(id) {
  depositBookingId = id;
  const b = state.bookings.find(x => x.id === id);
  setVal(root, "dep-advance", b?.advancePaid || "");
  setVal(root, "dep-security", b?.securityDeposit || "");
  showError(root, "deposit-error", null);
  openModal(root, "deposit-modal");
}

async function saveDeposits() {
  if (!depositBookingId) return;
  showError(root, "deposit-error", null);

  const advance = parseFloat(val(root, "dep-advance")) || 0;
  const security = parseFloat(val(root, "dep-security")) || 0;
  if (advance < 0 || security < 0) {
    showError(root, "deposit-error", "Amounts can't be negative."); return;
  }

  const b = state.bookings.find(x => x.id === depositBookingId);
  const btn = el(root, "save-deposit");
  btn.disabled = true; btn.textContent = "Saving...";
  setSync("saving");
  try {
    const update = { advancePaid: advance, securityDeposit: security };
    if (security > 0 && !b.securityStatus) update.securityStatus = "held";
    if (security === 0) update.securityStatus = null;
    await updateDoc(doc(db, "bookings", depositBookingId), update);
    closeModal(root, "deposit-modal");
    depositBookingId = null;
  } catch (e) {
    showError(root, "deposit-error", "Couldn't save (" + (e.code || e.message) + "). Try again.");
    setSync("error");
  }
  btn.disabled = false; btn.textContent = "Save deposits";
}


// ---------- Payment reminders ----------
// These open the staff member's own email or messaging app with the message
// already written, so it can be edited before sending. Nothing is sent
// automatically and no extra service is needed.

function reminderText(b) {
  // The name set on the Settings page, not the login label — the agreement and
  // the confirmation email already use it, so the reminder must match.
  const company = companyName() || "our team";
  const owed = formatAmount(balanceFor(b));
  const lines = [
    `Dear ${b.renter || "customer"},`,
    "",
    `This is a friendly reminder about your car rental with ${company}.`,
    "",
    `Vehicle: ${bookingCarLabel(b)}`,
    `Rental period: ${formatDate(b.startDate)} to ${formatDate(b.endDate)}`,
    `Amount outstanding: ${owed}`,
    "",
    "Please get in touch to arrange payment. If you have already paid, kindly ignore this message.",
    "",
    "Thank you,",
    company
  ];
  return lines.join("\n");
}

function contactByEmail(b) {
  // The booking's own address first: a walk-in booked with "just type a name"
  // keeps its contact details on the booking rather than in the register, and
  // that is the path most bookings are taken through. Same order as the
  // confirmation email on the booking form, so the two never disagree.
  const c = customerForBooking(b);
  const to = b.email || c?.email || "";
  if (!to) { alert("No email address for this booking. Type one into the booking, or add it to the customer on the Customers view."); return; }
  const subject = `Payment reminder - car rental ${formatDate(b.startDate)}`;
  window.location.href =
    `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(reminderText(b))}`;
}

function contactBySms(b) {
  const c = customerForBooking(b);
  const to = (b.phone || c?.phone || "").replace(/\s+/g, "");
  if (!to) { alert("No phone number saved for this customer."); return; }
  const short =
    `Reminder from ${companyName() || "us"}: ${formatAmount(balanceFor(b))} outstanding for your rental ` +
    `(${formatDate(b.startDate)} - ${formatDate(b.endDate)}). Please contact us to arrange payment. Thank you.`;
  // "?body=" is the standard form and works on modern iPhones and Android
  // alike. The old "?&body=" was an iPhone-only trick: some Android phones
  // opened the messaging app with the number filled in but the message blank.
  window.location.href = `sms:${to}?body=${encodeURIComponent(short)}`;
}
