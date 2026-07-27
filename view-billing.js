// Billing view — each started booking is an invoice, with advance and
// security deposits tracked separately.
import { db, setSync } from "./firebase-init.js";
import { updateDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  state, onDataChange, esc, formatDate, formatAmount, bookingCarLabel, customerForBooking,
  rentalDays, rateFor, rentalTotal, hasManualTotal, advancePaid, balanceFor, securityHeld,
  settledAmount, isBillable, hasStarted, inPeriod, settledOn, PERIOD_DAYS,
  initPanelToggle,
  el, val, setVal, openModal, closeModal, showError
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
// "" is every date, "2027" a whole year, "2027-02" a single month. The value is
// a plain date prefix, so filtering is a startsWith and cannot go wrong.
let period = "";
let depositBookingId = null;

export function mount(container) {
  root = container;

  // The summary figures start closed so the working part of the view is
  // first on screen — the phone screens had almost nothing else visible.
  summaryOpen = initPanelToggle(root, "billingShowSummary", "toggle-summary", "hide-summary", "Summary");

  el(root, "period").addEventListener("change", () => {
    period = el(root, "period").value;
    render();
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
    .reduce((sum, b) => sum + rentalTotal(b), 0);

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
    listEl.innerHTML = '<div class="empty">No invoices here. Invoices appear when a booking starts.</div>';
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
    return `
    <div class="item-card ${b.paid ? "completed" : "upcoming"}">
      <div class="card-top">
        <div>
          <div class="card-title">${esc(b.renter)} — ${formatAmount(b.paid ? total : balance)}${b.paid ? "" : " owed"}</div>
          <div class="card-sub">${esc(bookingCarLabel(b))}</div>
        </div>
        <span class="badge ${BADGE[categoryOf(b)].cls}">${BADGE[categoryOf(b)].text}</span>
      </div>
      <div class="card-details">
        <span>Period: <strong>${formatDate(b.startDate)} – ${formatDate(b.endDate)}</strong></span>
        ${hasManualTotal(b)
          ? `<span>Agreed price: <strong>${formatAmount(total)}</strong> <span style="opacity:0.7;">(${days} day${days === 1 ? "" : "s"})</span></span>`
          : `<span>${days} day${days === 1 ? "" : "s"} × <strong>${formatAmount(rate)}</strong>/day = <strong>${formatAmount(total)}</strong></span>`}
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
      <div class="card-actions">
        ${b.paid
          ? `<button class="btn" data-act="markunpaid" data-id="${b.id}">Mark as unpaid</button>`
          : `<button class="btn" data-act="markpaid" data-id="${b.id}">Mark balance paid</button>`}
        <button class="btn" data-act="deposits" data-id="${b.id}">Deposits</button>
        ${!b.paid && customerForBooking(b)?.email ? `<button class="btn" data-act="email" data-id="${b.id}">Email reminder</button>` : ""}
        ${!b.paid && (b.phone || customerForBooking(b)?.phone) ? `<button class="btn" data-act="sms" data-id="${b.id}">SMS reminder</button>` : ""}
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

// Every option is built from dates that genuinely have invoices behind them, so
// there is no way to select a period that comes back empty, and no way to pick a
// month without the year it belongs to.
function refreshPeriodOptions() {
  const sel = el(root, "period");

  // Which months, per year, actually have something in them
  const byYear = new Map();
  state.bookings.filter(isBillable).forEach(b => {
    const d = b.startDate || "";
    if (!/^\d{4}-\d{2}/.test(d)) return;
    const y = d.slice(0, 4), m = d.slice(5, 7);
    if (!byYear.has(y)) byYear.set(y, new Set());
    byYear.get(y).add(m);
  });

  const years = [...byYear.keys()].sort().reverse();
  const signature = years.map(y => y + ":" + [...byYear.get(y)].sort().join("")).join("|");
  if (sel.dataset.built === signature) return;   // nothing new; leave the choice alone

  sel.innerHTML =
    `<option value="">All dates</option>` +
    years.map(y => {
      const months = [...byYear.get(y)].sort().reverse();
      return `<optgroup label="${y}">` +
        `<option value="${y}">Whole of ${y}</option>` +
        months.map(m => `<option value="${y}-${m}">${MONTHS[Number(m) - 1]} ${y}</option>`).join("") +
        `</optgroup>`;
    }).join("");

  sel.dataset.built = signature;
  // Keep the current choice if it still exists, otherwise fall back to all dates
  if ([...sel.querySelectorAll("option")].some(o => o.value === period)) sel.value = period;
  else { period = ""; sel.value = ""; }
}

// The value is a date prefix, so this is simply "does the start date begin with
// what was chosen" — "2027" matches the year, "2027-02" matches the month.
function inChosenPeriod(b) {
  if (!period) return true;
  return (b.startDate || "").startsWith(period);
}

function periodLabel() {
  if (!period) return "all dates";
  if (period.length === 4) return period;
  return `${MONTHS[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;
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
    money = `${formatAmount(sum(list, rentalTotal))} booked, nothing due yet`;
  } else {
    const owed = sum(list.filter(b => categoryOf(b) === "unpaid"), balanceFor);
    money = `${formatAmount(sum(list, rentalTotal))} in rentals · ${formatAmount(owed)} still owed`;
  }

  // Naming the period matters: without it a filtered total looks like the whole
  // picture, and someone could read "3 invoices" as the company's entire ledger.
  const scope = period ? ` · ${periodLabel()}` : "";
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
  const company = state.ctx.companyName || "our team";
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
  const c = customerForBooking(b);
  const to = c?.email || "";
  if (!to) { alert("No email address saved for this customer. Add one on the Customers view."); return; }
  const subject = `Payment reminder - car rental ${formatDate(b.startDate)}`;
  window.location.href =
    `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(reminderText(b))}`;
}

function contactBySms(b) {
  const c = customerForBooking(b);
  const to = (b.phone || c?.phone || "").replace(/\s+/g, "");
  if (!to) { alert("No phone number saved for this customer."); return; }
  const short =
    `Reminder from ${state.ctx.companyName || "us"}: ${formatAmount(balanceFor(b))} outstanding for your rental ` +
    `(${formatDate(b.startDate)} - ${formatDate(b.endDate)}). Please contact us to arrange payment. Thank you.`;
  window.location.href = `sms:${to}?&body=${encodeURIComponent(short)}`;
}
