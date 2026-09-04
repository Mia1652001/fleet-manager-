// Billing view — each started booking is an invoice, with advance and
// security deposits tracked separately.
import { db, setSync } from "./firebase-init.js";
import { openBookingModal, recalcAtTodayRate } from "./booking-form.js";
import { openWhatsApp } from "./agreement.js";
import { updateDoc, doc, arrayUnion } from "./audit.js";
import {
  state, onDataChange, esc, formatDate, formatAmount, bookingCarLabel, customerForBooking, companyName, takeFocus,
  rentalDays, rateFor, rentalTotal, hasManualTotal, advancePaid, balanceFor, securityHeld,
  settledAmount, isBillable, hasStarted, settledOn, moneySummary, paidPatch,
  paymentsOf, hasLedger, paidTotal, paymentOn, advanceReceivedOn, todayStr, showToast,
  bankCharge, bankChargePct, amountDue,
  brokerNames, fxPair, fxRate,
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
// The payment and deposit dialogs are not inside this view — they sit in
// #billing-dialogs outside every view so they can open from any page. Every
// lookup into them goes through dlg, never root (4 Sep).
const dlg = document.getElementById("billing-dialogs");
let filter = "unpaid";
// Both default to "", meaning no restriction. They work independently: a year
// alone gives that whole year, a month alone gives that month in every year, and
// the two together give one month of one year.
let periodYear = "";
let periodMonth = "";
// "" means every broker. A dropdown rather than free text, built from the
// same Settings list the booking form offers, so the filter can only ever
// select a broker that actually exists.
let periodBroker = "";
// Set by render() when a jump from a booking form arrives; consumed by the
// list draw. Module-level on purpose: the two ends of the hand-off live in
// different functions, and a local variable here is exactly the scope bug
// that broke sign-in.
let revealInvoiceId = null;
let depositBookingId = null;

export function mount(container) {
  root = container;

  buildMonthOptions();
  el(root, "period-year").addEventListener("change", () => {
    periodYear = el(root, "period-year").value; render();
  });
  el(root, "period-month").addEventListener("change", () => {
    periodMonth = el(root, "period-month").value; render();
  });
  el(root, "period-broker").addEventListener("change", () => {
    periodBroker = el(root, "period-broker").value; render();
  });

  el(root, "search").addEventListener("input", render);
  el(dlg, "save-deposit").addEventListener("click", saveDeposits);
  el(dlg, "pay-save").addEventListener("click", savePayment);
  // Foreign deposit amounts fill their Rs twins from the house rate, exactly
  // like the booking total. The Rs fields stay editable afterwards.
  [["dep-fxadvance", "dep-advance"], ["dep-fxsecurity", "dep-security"]].forEach(([fxName, homeName]) => {
    el(dlg, fxName).addEventListener("input", () => {
      const b = state.bookings.find(x => x.id === depositBookingId);
      const rate = b?.fxCurrency ? fxRate(b.fxCurrency) : null;
      const amount = parseFloat(val(dlg, fxName));
      if (rate && Number.isFinite(amount) && amount >= 0) {
        setVal(dlg, homeName, Math.round(amount * rate));
      }
    });
  });

  // The "Use today's rate" buttons: recalculate just this one field of this
  // one booking. Marked-paid bookings ask for confirmation first, naming the
  // old and new figures, so a settled invoice never changes without someone
  // deliberately choosing to change it.
  const recalcAdv = el(dlg, "dep-fx-recalc-advance");
  if (recalcAdv) recalcAdv.addEventListener("click", () => {
    const b = state.bookings.find(x => x.id === depositBookingId);
    if (!b?.fxCurrency) return;
    recalcAtTodayRate(root, {
      fxInputId: "dep-fxadvance", homeInputId: "dep-advance", sym: b.fxCurrency,
      isPaid: !!b.paid, paidLabel: "advance"
    });
  });
  const recalcSec = el(dlg, "dep-fx-recalc-security");
  if (recalcSec) recalcSec.addEventListener("click", () => {
    const b = state.bookings.find(x => x.id === depositBookingId);
    if (!b?.fxCurrency) return;
    recalcAtTodayRate(root, {
      fxInputId: "dep-fxsecurity", homeInputId: "dep-security", sym: b.fxCurrency,
      isPaid: !!b.paid, paidLabel: "security deposit"
    });
  });

  el(root, "filters").addEventListener("click", (e) => {
    const t = e.target.closest(".tab");
    if (!t) return;
    filter = t.dataset.f;
    el(root, "filters").querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
    t.classList.add("active");
    render();
  });

  // Cancel buttons and click-outside, for the page's own dialogs AND the two
  // that live outside the view (see #billing-dialogs in index.html).
  [root, dlg].forEach(r => {
    r.querySelectorAll("[data-close]").forEach(b =>
      b.addEventListener("click", () => closeModal(r, b.dataset.close)));
    r.querySelectorAll(".overlay").forEach(o =>
      o.addEventListener("click", e => { if (e.target === o) o.classList.remove("open"); }));
  });

  el(root, "list").addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const id = btn.dataset.id;
    const b = state.bookings.find(x => x.id === id);
    if (!b) return;

    if (btn.dataset.act === "deposits") { openDepositModal(id); return; }
    if (btn.dataset.act === "open") { openBookingModal(id); return; }
    if (btn.dataset.act === "email") { contactByEmail(b); return; }
    if (btn.dataset.act === "whatsapp") { contactByWhatsApp(b); return; }
    if (btn.dataset.act === "pay") { openPayModal(id); return; }

    btn.disabled = true;
    setSync("saving");
    try {
      // Payment-status changes leave a trace: when, which way, and which
      // login did it. When money history looks different from what someone
      // remembers, this is the difference between an answer and a mystery.
      if (btn.dataset.act === "markpaid") {
        const p = paidPatch(b, true);
        await updateDoc(doc(db, "bookings", id), { ...p.patch, paidLog: arrayUnion(p.logEntry) });
      } else if (btn.dataset.act === "markunpaid") {
        const p = paidPatch(b, false);
        await updateDoc(doc(db, "bookings", id), { ...p.patch, paidLog: arrayUnion(p.logEntry) });
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
  // A jump from a booking's form: land on the right tab with nothing filtered
  // away, then scroll to the card. Consumed once, so ordinary redraws never
  // repeat the jump.
  const focusId = takeFocus("billing");
  revealInvoiceId = focusId || null;
  if (focusId) {
    const fb = state.bookings.find(x => x.id === focusId);
    if (fb) {
      filter = categoryOf(fb);
      setVal(root, "search", "");
      periodYear = ""; periodMonth = ""; periodBroker = "";
      const ys = el(root, "period-year"); if (ys) ys.value = "";
      const ms = el(root, "period-month"); if (ms) ms.value = "";
      const bs = el(root, "period-broker"); if (bs) bs.value = "";
      el(root, "filters").querySelectorAll(".tab").forEach(x =>
        x.classList.toggle("active", x.dataset.f === filter));
    }
  }
  if (!root) return;
  const search = el(root, "search").value.toLowerCase();
  const billable = state.bookings.filter(isBillable);

  // The summary answers for whatever the Period and Broker filters above it are
  // showing, not for a rolling 30-day window of its own. A row of figures that
  // ignored the filters directly under them read as the whole ledger however
  // the page was filtered — and "Received (30 days)" named a period nobody
  // could tie to a month. Same helper the Dashboard's Money card uses, so the
  // two screens cannot drift apart.
  const scoped = billable.filter(matchesBroker);
  const m = moneySummary(scoped, inChosenDates);
  const scope = periodLabel();

  // The period goes on its own line under each label rather than trailing it.
  // Five figures all reading "OUTSTANDING · AUGUST 2026" wrapped onto two ragged
  // lines each; naming the period still matters, so it stays — just quieter and
  // where it lines up card to card.
  const stat = (label, value, tone) => `
    <div class="stat">
      <div class="stat-label">${esc(label)}<span class="stat-scope">${esc(scope)}</span></div>
      <div class="stat-val ${tone}">${value}</div>
    </div>`;

  refreshPeriodOptions();
  refreshBrokerOptions();
  renderTabCounts(search);
  let list = invoicesFor(filter, search);
  list.sort((a, b) => (a.paid - b.paid) || b.startDate.localeCompare(a.startDate));
  renderListTotals(list);

  const listEl = el(root, "list");
  if (list.length === 0) {
    // Say which filter is empty, or "February 2026 shows nothing" looks like a
    // fault rather than an accurate answer.
    listEl.innerHTML = (periodYear || periodMonth || periodBroker)
      ? `<div class="empty">No invoices ${periodBroker ? `for ${esc(periodBroker)} ` : ""}in ${esc(periodLabel())}. Widen the filters above to see more.</div>`
      : '<div class="empty">No invoices here. Invoices appear when a booking starts.</div>';
    return;
  }

  listEl.innerHTML = list.map(b => {
    const total = rentalTotal(b);
    const balance = balanceFor(b);
    const sec = b.securityDeposit || 0;
    const secStatus = b.securityStatus || "held";
    // Looked up once: the buttons and the missing-contact note below all need it.
    const cust = customerForBooking(b);
    const hasEmail = !!(b.email || cust?.email);
    const hasPhone = !!(b.phone || cust?.phone);
    return `
    <div class="item-card ${b.paid ? "completed" : "upcoming"}" data-invoice="${b.id}">
      <div class="card-top">
        <div>
          <div class="card-title">${esc(b.renter)} — ${formatAmount(b.paid ? total : balance)}${b.paid ? "" : " owed"}</div>
          <div class="card-sub">${esc(bookingCarLabel(b))} · <span class="ref">${esc(bookingRef(b))}</span></div>
        </div>
        <span class="badge ${BADGE[categoryOf(b)].cls}">${BADGE[categoryOf(b)].text}</span>
      </div>
      ${invoiceDetailsHtml(b)}
      <div class="card-actions">
        ${b.paid
          ? (hasLedger(b)
              ? `<button class="btn" data-act="pay" data-id="${b.id}">Payments</button>`
              : `<button class="btn" data-act="markunpaid" data-id="${b.id}">Mark as unpaid</button>`)
          : `<button class="btn" data-act="pay" data-id="${b.id}">Record payment</button>`}
        <button class="btn" data-act="deposits" data-id="${b.id}">Deposits</button>
        <button class="btn" data-act="open" data-id="${b.id}">View booking</button>
        ${!b.paid && hasEmail ? `<button class="btn" data-act="email" data-id="${b.id}">Email reminder</button>` : ""}
        ${!b.paid && hasPhone ? `<button class="btn" data-act="whatsapp" data-id="${b.id}">WhatsApp reminder</button>` : ""}
        ${sec > 0 && secStatus === "held" ? `
          <button class="btn" data-act="refund" data-id="${b.id}">Refund deposit</button>
          <button class="btn" data-act="keep" data-id="${b.id}">Keep deposit</button>` : ""}
      </div>
    </div>`;
  }).join("");
}

// ---------- The details block ----------
// Everything a card says about the money on one booking, as HTML. Exported so
// the Invoices tab on Reports opens the very same block under a row — one
// function, so the two pages can never describe the same booking differently
// (25 Aug: Billing is on its way out; Invoices has to carry all of it).
export function invoiceDetailsHtml(b) {
  const days = rentalDays(b);
  const rate = rateFor(b);
  const total = rentalTotal(b);
  const adv = advancePaid(b);
  const balance = balanceFor(b);
  const sec = b.securityDeposit || 0;
  const secStatus = b.securityStatus || "held";
  const cust = customerForBooking(b);
  const hasEmail = !!(b.email || cust?.email);
  const hasPhone = !!(b.phone || cust?.phone);
  const log = Array.isArray(b.paidLog) && b.paidLog.length ? b.paidLog[b.paidLog.length - 1] : null;
  return `
      <div class="card-details">
        <span>Period: <strong>${formatDate(b.startDate)} – ${formatDate(b.endDate)}</strong></span>
        ${b.broker ? `<span>Broker: <strong>${esc(b.broker)}</strong></span>` : ""}
        ${hasManualTotal(b)
          ? `<span>Agreed price: <strong>${fxPair(b, total, b.fxTotal)}</strong> <span style="opacity:0.7;">(${days} day${days === 1 ? "" : "s"})</span></span>`
          : `<span>${days} day${days === 1 ? "" : "s"} × <strong>${formatAmount(rate)}</strong>/day = <strong>${formatAmount(total)}</strong></span>`}
        ${deliveryCost(b) > 0 ? `<span>Delivery: <strong>${formatAmount(deliveryCost(b))}</strong></span>` : ""}
        ${insuranceCost(b) > 0 ? `<span>Insurance: <strong>${formatAmount(insuranceCost(b))}</strong></span>` : ""}
        ${otherCost(b) > 0 ? `<span>Other: <strong>${formatAmount(otherCost(b))}</strong></span>` : ""}
        ${extrasTotal(b) > 0 ? `<span>Invoice total: <strong>${formatAmount(invoiceTotal(b))}</strong></span>` : ""}
        ${bankCharge(b) > 0 ? `<span>Bank charge ${bankChargePct(b)}%: <strong>+${formatAmount(bankCharge(b))}</strong> <span style="opacity:0.7;">(card payment)</span></span>` : ""}
        ${bankCharge(b) > 0 ? `<span>Total due: <strong>${formatAmount(amountDue(b))}</strong></span>` : ""}
        ${hasLedger(b)
          ? `<span>Received so far: <strong>${formatAmount(paidTotal(b))}</strong> <span style="opacity:0.7;">(${paymentsOf(b).length} payment${paymentsOf(b).length === 1 ? "" : "s"})</span></span>`
          : adv > 0 ? `<span>Part payment: <strong>-${fxPair(b, adv, b.fxAdvance)}</strong></span>` : ""}
        ${(hasLedger(b) ? paidTotal(b) > 0 : adv > 0) && !b.paid ? `<span>Balance: <strong>${formatAmount(balance)}</strong></span>` : ""}
        ${b.paid && b.paidAt ? `<span>Paid on: <strong>${formatDate(b.paidAt.slice(0, 10))}</strong></span>` : ""}
        ${log ? `<span style="color:var(--muted);">Last change: ${esc(log.action)} ${formatDate(String(log.at).slice(0, 10))}${log.by ? ` by ${esc(log.by)}` : ""}</span>` : ""}
        ${b.paid && settledAmount(b) !== amountDue(b) ? `<span>Counted as received: <strong>${formatAmount(settledAmount(b))}</strong> <span style="opacity:0.7;">(the advance came in earlier)</span></span>` : ""}
        ${(rate === 0 && !hasManualTotal(b)) ? `<span style="color:var(--red-text);">No daily rate set on this car — edit the car in Fleet, or enter a total on the booking</span>` : ""}
      </div>
      ${sec > 0 ? `
      <div class="card-details" style="margin-top:6px;">
        <span>Security deposit: <strong>${fxPair(b, sec, b.fxSecurity)}</strong></span>
        <span>Status: <strong>${secStatus === "held" ? "Held (refundable)" : secStatus === "refunded" ? "Refunded" : "Kept"}</strong></span>
      </div>` : ""}
      ${!b.paid && !hasPhone && !hasEmail ? `
      <div class="card-details" style="border-top:none;padding-top:0;margin-top:6px;">
        <span style="color:var(--muted);">No phone or email saved — open the booking and add one, then a reminder can be sent</span>
      </div>` : ""}`;
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

// The broker list comes from Settings — the same one the booking form offers —
// so a chosen filter can never quietly point at a name nobody uses any more.
// Rebuilt whenever the underlying names change, same pattern as the years above.
function refreshBrokerOptions() {
  const sel = el(root, "period-broker");
  if (!sel) return;
  const names = brokerNames();
  const signature = names.join("|");
  if (sel.dataset.built === signature) return;

  sel.innerHTML = `<option value="">All brokers</option>` +
    names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
  sel.dataset.built = signature;
  // A broker removed from Settings after being chosen falls back to "all"
  // rather than silently filtering on a name that no longer appears anywhere.
  // Matched loosely, the way names are matched everywhere else in the app.
  const keep = names.find(n => n.toLowerCase() === periodBroker.toLowerCase());
  sel.value = keep || "";
  periodBroker = sel.value;
}

// The three conditions are checked separately, which is what lets any one of
// them work on its own. Folding the month into the year used to mean picking
// "October" alone filtered nothing at all — the broker filter follows the
// same rule so it never depends on a date filter also being set.
// Split in two so the summary can ask the date question about a date other
// than the rental's start. Money is received on the day it arrives, which may
// be a different month from the one the rental starts in, and the summary has
// to file it under the month it actually landed.
function inChosenDates(d) {
  d = d || "";
  if (periodYear && d.slice(0, 4) !== periodYear) return false;
  if (periodMonth && d.slice(5, 7) !== periodMonth) return false;
  return true;
}

function matchesBroker(b) {
  // Loose match: "popo" typed on a booking still counts for "Popo" in
  // Settings, the same way the suggestion lists treat spellings.
  if (!periodBroker) return true;
  return (b.broker || "").trim().toLowerCase() === periodBroker.trim().toLowerCase();
}

function inChosenPeriod(b) {
  return inChosenDates(b.startDate) && matchesBroker(b);
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
    // The cards are filed by when their rental started; this second figure
    // says how much of that money actually arrived inside the chosen period,
    // which is the number that reconciles against a bank statement. With no
    // period chosen the two are equal and the clause does not appear.
    const received = sum(list, settledAmount);
    const inScope = sum(list.filter(b => inChosenDates(settledOn(b))), settledAmount);
    money = `${formatAmount(received)} received in total` +
      (inScope !== received ? ` · ${formatAmount(inScope)} of it in ${periodLabel()}` : "");
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
  // The broker filter is part of that scope for the same reason.
  const bits = [];
  if (periodYear || periodMonth) bits.push(periodLabel());
  if (periodBroker) bits.push(`broker: ${periodBroker}`);
  const scope = bits.length ? ` · ${bits.join(" · ")}` : "";
  el(root, "list-total").textContent = `${count}${scope} · ${money}`;

  if (revealInvoiceId) {
    const id = revealInvoiceId;
    revealInvoiceId = null;
    setTimeout(() => {
      const card = el(root, "list").querySelector(`[data-invoice="${id}"]`);
      if (!card) return;
      card.scrollIntoView({ block: "center", behavior: "smooth" });
      card.classList.add("card-flash");
      setTimeout(() => card.classList.remove("card-flash"), 1600);
    }, 0);
  }
}

// The count on each tab is what clicking it will show, search included.
function renderTabCounts(search) {
  const labels = { unpaid: "Unpaid", paid: "Paid", upcoming: "Not started", all: "All" };
  el(root, "filters").querySelectorAll(".tab").forEach(tab => {
    const f = tab.dataset.f;
    tab.textContent = `${labels[f] || f} (${invoicesFor(f, search).length})`;
  });
}

// ---------- Payment history ----------
let payBookingId = null;

export function openPayModal(id) {
  payBookingId = id;
  const b = state.bookings.find(x => x.id === id);
  if (!b) return;
  showError(dlg, "pay-error", null);
  el(dlg, "pay-title").textContent = `Payments \u2014 ${b.renter || bookingRef(b)}`;

  const pays = paymentsOf(b);
  const due = amountDue(b);
  const got = paidTotal(b);
  const rows = pays.map(p => `
    <div class="pay-row">
      <span>${esc(formatDate(paymentOn(p)))}</span>
      <span>${p.method ? esc(p.method) : "\u2014"}</span>
      <span class="pay-amt${(Number(p.amount) || 0) < 0 ? " pay-neg" : ""}">${esc(formatAmount(Number(p.amount) || 0))}</span>
    </div>${p.note ? `<div class="pay-note">${esc(p.note)}</div>` : ""}`).join("");
  el(dlg, "pay-list").innerHTML = `
    ${pays.length ? rows : (Number(b.advancePaid) || 0) > 0
      ? `<div class="pay-note">The advance of ${esc(formatAmount(Number(b.advancePaid)))} will appear here as the opening entry when the first payment is recorded.</div>`
      : `<div class="pay-note">Nothing received yet.</div>`}
    <div class="pay-row pay-sum">
      <span>Received so far</span><span></span><span class="pay-amt">${esc(formatAmount(got))}</span>
    </div>
    <div class="pay-row pay-sum">
      <span>${b.paid ? "Settled" : "Remaining"}</span><span></span>
      <span class="pay-amt">${esc(formatAmount(Math.max(0, due - got)))}</span>
    </div>`;

  setVal(dlg, "pay-amount", b.paid ? "" : (balanceFor(b) || ""));
  setVal(dlg, "pay-method", "");
  setVal(dlg, "pay-date", todayStr());
  setVal(dlg, "pay-note", "");
  openModal(dlg, "pay-modal");
}

async function savePayment() {
  const id = payBookingId;
  const b = state.bookings.find(x => x.id === id);
  if (!b) return;
  const amount = parseFloat(val(dlg, "pay-amount"));
  const method = val(dlg, "pay-method");
  const on = val(dlg, "pay-date") || todayStr();
  const note = val(dlg, "pay-note");

  if (!Number.isFinite(amount) || amount === 0) {
    showError(dlg, "pay-error", "Enter the amount received — a negative amount records a refund.");
    return;
  }

  const btn = el(dlg, "pay-save");
  btn.disabled = true;
  setSync("saving");
  try {
    const now = new Date().toISOString();
    const by = state.ctx?.user?.email || "";
    const entries = [];
    // First payment on a booking that already carried an advance: the advance
    // migrates in as the opening entry, dated the day it was recorded, so the
    // ledger is the whole story from its first day and nothing double-counts.
    if (!hasLedger(b) && (Number(b.advancePaid) || 0) > 0) {
      entries.push({
        on: advanceReceivedOn(b), at: now, amount: Number(b.advancePaid),
        method: "", by: "", note: "Advance recorded before payment history existed"
      });
    }
    entries.push({ on, at: now, amount, method, by, note });

    const before = hasLedger(b) ? paidTotal(b) : (Number(b.advancePaid) || 0);
    const after = Math.round((before + amount) * 100) / 100;
    const settledNow = after >= amountDue(b) - 0.005;

    const patch = { payments: arrayUnion(...entries) };
    if (settledNow !== !!b.paid) {
      patch.paid = settledNow;
      patch.paidAt = settledNow ? now : null;
      patch.paidLog = arrayUnion({
        at: now, by,
        action: settledNow ? "settled by payment" : "reopened by correction"
      });
    }
    await updateDoc(doc(db, "bookings", id), patch);
    setSync("live");
    closeModal(dlg, "pay-modal");
    showToast(settledNow && !b.paid
      ? `Payment recorded \u2014 booking settled in full`
      : `Payment recorded`);
  } catch (err) {
    setSync("error");
    showError(dlg, "pay-error", "Couldn't save the payment (" + (err.code || err.message) + "). Try again.");
  }
  btn.disabled = false;
}

export function openDepositModal(id) {
  depositBookingId = id;
  const b = state.bookings.find(x => x.id === id);
  setVal(dlg, "dep-advance", b?.advancePaid || "");
  // Once a booking has a payment history, the advance lives there: this field
  // becomes a display, and Record payment is the only door money comes in by.
  const ledgered = b && hasLedger(b);
  const advIn = el(dlg, "dep-advance");
  advIn.disabled = !!ledgered;
  if (ledgered) setVal(dlg, "dep-advance", "");
  const advLabel = el(dlg, "dep-advance-label");
  if (ledgered) advLabel.textContent = "Advance is in the payment history — use Record payment";
  setVal(dlg, "dep-security", b?.securityDeposit || "");

  // Foreign-currency bookings take deposits in that currency too: the foreign
  // amounts lead, and the Rs fields underneath become the agreed conversion —
  // the figure the books actually record.
  const sym = b?.fxCurrency || "";
  const home = state.settings?.currency || "Rs";
  el(dlg, "dep-fx-row").style.display = sym ? "flex" : "none";
  if (sym) {
    const rate = fxRate(sym);
    const rateNote = rate ? ` (house rate ${rate})` : "";
    el(dlg, "dep-fxadvance-label").textContent = `Part payment in ${sym}${rateNote}`;
    el(dlg, "dep-fxsecurity-label").textContent = `Security in ${sym}${rateNote}`;
    el(dlg, "dep-advance-label").textContent = `= Part payment in ${home} (reduces balance owed)`;
    el(dlg, "dep-security-label").textContent = `= Security in ${home} (refundable, held separately)`;
    setVal(dlg, "dep-fxadvance", b?.fxAdvance ?? "");
    setVal(dlg, "dep-fxsecurity", b?.fxSecurity ?? "");
    // Named with the actual rate, same as the booking form's button, and
    // hidden entirely when Settings has no rate for this currency.
    const advBtn = el(dlg, "dep-fx-recalc-advance");
    const secBtn = el(dlg, "dep-fx-recalc-security");
    if (advBtn) {
      advBtn.style.display = rate ? "inline-block" : "none";
      if (rate) advBtn.textContent = `Use today's rate (${rate})`;
    }
    if (secBtn) {
      secBtn.style.display = rate ? "inline-block" : "none";
      if (rate) secBtn.textContent = advBtn ? advBtn.textContent : `Use today's rate (${rate})`;
    }
  } else {
    el(dlg, "dep-advance-label").textContent = "Part payment / advance (reduces balance owed)";
    el(dlg, "dep-security-label").textContent = "Security deposit (refundable, held separately)";
    const ra = el(dlg, "dep-fx-recalc-advance"); if (ra) ra.style.display = "none";
    const rs2 = el(dlg, "dep-fx-recalc-security"); if (rs2) rs2.style.display = "none";
  }
  showError(dlg, "deposit-error", null);
  openModal(dlg, "deposit-modal");
}

async function saveDeposits() {
  if (!depositBookingId) return;
  showError(dlg, "deposit-error", null);

  const advance = parseFloat(val(dlg, "dep-advance")) || 0;
  const security = parseFloat(val(dlg, "dep-security")) || 0;
  if (advance < 0 || security < 0) {
    showError(dlg, "deposit-error", "Amounts can't be negative."); return;
  }

  const b = state.bookings.find(x => x.id === depositBookingId);

  // An advance larger than the whole invoice clamps the balance to zero and
  // the overpayment becomes invisible — usually it is a typo (an extra digit,
  // or the security deposit typed into the wrong box). Named and confirmed
  // rather than refused, because a genuine overpayment does happen.
  const due = amountDue(b);
  if (advance > due && !confirm(
    `The advance (${formatAmount(advance)}) is more than the whole amount due on this booking (${formatAmount(due)}).\n\n` +
    `Check it is not a typo — or the security deposit in the wrong box.\n\nSave it anyway?`)) return;

  // Foreign amounts need their Rs twin: a €100 advance with no Rs value gives
  // the books nothing to record.
  const sym = b?.fxCurrency || "";
  const fxAdvance = sym ? (parseFloat(val(dlg, "dep-fxadvance")) || 0) : 0;
  const fxSecurity = sym ? (parseFloat(val(dlg, "dep-fxsecurity")) || 0) : 0;
  if (fxAdvance > 0 && advance <= 0) {
    showError(dlg, "deposit-error", `Enter the agreed value of the ${sym} advance in the field below it.`); return;
  }
  if (fxSecurity > 0 && security <= 0) {
    showError(dlg, "deposit-error", `Enter the agreed value of the ${sym} security deposit in the field below it.`); return;
  }

  const btn = el(dlg, "save-deposit");
  btn.disabled = true; btn.textContent = "Saving...";
  setSync("saving");
  try {
    // A booking with a payment history takes money only through Record
    // payment; the deposits dialog then only manages the security deposit.
    const ledgered = hasLedger(b);
    const update = ledgered
      ? { securityDeposit: security, fxSecurity: fxSecurity > 0 ? fxSecurity : null }
      : { advancePaid: advance, securityDeposit: security,
          fxAdvance: fxAdvance > 0 ? fxAdvance : null,
          fxSecurity: fxSecurity > 0 ? fxSecurity : null };
    // The day the advance arrived, stamped when the figure changes — this is
    // what lets Received count deposits in the month the money actually came.
    if (!ledgered && advance !== (Number(b.advancePaid) || 0)) {
      update.advanceRecordedAt = new Date().toISOString();
    }
    if (security > 0 && !b.securityStatus) update.securityStatus = "held";
    if (security === 0) update.securityStatus = null;
    await updateDoc(doc(db, "bookings", depositBookingId), update);
    closeModal(dlg, "deposit-modal");
    depositBookingId = null;
  } catch (e) {
    showError(dlg, "deposit-error", "Couldn't save (" + (e.code || e.message) + "). Try again.");
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

export function contactByEmail(b) {
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

// WhatsApp rather than SMS. This market runs on WhatsApp: an SMS costs money,
// is often ignored, and gives the desk no sign of whether it arrived, while the
// confirmation the customer already has came to them on WhatsApp — a reminder
// on the same thread reads as the same conversation rather than a cold text.
// The number is normalised by the same helper the confirmation uses, so both
// messages can only ever reach the same chat.
export function contactByWhatsApp(b) {
  const c = customerForBooking(b);
  const raw = b.phone || c?.phone || "";
  const short =
    `Reminder from ${companyName() || "us"}: ${formatAmount(balanceFor(b))} outstanding for your rental ` +
    `(${formatDate(b.startDate)} - ${formatDate(b.endDate)}). Please contact us to arrange payment. Thank you.`;
  if (!openWhatsApp(raw, short)) {
    alert("No phone number saved for this customer. Add one on the booking or on the Customers page.");
  }
}
