// Booking form — the add/edit dialog for a booking.
//
// This lives outside any single view because more than one screen shows a
// planner, and each of them needs to open the same form. It owns its own root
// element (#booking-form-root) so the shared el()/val() helpers keep working.

import { db, setSync } from "./firebase-init.js";
import { openAgreement, openConfirmation, openReceipt, openInvoice, emailBooking, whatsappBooking, CAR_OUTLINE } from "./agreement.js";
import { collection, addDoc, updateDoc, deleteDoc, doc, arrayUnion, runTransaction } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  state, esc, formatDate, todayStr, findClash, describeInterval,
  makeBookingRef, bookingRef, showToast,
  staffNames, locationNames, brokerNames, FX_CURRENCIES, fxRate, deleteBookingWarning,
  rentalDays, formatAmount, defaultBankChargePct,
  receiptPrefix, formatReceiptNo, receiptNo, hasReceiptNo, receiptNoTaken,
  invoiceKindFor, vatRatePct, formatInvoiceNo, invoiceNo, hasInvoiceNo, amountDue,
  paidTotal,
  invoiceNoTaken, invoiceSeqField,
  startTime, endTime,
  fillTimeOptions, getTime, setTime, onTimeChange,
  getSwatch, setSwatch,
  el, val, setVal, checked, setChecked, openModal, closeModal, showError,
  modalTouched,
  requestFocus
} from "./store.js";

let root = null;
let editingBookingId = null;
let contactCustomerId = null;   // whose details the inline editor is editing

// Views can ask to be told when a booking is saved or deleted
const listeners = new Set();
export function onBookingChange(fn) { listeners.add(fn); }
function announce() { listeners.forEach(fn => fn()); }

export function mountBookingForm() {
  root = document.getElementById("booking-form-root");
  if (!root) return;

  fillTimeOptions(root, "b-start-time");
  fillTimeOptions(root, "b-end-time");

  el(root, "save-booking").addEventListener("click", saveBooking);
  el(root, "delete-booking").addEventListener("click", deleteEditingBooking);
  el(root, "print-agreement").addEventListener("click", () => {
    if (!editingBookingId) return;
    const r = openAgreement(editingBookingId);
    if (!r.ok) showError(root, "booking-error", r.reason);
  });
  wireDamageAndSignature();
  const rcptBtn = el(root, "print-receipt");
  if (rcptBtn) rcptBtn.addEventListener("click", onReceiptClicked);
  const rcptGo = el(root, "receipt-go");
  if (rcptGo) rcptGo.addEventListener("click", issueReceipt);
  const invBtn = el(root, "print-invoice");
  if (invBtn) invBtn.addEventListener("click", onInvoiceClicked);
  const invGo = el(root, "invoice-go");
  if (invGo) invGo.addEventListener("click", issueInvoice);
  const confBtn = el(root, "print-confirmation");
  if (confBtn) confBtn.addEventListener("click", () => {
    if (!editingBookingId) return;
    const r = openConfirmation(editingBookingId);
    if (!r.ok) showError(root, "booking-error", r.reason);
  });
  el(root, "email-booking").addEventListener("click", () => {
    if (!editingBookingId) return;
    const r = emailBooking(editingBookingId);
    if (!r.ok) showError(root, "booking-error", r.reason);
  });
  el(root, "whatsapp-booking").addEventListener("click", () => {
    if (!editingBookingId) return;
    const r = whatsappBooking(editingBookingId);
    if (!r.ok) showError(root, "booking-error", r.reason);
  });
  el(root, "b-customer").addEventListener("change", toggleNewCustomer);
  el(root, "b-currency").addEventListener("change", syncCurrencyFields);
  // The reverse of Billing's "View booking": from the booking straight to its
  // invoice. Only for saved bookings — a form not yet saved has no invoice.
  const viewInvoice = el(root, "b-view-invoice");
  if (viewInvoice) viewInvoice.addEventListener("click", () => {
    if (!editingBookingId) return;
    requestFocus("billing", editingBookingId);
    closeModal(root, "booking-modal");
    location.hash = "#billing";
  });
  ["b-delivery", "b-insurance", "b-other", "b-total"].forEach(name =>
    el(root, name).addEventListener("input", () => { syncExtrasHint(); syncCardCharge(); syncMoneyBlock(); }));
  // Guarded like the other later additions: an older cached page has no
  // card box, and reaching for it unguarded would break the whole form.
  const cardBox = el(root, "b-card");
  if (cardBox) cardBox.addEventListener("change", () => {
    // Ticking it for the first time fills the company rate, so nobody has to
    // remember what it is. An empty field after that is a deliberate blank.
    if (cardBox.checked && val(root, "b-card-pct") === "") {
      const d = defaultBankChargePct();
      if (d) setVal(root, "b-card-pct", d);
    }
    syncCardCharge();
    syncMoneyBlock();
  });
  const cardPct = el(root, "b-card-pct");
  if (cardPct) cardPct.addEventListener("input", syncCardCharge);
  if (cardPct) cardPct.addEventListener("input", syncMoneyBlock);
  ["b-start", "b-end", "b-car"].forEach(n => {
    const f = el(root, n);
    if (f) f.addEventListener("change", () => { syncCardCharge(); syncMoneyBlock(); });
  });
  // Guarded: if the page the browser cached is older than this script, the
  // button is not there yet — the feature waits for the fresh page instead of
  // crashing the whole app at startup.
  const recalcBtn = el(root, "b-fx-recalc");
  if (recalcBtn) recalcBtn.addEventListener("click", () => {
    const sym = el(root, "b-currency").value;
    if (!sym) return;
    recalcAtTodayRate(root, {
      fxInputId: "b-fxtotal", homeInputId: "b-total", sym,
      isPaid: !!editingBookingId && !!state.bookings.find(x => x.id === editingBookingId)?.paid
    });
  });
  // The foreign amount leads: typing it fills the Rs figure from the house
  // rate set in Settings. The Rs field stays editable for a negotiated
  // exception — but re-typing the foreign amount recalculates, since the
  // foreign figure is the one driving.
  el(root, "b-fxtotal").addEventListener("input", () => {
    const sym = el(root, "b-currency").value;
    const rate = sym ? fxRate(sym) : null;
    const amount = parseFloat(val(root, "b-fxtotal"));
    if (rate && Number.isFinite(amount) && amount >= 0) {
      setVal(root, "b-total", Math.round(amount * rate));
    }
    // setVal fires no input event, so the hints that watch b-total never heard
    // about the change and kept showing the old figures until some other field
    // was touched. Refresh them here directly.
    syncExtrasHint();
    syncCardCharge();
    syncMoneyBlock();
  });

  el(root, "b-contact-toggle").addEventListener("click", () => {
    const box = el(root, "b-contact-edit");
    box.style.display = box.style.display === "none" ? "flex" : "none";
    if (box.style.display === "flex") el(root, "b-cust-phone").focus();
  });
  el(root, "b-cust-save").addEventListener("click", saveCustomerContact);
  el(root, "b-contact-full").addEventListener("click", () => {
    if (!contactCustomerId) return;
    // Everything else about a customer — licence, notes — lives on their own
    // page, so this hands over rather than rebuilding that form in here.
    requestFocus("customers", contactCustomerId);
    closeModal(root, "booking-modal");
    location.hash = "#customers";
  });

  [["b-start", "b-end"]].flat().forEach(n =>
    el(root, n).addEventListener("change", keepReturnAfterPickup));
  onTimeChange(root, "b-start-time", keepReturnAfterPickup);
  onTimeChange(root, "b-end-time", keepReturnAfterPickup);
  // A time change can add or remove a chargeable day (rentalDays counts real
  // hours), so the card-charge arithmetic has to follow the times as well as
  // the dates it already followed.
  onTimeChange(root, "b-start-time", syncCardCharge);
  onTimeChange(root, "b-end-time", syncCardCharge);

  el(root, "b-colour").addEventListener("click", (e) => {
    // The + is a label wrapping a real colour input: the click activates the
    // native picker by itself. preventDefault here would kill exactly that,
    // and a programmatic pick.click() is what browsers quietly refuse on a
    // zero-size input — the original sin of this feature.
    if (e.target.closest(".swatch-add")) return;
    const sw = e.target.closest(".swatch");
    if (!sw) return;
    e.preventDefault();
    setSwatch(root, "b-colour", sw.dataset.colour);
  });
  // The palette row is rebuilt on every paint, so the picker's change event
  // is caught here on the row, which survives every rebuild.
  el(root, "b-colour").addEventListener("change", async (e) => {
    const pick = e.target.closest(".swatch-pick");
    if (!pick) return;
    const hex = String(pick.value || "").toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(hex)) return;
    paintColourSwatches(hex);
    setSwatch(root, "b-colour", hex);
    // Company-wide, written immediately: the palette belongs to everyone.
    try {
      await updateDoc(doc(db, "settings", state.ctx.companyId),
        { companyId: state.ctx.companyId, plannerColours: arrayUnion(hex) });
    } catch (err) {
      console.warn("Could not save the colour to the palette", err);
    }
  });

  root.querySelectorAll("[data-close]").forEach(b =>
    b.addEventListener("click", () => closeModal(root, b.dataset.close)));
  // Clicking the dark surround closes a dialog. That is the usual way out of
  // one and, on a form this long, the usual way to lose a quarter of an hour
  // of typing to a stray click beside it. A dialog nobody has typed in still
  // closes on the first click, so the gesture keeps working where there is
  // nothing to lose; one that has been filled in asks first.
  root.querySelectorAll(".overlay").forEach(o =>
    o.addEventListener("click", e => {
      if (e.target !== o) return;
      if (modalTouched(o) &&
          !confirm("This form has not been saved. Close it and lose what you have entered?")) return;
      o.classList.remove("open");
    }));
}

function keepReturnAfterPickup() {
  const sd = val(root, "b-start"), st = getTime(root, "b-start-time");
  let ed = val(root, "b-end"), et = getTime(root, "b-end-time");
  if (sd && st && ed) {
    // Return date before pick-up: pull it up to the pick-up day
    if (ed < sd) { setVal(root, "b-end", sd); ed = sd; }

    // Same day but the return time is not after the pick-up: push it later
    if (ed === sd && et && et <= st) {
      const [h, m] = st.split(":").map(Number);
      const later = h + 2 <= 23 ? `${String(h + 2).padStart(2, "0")}:${String(m).padStart(2, "0")}` : "23:59";
      setTime(root, "b-end-time", later);
    }
  }
  // Times change the day count as surely as dates do, and this function also
  // moves dates and times itself — programmatically, firing no events. Ending
  // with the recalculation means the card-charge line can never show a figure
  // built on a day count that just changed.
  syncCardCharge();
  syncMoneyBlock();
}

function toggleNewCustomer() {
  const v = el(root, "b-customer").value;
  el(root, "b-new-fields").style.display = v === "__new__" ? "block" : "none";
  el(root, "b-quick-fields").style.display = v === "__quick__" ? "block" : "none";
  showSavedContact(v);
}

// For a saved customer the details belong to their record rather than to this
// booking, so they are shown rather than offered for editing — two editable
// copies of one phone number is how a customer ends up with two of them. A
// missing number is called out here, before someone presses WhatsApp and finds
// out the hard way.
function showSavedContact(choice) {
  const box = el(root, "b-contact-box");
  if (!box) return;

  const c = (choice && choice !== "__new__" && choice !== "__quick__")
    ? state.customers.find(x => x.id === choice)
    : null;

  contactCustomerId = c ? c.id : null;
  if (!c) { box.style.display = "none"; return; }

  const bits = [];
  if (c.phone) bits.push(`Phone ${c.phone}`);
  if (c.email) bits.push(c.email);

  box.style.display = "block";
  const note = el(root, "b-contact-note");
  note.classList.toggle("warn", !c.phone);
  note.textContent = bits.length
    ? `${bits.join(" · ")} — from ${c.name}'s record`
    : `No phone or email saved for ${c.name} — a confirmation cannot be sent`;

  el(root, "b-contact-toggle").textContent = bits.length
    ? "Change phone or email" : "+ Add phone or email";

  // Closed each time the form opens, so it never appears mid-edit from a
  // previous booking.
  el(root, "b-contact-edit").style.display = "none";
  setVal(root, "b-cust-phone", c.phone || "");
  setVal(root, "b-cust-email", c.email || "");
}

// Saved straight to the customer, not held until the booking is saved: it is a
// different record, and pressing Cancel on a booking should not throw away a
// phone number somebody deliberately went and found.
async function saveCustomerContact() {
  if (!contactCustomerId) return;
  const btn = el(root, "b-cust-save");
  btn.disabled = true; btn.textContent = "Saving...";
  setSync("saving");
  try {
    await updateDoc(doc(db, "customers", contactCustomerId), {
      phone: val(root, "b-cust-phone"),
      email: val(root, "b-cust-email")
    });
    showToast("Saved to the customer record");
    // state.customers has already been updated by the listener, so this redraws
    // the line with the new details rather than the old ones.
    showSavedContact(el(root, "b-customer").value);
  } catch (e) {
    showError(root, "booking-error", "Couldn't save the contact details (" + (e.code || e.message) + ").");
    setSync("error");
  }
  btn.disabled = false; btn.textContent = "Save to customer";
}

// Refilled each time the form opens rather than once at startup, so a location
// typed into yesterday's booking is offered on today's.
function fillSuggestions() {
  const put = (id, values) => {
    const dl = document.getElementById(id);
    if (!dl) return;
    dl.innerHTML = values
      .map(v => `<option value="${esc(v)}"></option>`).join("");
  };
  put("dl-locations", locationNames());
  put("dl-staff", staffNames());
  put("dl-brokers", brokerNames());
}

// The rate this booking actually lives on: the ratio its agreed total pair
// implies, falling back to the house rate. One booking, one rate — a later
// Settings change can never silently move this booking's extras.
function bookingRate(sym, fxTotal, homeTotal) {
  if (fxTotal > 0 && homeTotal > 0) return homeTotal / fxTotal;
  return sym ? fxRate(sym) : null;
}

// ---------- Booking currency ----------
// The foreign amount leads and the Rs figure follows: the desk types both,
// which records the exchange the two sides actually agreed. The Rs figure is
// what every total and report uses; the foreign one rides along for display.
function fillCurrencyOptions() {
  const sel = el(root, "b-currency");
  const home = state.settings?.currency || "Rs";
  sel.innerHTML = `<option value="">${esc(home)} — company currency</option>` +
    FX_CURRENCIES.filter(c => c.sym !== home)
      .map(c => `<option value="${esc(c.sym)}">${esc(c.sym)} — ${esc(c.label)}</option>`).join("");
}

function syncCurrencyFields() {
  const sym = el(root, "b-currency").value;
  const home = state.settings?.currency || "Rs";
  el(root, "b-fx-field").style.display = sym ? "block" : "none";
  el(root, "b-fxtotal-label").textContent = `Total in ${sym || "—"}`;
  el(root, "b-total-label").textContent = sym
    ? `= Total in ${home} (the agreed conversion — this is what the books record)`
    : "Total price (leave blank to calculate from daily rate)";
  const hint = el(root, "b-fx-hint");
  if (hint) {
    const rate = sym ? fxRate(sym) : null;
    // No hint when a rate exists — the "Use today's rate (55)" button already
    // says everything the old sentence said. The warning stays for the one
    // case that genuinely needs words: no rate set, nothing will auto-fill.
    hint.textContent = sym && !rate
      ? `No house rate set for ${sym} in Settings — type the ${home} value yourself`
      : "";
  }

  // The button that recalculates just this one booking at today's rate — it
  // never touches Settings or any other booking. Named with the actual rate
  // so pressing it is never a surprise; hidden entirely when there is no rate
  // to use, since there is nothing for it to do.
  const btn = el(root, "b-fx-recalc");
  if (btn) {
    const rate = sym ? fxRate(sym) : null;
    btn.style.display = rate ? "inline-block" : "none";
    if (rate) btn.textContent = `Use today's rate (${rate})`;
  }

  // With a currency and a usable rate, the extras are typed in that currency
  // too; the hint under the row shows the Rs figures the books will record.
  syncExtrasHint();
}

function extrasInFx() {
  const sym = el(root, "b-currency").value;
  if (!sym) return null;
  const rate = bookingRate(sym,
    parseFloat(val(root, "b-fxtotal")) || 0,
    parseFloat(val(root, "b-total")) || 0);
  return rate ? { sym, rate } : null;
}

// The money the form currently implies: total (with the card charge when
// ticked, same rounding the books use), the advance already received on an
// existing booking, and what remains to collect at pickup. Reuses
// cardChargeBase() so this figure and the saved figure can never disagree.
function syncMoneyBlock() {
  const box = el(root, "b-money-block");
  if (!box) return;
  const base = cardChargeBase();
  const pct = checked(root, "b-card") ? (parseFloat(val(root, "b-card-pct")) || 0) : 0;
  const charge = pct > 0 ? Math.round(base * pct) / 100 : 0;
  const total = Math.round((base + charge) * 100) / 100;
  const b = editingBookingId ? state.bookings.find(x => x.id === editingBookingId) : null;
  const advance = b ? paidTotal(b) : 0;
  const due = Math.max(0, Math.round((total - advance) * 100) / 100);
  box.innerHTML = `
    <div class="money-row"><span>Total${charge > 0 ? " (incl. card charge)" : ""}</span><strong>${esc(formatAmount(total))}</strong></div>
    ${advance > 0 ? `
    <div class="money-row"><span>Received so far</span><strong>${esc(formatAmount(advance))}</strong></div>
    <div class="money-row ${due > 0 ? "money-due" : "money-settled"}"><span>Due at pickup</span><strong>${esc(formatAmount(due))}</strong></div>` : ""}
  `;
}

function syncExtrasHint() {
  const home = state.settings?.currency || "Rs";
  const fx = extrasInFx();
  const sym = el(root, "b-currency").value;
  ["delivery", "insurance", "other"].forEach(name => {
    const label = el(root, `b-${name}-label`);
    if (label) {
      const base = name === "other" ? "Other costs" : `${name[0].toUpperCase()}${name.slice(1)} cost`;
      label.textContent = fx ? `${base} in ${fx.sym}` : base;
    }
  });
  const hint = el(root, "b-extras-hint");
  if (!hint) return;
  if (!fx) {
    hint.textContent = sym
      ? `No rate available for ${sym} yet — enter the extras in ${home}.`
      : "";
    return;
  }
  const parts = ["delivery", "insurance", "other"].map(name => {
    const amount = parseFloat(val(root, `b-${name}`)) || 0;
    return amount > 0 ? `${home} ${Math.round(amount * fx.rate).toLocaleString("en-US")}` : null;
  }).filter(Boolean);
  hint.textContent = parts.length
    ? `Recorded in the books as: ${parts.join(" · ")} (at ${Math.round(fx.rate * 100) / 100}/${fx.sym})`
    : `Typed in ${fx.sym}; the ${home} equivalent records automatically.`;
}

// ---------- Receipt numbers ----------
// The MRA wants a serial number on a receipt, which means consecutive. The
// booking reference cannot do that job — it is scrambled on purpose — so the
// receipt gets its own number, allocated once and then fixed on the booking.
//
// Allocation runs as a Firestore transaction against the company's settings
// document, which is what makes it safe when two people at two desks press
// Receipt in the same second: the second transaction sees the first one's
// write and takes the next number instead of the same one.
//
// That also means it needs the server. The app otherwise works offline by
// design, but a number that might duplicate is worse than no receipt for five
// minutes, so issuing is blocked rather than guessed at.

function receiptYear() { return todayStr().slice(0, 4); }

function onReceiptClicked() {
  if (!editingBookingId) return;
  const b = state.bookings.find(x => x.id === editingBookingId);
  if (!b) return;

  // Already issued: print exactly what the customer was given, no questions.
  if (hasReceiptNo(b)) {
    const r = openReceipt(editingBookingId);
    if (!r.ok) showError(root, "booking-error", r.reason);
    return;
  }

  // Nothing received yet is the same refusal as before, and worth making before
  // a number is burned on a receipt that should not exist.
  if (!b.paid && !(paidTotal(b) > 0)) {
    showError(root, "booking-error",
      "Nothing has been received on this booking yet — record a payment on the Billing page first.");
    return;
  }

  showError(root, "receipt-error", null);
  const year = receiptYear();
  const next = (Number(state.settings?.receiptSeq?.[year]) || 0) + 1;
  setVal(root, "receipt-no", formatReceiptNo(next, year));
  const hint = el(root, "receipt-hint");
  if (hint) {
    hint.textContent =
      `Suggested next number. Change it if you are continuing a numbering you already use — ` +
      `a number already on another receipt will be refused. Once issued it cannot be edited.`;
  }
  openModal(root, "receipt-modal");
  const box = el(root, "receipt-no");
  if (box) setTimeout(() => { box.focus(); box.select(); }, 30);
}

async function issueReceipt() {
  const id = editingBookingId;
  if (!id) return;
  const btn = el(root, "receipt-go");
  const typed = val(root, "receipt-no").trim();

  if (!typed) { showError(root, "receipt-error", "Enter a receipt number, or cancel."); return; }
  if (receiptNoTaken(typed, id)) {
    showError(root, "receipt-error",
      `Receipt ${typed} has already been issued on another booking. Use a different number.`);
    return;
  }
  if (navigator.onLine === false) {
    showError(root, "receipt-error",
      "No connection. A receipt number has to be issued online so two people cannot be given the same one. Reconnect and try again.");
    return;
  }

  showError(root, "receipt-error", null);
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "Issuing...";
  setSync("saving");

  const year = receiptYear();
  const auto = formatReceiptNo((Number(state.settings?.receiptSeq?.[year]) || 0) + 1, year);

  try {
    const settingsRef = doc(db, "settings", state.ctx.companyId);
    const bookingRefDoc = doc(db, "bookings", id);

    const issued = await withTimeout(runTransaction(db, async (tx) => {
      // Both reads happen before any write — Firestore requires that order.
      const snap = await tx.get(settingsRef);
      const bSnap = await tx.get(bookingRefDoc);

      // Someone at another desk may have issued this receipt while this dialog
      // was open. If so, keep their number rather than issuing a second one.
      const already = bSnap.exists() ? String(bSnap.data().receiptNo || "") : "";
      if (already) return already;

      const data = snap.exists() ? snap.data() : {};
      const seqMap = (data.receiptSeq && typeof data.receiptSeq === "object") ? { ...data.receiptSeq } : {};
      const used = Number(seqMap[year]) || 0;
      const prefix = String(data.receiptPrefix || "")
        .toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 8);

      // Taking the suggested number is what advances the counter. A number
      // typed by hand does not: it usually continues a paper book, and moving
      // the counter to match would leave a gap in the app's own run.
      let number = typed;
      if (typed === auto) {
        const next = used + 1;
        seqMap[year] = next;
        number = formatReceiptNo(next, year, prefix);
        tx.set(settingsRef, { companyId: state.ctx.companyId, receiptSeq: seqMap }, { merge: true });
      }

      tx.update(bookingRefDoc, {
        receiptNo: number,
        receiptIssuedAt: new Date().toISOString(),
        receiptIssuedBy: state.ctx?.user?.email || ""
      });
      return number;
    }), 12000);

    closeModal(root, "receipt-modal");
    setSync("live");
    // Not auto-opened — same pop-up-blocker reason as invoices. The button
    // carries the number; pressing it prints.
    const rb = el(root, "print-receipt");
    if (rb) rb.textContent = `Receipt ${issued}`;
    showToast(`Receipt ${issued} issued — press the Receipt button to open it`);
    announce();
  } catch (err) {
    setSync("error");
    const code = err && (err.code || err.message) || "";
    showError(root, "receipt-error",
      /timeout|unavailable|offline|network/i.test(String(code))
        ? "Could not reach the server, so no number was issued. Check the connection and try again."
        : `Could not issue a receipt number (${code}). Nothing was saved — try again.`);
  }
  btn.disabled = false;
  btn.textContent = label;
}

// Firestore retries a transaction rather than failing fast on a poor
// connection, which would leave the button saying "Issuing..." indefinitely.
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))
  ]);
}

// ---------- Bank charge on card payments ----------
// The percentage box appears only when the card box is ticked, and the line
// below spells the arithmetic out in full. The pilot's accountant reads these
// documents, so the figure has to be checkable at a glance rather than a
// percentage the desk has to trust.
//
// Worked from the form's own values rather than the saved booking, because it
// has to keep up while somebody is still typing.
function cardChargeBase() {
  const fx = extrasInFx();
  const extras = ["delivery", "insurance", "other"].reduce((sum, name) => {
    const v = parseFloat(val(root, `b-${name}`)) || 0;
    // Extras typed in a foreign currency are recorded converted, so the charge
    // has to be worked on the converted figure, not the typed one.
    return sum + Math.max(0, fx ? v * fx.rate : v);
  }, 0);

  const typed = val(root, "b-total");
  let rental;
  if (typed !== "") {
    rental = Math.max(0, parseFloat(typed) || 0);
  } else {
    // Blank means "calculate from the daily rate", which is what saving will do.
    // Same rate rule as saving: an existing booking keeps its snapshotted rate
    // unless the car has been changed, so the preview and the saved figure can
    // never disagree.
    const selectedCarId = el(root, "b-car").value;
    const car = state.cars.find(c => c.id === selectedCarId);
    const editingB = editingBookingId
      ? state.bookings.find(x => x.id === editingBookingId)
      : null;
    const rate = (editingB && editingB.carId === selectedCarId &&
                  typeof editingB.dailyRate === "number" && editingB.dailyRate > 0)
      ? editingB.dailyRate
      : (car?.dailyRate || 0);
    const days = rentalDays({
      startDate: val(root, "b-start"), endDate: val(root, "b-end"),
      startTime: getTime(root, "b-start-time"), endTime: getTime(root, "b-end-time")
    });
    rental = Math.max(0, days * rate);
  }
  return rental + extras;
}

function syncCardCharge() {
  const box = el(root, "b-card");
  const wrap = el(root, "b-card-pct-wrap");
  const hint = el(root, "b-card-hint");
  if (!box || !wrap || !hint) return;

  const on = box.checked;
  wrap.style.display = on ? "inline-flex" : "none";
  if (!on) { hint.textContent = ""; return; }

  const pct = parseFloat(val(root, "b-card-pct"));
  if (!Number.isFinite(pct) || pct <= 0) {
    hint.textContent = "Enter the percentage your bank charges, or untick the box.";
    return;
  }

  const base = cardChargeBase();
  const charge = Math.round(base * pct) / 100;
  hint.textContent =
    `${pct}% of ${formatAmount(base)} = ${formatAmount(charge)} · ` +
    `total due from the client ${formatAmount(base + charge)}`;
}

// Recalculates one field pair (foreign amount → home amount) at today's house
// rate. Used by the booking total and, in view-billing.js, by both deposit
// fields — same pattern, same guard for an already-paid booking.
export function recalcAtTodayRate(fieldRoot, { fxInputId, homeInputId, sym, isPaid, paidLabel }) {
  const rate = fxRate(sym);
  if (!rate) return;
  const amount = parseFloat(val(fieldRoot, fxInputId));
  if (!Number.isFinite(amount) || amount < 0) return;
  const newHome = Math.round(amount * rate);
  const oldHome = parseFloat(val(fieldRoot, homeInputId)) || 0;
  if (newHome === oldHome) return;   // nothing to confirm or change

  if (isPaid && !confirm(
    `This booking is marked paid at ${state.settings?.currency || "Rs"} ${oldHome.toLocaleString()}` +
    (paidLabel ? ` (${paidLabel})` : "") +
    `. Recalculating at today's rate changes it to ${state.settings?.currency || "Rs"} ${newHome.toLocaleString()}. Continue?`
  )) return;

  setVal(fieldRoot, homeInputId, newHome);
}

// ---------- Damage diagram & signature ----------
// The same car drawing the agreement prints, made tappable: each tap adds a
// numbered mark with a note; saving writes them to the booking. The signature
// ---------- Invoice numbers ----------
// Identical discipline to receipts — consecutive, transaction-allocated,
// blocked offline, fixed once issued — but two independent series: ordinary
// invoices count INV-2026-0001 onwards, VAT invoices VAT-2026-0001. Which one
// this company issues is read from the VAT-registered box on Settings at the
// moment of issue, and the VAT rate is snapshotted onto the booking so a
// later rate change never rewrites an invoice already sent. Unlike a receipt,
// an invoice needs nothing to have been paid — billing is its whole point.

// The colour row: Automatic, then every colour this company has ever chosen
// (pilot, Aug 2026: "the colors should be fully chosen by the person using
// the app... they can add as many as they want"), then the + square. A colour
// on the current booking that is not in the palette still shows, selected —
// old bookings keep their colours whatever the palette does.
function paintColourSwatches(selected) {
  const row = el(root, "b-colour");
  if (!row) return;
  const palette = Array.isArray(state.settings?.plannerColours)
    ? state.settings.plannerColours.filter(c => /^#[0-9a-fA-F]{6}$/.test(String(c)))
    : [];
  const sel = String(selected || "");
  const shown = palette.includes(sel) || !sel ? palette : [...palette, sel];
  row.innerHTML =
    `<button type="button" class="swatch auto" data-colour="" title="Automatic \u2014 colour by status">A</button>` +
    shown.map(c =>
      `<button type="button" class="swatch" data-colour="${c}" style="background:${c}" title="${c}"></button>`).join("") +
    `<label class="swatch swatch-add" title="Add a colour to the company palette">+<input type="color" class="swatch-pick" data-el="b-colour-pick"></label>`;
}

function onInvoiceClicked() {
  if (!editingBookingId) return;
  const b = state.bookings.find(x => x.id === editingBookingId);
  if (!b) return;

  // Already issued: print exactly what went out, no questions.
  if (hasInvoiceNo(b)) {
    const r = openInvoice(editingBookingId);
    if (!r.ok) showError(root, "booking-error", r.reason);
    return;
  }

  showError(root, "invoice-error", null);
  const kind = invoiceKindFor();
  const year = receiptYear();
  const next = (Number(state.settings?.[invoiceSeqField(kind)]?.[year]) || 0) + 1;
  setVal(root, "invoice-no", formatInvoiceNo(next, year, kind));
  const title = el(root, "invoice-title");
  if (title) title.textContent = kind === "vat"
    ? `VAT invoice number (${vatRatePct()}%)` : "Invoice number";
  openModal(root, "invoice-modal");
  const box = el(root, "invoice-no");
  if (box) setTimeout(() => { box.focus(); box.select(); }, 30);
}

async function issueInvoice() {
  const id = editingBookingId;
  if (!id) return;
  const btn = el(root, "invoice-go");
  const typed = val(root, "invoice-no").trim();

  if (!typed) { showError(root, "invoice-error", "Enter an invoice number, or cancel."); return; }
  if (invoiceNoTaken(typed, id)) {
    showError(root, "invoice-error",
      `Invoice ${typed} has already been issued on another booking. Use a different number.`);
    return;
  }
  if (navigator.onLine === false) {
    showError(root, "invoice-error",
      "No connection. An invoice number has to be issued online so two people cannot be given the same one. Reconnect and try again.");
    return;
  }

  showError(root, "invoice-error", null);
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "Issuing...";
  setSync("saving");

  const kind = invoiceKindFor();
  const seqField = invoiceSeqField(kind);
  const year = receiptYear();
  const auto = formatInvoiceNo((Number(state.settings?.[seqField]?.[year]) || 0) + 1, year, kind);

  try {
    const settingsRef = doc(db, "settings", state.ctx.companyId);
    const bookingRefDoc = doc(db, "bookings", id);

    const issued = await withTimeout(runTransaction(db, async (tx) => {
      const snap = await tx.get(settingsRef);
      const bSnap = await tx.get(bookingRefDoc);

      const already = bSnap.exists() ? String(bSnap.data().invoiceNo || "") : "";
      if (already) return already;

      const data = snap.exists() ? snap.data() : {};
      const seqMap = (data[seqField] && typeof data[seqField] === "object") ? { ...data[seqField] } : {};
      const used = Number(seqMap[year]) || 0;
      const prefix = String(data.receiptPrefix || "")
        .toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 8);

      // Taking the suggested number advances the counter; a hand-typed one
      // does not — same rule as receipts, same reason.
      let number = typed;
      if (typed === auto) {
        const next = used + 1;
        seqMap[year] = next;
        number = formatInvoiceNo(next, year, kind, prefix);
        tx.set(settingsRef, { companyId: state.ctx.companyId, [seqField]: seqMap }, { merge: true });
      }

      tx.update(bookingRefDoc, {
        invoiceNo: number,
        invoiceKind: kind,
        invoiceVatPct: kind === "vat" ? vatRatePct() : null,
        // The total as invoiced, frozen — the reports list shows this figure
        // even if the booking's price is edited later, matching the reprint.
        invoiceTotalAt: amountDue(state.bookings.find(x => x.id === id) || {}),
        invoiceIssuedAt: new Date().toISOString(),
        invoiceIssuedBy: state.ctx?.user?.email || ""
      });
      return number;
    }), 12000);

    closeModal(root, "invoice-modal");
    setSync("live");
    // Deliberately not opened here: a window.open after an await is no longer
    // a click in the browser's eyes, and pop-up blockers eat it — the number
    // was being issued and then an error shown, the worst of both. The button
    // now carries the number; pressing it is a real click and prints cleanly.
    const ib = el(root, "print-invoice");
    if (ib) ib.textContent = `Invoice ${issued}`;
    showToast(`Invoice ${issued} issued — press the Invoice button to open it`);
    announce();
  } catch (err) {
    setSync("error");
    const code = err && (err.code || err.message) || "";
    showError(root, "invoice-error",
      /timeout|unavailable|offline|network/i.test(String(code))
        ? "Could not reach the server, so no number was issued. Check the connection and try again."
        : `Could not issue an invoice number (${code}). Nothing was saved — try again.`);
  }
  btn.disabled = false;
  btn.textContent = label;
}

// pad saves a small image that lands on the agreement's signature line.
let damageDraft = [];
let fuelDraft = null;   // 25 | 50 | 75 | 100 | null — saved with the marks

function paintFuel() {
  const box = el(root, "fuel-opts");
  if (!box) return;
  box.querySelectorAll(".fuel-opt").forEach(b =>
    b.classList.toggle("selected", Number(b.dataset.fuel) === fuelDraft));
}

function wireDamageAndSignature() {
  const dmgBtn = el(root, "damage-btn");
  if (dmgBtn) dmgBtn.addEventListener("click", () => {
    if (!editingBookingId) return;
    const b = state.bookings.find(x => x.id === editingBookingId);
    damageDraft = Array.isArray(b?.damageMarks) ? b.damageMarks.map(m => ({ ...m })) : [];
    fuelDraft = typeof b?.fuelLevel === "number" ? b.fuelLevel : null;
    el(root, "damage-svg").innerHTML = CAR_OUTLINE;
    paintDamage();
    paintFuel();
    openModal(root, "damage-modal");
  });

  // The fuel gauge: one choice, tap again to clear. Recorded alongside the
  // damage marks because that is the moment both are established — standing at
  // the car at handover.
  const fuelBox = el(root, "fuel-opts");
  if (fuelBox) fuelBox.addEventListener("click", (e) => {
    const b = e.target.closest(".fuel-opt");
    if (!b) return;
    const v = Number(b.dataset.fuel);
    fuelDraft = fuelDraft === v ? null : v;
    paintFuel();
  });

  const svgBox = el(root, "damage-svg");
  if (svgBox) svgBox.addEventListener("click", (e) => {
    const svg = svgBox.querySelector("svg");
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    damageDraft.push({ x, y, note: "" });
    paintDamage();
    const inputs = el(root, "damage-list").querySelectorAll("input");
    if (inputs.length) inputs[inputs.length - 1].focus();
  });

  const list = el(root, "damage-list");
  if (list) {
    list.addEventListener("input", (e) => {
      const row = e.target.closest("[data-mark]");
      if (row) damageDraft[Number(row.dataset.mark)].note = e.target.value;
    });
    list.addEventListener("click", (e) => {
      const rm = e.target.closest("[data-remove-mark]");
      if (!rm) return;
      damageDraft.splice(Number(rm.dataset.removeMark), 1);
      paintDamage();
    });
  }

  const saveDmg = el(root, "save-damage");
  if (saveDmg) saveDmg.addEventListener("click", async () => {
    if (!editingBookingId) return;
    saveDmg.disabled = true; saveDmg.textContent = "Saving...";
    try {
      await updateDoc(doc(db, "bookings", editingBookingId), {
        damageMarks: damageDraft.map(m => ({ x: m.x, y: m.y, note: m.note || "" })),
        fuelLevel: fuelDraft
      });
      closeModal(root, "damage-modal");
    } catch (err) { alert("Couldn't save (" + (err.code || err.message) + ")."); }
    saveDmg.disabled = false; saveDmg.textContent = "Save marks";
  });

  // ---- signature pads: renter and company, on one screen ----
  // One pad factory driving two canvases: the renter signs, the company signs,
  // both save together. Each pad remembers whether it has fresh ink, so saving
  // never overwrites a stored signature with an empty canvas.
  const signBtn = el(root, "sign-btn");
  if (signBtn) {
    const pads = [
      { pad: "rsign-pad", clear: "rsign-clear", remove: "rsign-remove",
        field: "renterSignature", stamp: "renterSignedAt" },
      { pad: "sign-pad", clear: "sign-clear", remove: "sign-remove",
        field: "signature", stamp: "signedAt" }
    ].map(cfg => {
      const canvas = el(root, cfg.pad);
      if (!canvas) return null;
      const ctx = canvas.getContext("2d");
      const api = { cfg, canvas, ctx, ink: false, drawing: null };
      api.reset = () => {
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = "#14213d"; ctx.lineWidth = 2.5; ctx.lineCap = "round"; ctx.lineJoin = "round";
        api.ink = false;
      };
      const pos = (e) => {
        const r = canvas.getBoundingClientRect();
        return { x: (e.clientX - r.left) * (canvas.width / r.width),
                 y: (e.clientY - r.top) * (canvas.height / r.height) };
      };
      canvas.addEventListener("pointerdown", (e) => {
        api.drawing = pos(e);
        try { canvas.setPointerCapture(e.pointerId); } catch {}
        e.preventDefault();
      });
      canvas.addEventListener("pointermove", (e) => {
        if (!api.drawing) return;
        const p = pos(e);
        ctx.beginPath(); ctx.moveTo(api.drawing.x, api.drawing.y); ctx.lineTo(p.x, p.y); ctx.stroke();
        api.drawing = p; api.ink = true;
        e.preventDefault();
      });
      const stop = () => { api.drawing = null; };
      canvas.addEventListener("pointerup", stop);
      canvas.addEventListener("pointercancel", stop);

      const clearBtn = el(root, cfg.clear);
      if (clearBtn) clearBtn.addEventListener("click", api.reset);

      const removeBtn = el(root, cfg.remove);
      if (removeBtn) removeBtn.addEventListener("click", async () => {
        if (!editingBookingId) return;
        try {
          await updateDoc(doc(db, "bookings", editingBookingId),
            { [cfg.field]: null, [cfg.stamp]: null });
          api.reset();
          removeBtn.style.display = "none";
        } catch (err) { alert("Couldn't remove (" + (err.code || err.message) + ")."); }
      });
      return api;
    }).filter(Boolean);

    signBtn.addEventListener("click", () => {
      if (!editingBookingId) return;
      const b = state.bookings.find(x => x.id === editingBookingId);
      pads.forEach(p => {
        p.reset();
        const btn = el(root, p.cfg.remove);
        if (btn) btn.style.display = b?.[p.cfg.field] ? "inline-block" : "none";
      });
      openModal(root, "sign-modal");
    });

    el(root, "save-sign").addEventListener("click", async () => {
      if (!editingBookingId) return;
      const fresh = pads.filter(p => p.ink);
      if (!fresh.length) { alert("Sign at least one of the two, or Cancel."); return; }
      const btn = el(root, "save-sign");
      btn.disabled = true; btn.textContent = "Saving...";
      const patch = {};
      fresh.forEach(p => {
        // Downscaled before storing: the booking document carries these, so
        // they stay about the size of the company logo, not photographs.
        const small = document.createElement("canvas");
        small.width = 400;
        small.height = Math.round(400 * p.canvas.height / p.canvas.width);
        small.getContext("2d").drawImage(p.canvas, 0, 0, small.width, small.height);
        patch[p.cfg.field] = small.toDataURL("image/png");
        patch[p.cfg.stamp] = new Date().toISOString();
      });
      try {
        await updateDoc(doc(db, "bookings", editingBookingId), patch);
        closeModal(root, "sign-modal");
      } catch (err) { alert("Couldn't save (" + (err.code || err.message) + ")."); }
      btn.disabled = false; btn.textContent = "Save signatures";
    });
  }
}

function paintDamage() {
  const svg = el(root, "damage-svg").querySelector("svg");
  if (!svg) return;
  svg.querySelectorAll("[data-mark-dot]").forEach(n => n.remove());
  damageDraft.forEach((m, i) => {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("data-mark-dot", i);
    g.innerHTML =
      `<circle cx="${m.x * 700}" cy="${m.y * 338}" r="13" fill="rgba(176,0,32,0.12)" stroke="#b00020" stroke-width="2.5"></circle>` +
      `<text x="${m.x * 700}" y="${m.y * 338 + 4}" text-anchor="middle" font-size="13" font-weight="bold" fill="#b00020">${i + 1}</text>`;
    svg.appendChild(g);
  });
  el(root, "damage-list").innerHTML = damageDraft.length
    ? damageDraft.map((m, i) => `
      <div class="damage-row" data-mark="${i}">
        <strong>${i + 1}.</strong>
        <input type="text" placeholder="e.g. scratch, rear left door" value="${esc(m.note || "")}">
        <button type="button" class="btn danger" data-remove-mark="${i}">×</button>
      </div>`).join("")
    : `<div style="color:var(--muted);font-size:12px;">No marks yet — tap the drawing.</div>`;
}

export function openBookingModal(bookingId, preset) {
  if (state.cars.length === 0) { alert("Add at least one car in the Fleet view first."); return; }

  editingBookingId = bookingId || null;
  const editing = editingBookingId ? state.bookings.find(b => b.id === editingBookingId) : null;
  // Shown in the title when editing, which is where someone looks when a
  // customer rings up quoting a number.
  {
    const vi = el(root, "b-view-invoice");
    if (vi) vi.style.display = editing ? "inline-flex" : "none";
  }
  el(root, "booking-modal-title").textContent = editing
    ? `Edit booking ${bookingRef(editing)}`
    : "New booking";

  const sel = el(root, "b-car");
  sel.innerHTML = state.cars.slice()
    .sort((a, b) => (a.make + a.model).localeCompare(b.make + b.model))
    .map(c => `<option value="${c.id}">${esc(`${c.year || ""} ${c.make} ${c.model} (${c.plate || "no plate"})`.trim())}</option>`)
    .join("");

  fillSuggestions();
  fillCurrencyOptions();

  const csel = el(root, "b-customer");
  csel.innerHTML = state.customers.slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(c => `<option value="${c.id}">${esc(c.name)}${c.phone ? " · " + esc(c.phone) : ""}</option>`)
    .join("")
    + `<option value="__new__">+ New customer (adds to the register)</option>`
    + `<option value="__quick__">Just this booking (not added to the register)</option>`;
  // They mostly take a name rather than creating a customer record, so this
  // is the default; picking a saved customer is still one click away.
  csel.value = "__quick__";

  ["b-name","b-phone","b-email","b-quickname","b-quickphone","b-quickemail","b-start","b-end",
   "b-pickup","b-dropoff","b-total","b-delivery","b-insurance","b-other","b-passport","b-licence",
   "b-managedby","b-deliveredby","b-recoveredby","b-broker","b-notes"]
    .forEach(n => setVal(root, n, ""));
  el(root, "b-currency").value = "";
  setVal(root, "b-fxtotal", "");
  syncCurrencyFields();
  setChecked(root, "b-paid", false);
  setChecked(root, "b-card", false);
  setVal(root, "b-card-pct", "");
  paintColourSwatches("");
  setSwatch(root, "b-colour", "");
  // Sensible default times so staff only change them when it matters
  setTime(root, "b-start-time", "12:00");
  setTime(root, "b-end-time", "12:00");

  if (editing) {
    sel.value = editing.carId;
    setVal(root, "b-start", editing.startDate);
    setVal(root, "b-end", editing.endDate);
    setTime(root, "b-start-time", startTime(editing));
    setTime(root, "b-end-time", endTime(editing));
    setVal(root, "b-pickup", editing.pickupLocation || "");
    setVal(root, "b-dropoff", editing.dropoffLocation || "");
    setVal(root, "b-total", editing.totalPrice ?? "");
    setVal(root, "b-managedby", editing.managedBy || "");
    setVal(root, "b-deliveredby", editing.deliveredBy || "");
    setVal(root, "b-recoveredby", editing.recoveredBy || "");
    setVal(root, "b-broker", editing.broker || "");
    // A currency removed from the offered list after this booking was taken
    // still has to load and save intact — the select gets a one-off option
    // for it rather than silently clearing the booking's currency.
    {
      const curSel = el(root, "b-currency");
      if (editing.fxCurrency &&
          ![...curSel.options].some(o => o.value === editing.fxCurrency)) {
        curSel.insertAdjacentHTML("beforeend",
          `<option value="${esc(editing.fxCurrency)}">${esc(editing.fxCurrency)}</option>`);
      }
      curSel.value = editing.fxCurrency || "";
    }
    setVal(root, "b-fxtotal", editing.fxTotal ?? "");
    syncCurrencyFields();
    setVal(root, "b-passport", editing.passport || "");
    setVal(root, "b-licence", editing.licence || "");
    // The foreign figure when one is stored. When there is none but a currency
    // is set — a booking whose extras were recorded in Rs before extras could
    // be typed in the currency — the Rs amount is converted INTO the currency
    // at this booking's own rate for display. Without that, the raw Rs figure
    // sat in a field labelled "in €", and saving multiplied it by the rate:
    // Rs 500 of delivery became Rs 24,000 on an edit that never touched it.
    // With no usable rate the Rs figure stays as it is, which is also safe:
    // saving without a rate records extras in Rs unconverted.
    {
      const loadExtra = (fxVal, costVal) => {
        if (typeof fxVal === "number") return fxVal;
        if (typeof costVal !== "number") return "";
        if (!editing.fxCurrency) return costVal;
        const r = bookingRate(editing.fxCurrency,
          Number(editing.fxTotal) || 0, Number(editing.totalPrice) || 0);
        if (!r) return costVal;
        return Math.round((costVal / r) * 100) / 100;
      };
      setVal(root, "b-delivery", loadExtra(editing.fxDelivery, editing.deliveryCost));
      setVal(root, "b-insurance", loadExtra(editing.fxInsurance, editing.insuranceCost));
      setVal(root, "b-other", loadExtra(editing.fxOther, editing.otherCost));
    }
    setVal(root, "b-notes", editing.notes || "");
    setChecked(root, "b-paid", editing.paid === true);
    // The rate the booking was agreed at, not today's company default — the
    // whole point of snapshotting it.
    setChecked(root, "b-card", editing.cardPayment === true);
    setVal(root, "b-card-pct",
      (typeof editing.bankChargePct === "number" && editing.bankChargePct > 0)
        ? editing.bankChargePct : "");
    paintColourSwatches(editing.barColour || "");
    setSwatch(root, "b-colour", editing.barColour || "");
    if (editing.customerId && state.customers.some(c => c.id === editing.customerId)) {
      csel.value = editing.customerId;
    } else {
      csel.value = "__quick__";
      setVal(root, "b-quickname", editing.renter || "");
      setVal(root, "b-quickphone", editing.phone || "");
      setVal(root, "b-quickemail", editing.email || "");
    }
  }

  // Pre-fill from the planner: a single tapped day, or a range dragged across
  // several. endDate is only sent by the drag, so a plain tap still puts both
  // dates on the same day as before.
  if (!editing && preset) {
    if (preset.carId) sel.value = preset.carId;
    if (preset.date) {
      setVal(root, "b-start", preset.date);
      setVal(root, "b-end", preset.endDate || preset.date);
    }
    // The availability check lets the desk pick times; a preset that carries
    // them lands in the form intact rather than snapping back to noon.
    if (preset.startTime) setTime(root, "b-start-time", preset.startTime);
    if (preset.endTime) setTime(root, "b-end-time", preset.endTime);
  }

  el(root, "delete-booking").style.display = editing ? "inline-block" : "none";
  el(root, "print-agreement").style.display = editing ? "inline-block" : "none";
  {
    const cb = el(root, "print-confirmation");
    if (cb) cb.style.display = editing ? "inline-block" : "none";
    const rb = el(root, "print-receipt");
    if (rb) {
      rb.style.display = editing ? "inline-block" : "none";
      // Once a receipt has a number, the button carries it — staff can see at a
      // glance that this booking has already been receipted, and which one.
      rb.textContent = editing && hasReceiptNo(editing)
        ? `Receipt ${receiptNo(editing)}` : "Receipt";
    }
    const ib = el(root, "print-invoice");
    if (ib) {
      ib.style.display = editing ? "inline-block" : "none";
      ib.textContent = editing && hasInvoiceNo(editing)
        ? `Invoice ${invoiceNo(editing)}` : "Invoice";
    }
    const db2 = el(root, "damage-btn");
    if (db2) db2.style.display = editing ? "inline-block" : "none";
    const sb = el(root, "sign-btn");
    if (sb) sb.style.display = editing ? "inline-block" : "none";
  }
  el(root, "email-booking").style.display = editing ? "inline-block" : "none";
  el(root, "whatsapp-booking").style.display = editing ? "inline-block" : "none";

  toggleNewCustomer();
  syncCardCharge();
  showError(root, "booking-error", null);
  syncMoneyBlock();
  openModal(root, "booking-modal");
}

// Ticking "Paid" here has to record when, or Billing cannot tell which period
// the money belongs to. An existing date is kept, so editing a booking never
// shifts money into a different period.
function settlement() {
  const isPaid = checked(root, "b-paid");
  const previous = editingBookingId
    ? state.bookings.find(x => x.id === editingBookingId)
    : null;
  if (!isPaid) return { paid: false, paidAt: null, paidAmount: null };
  return {
    paid: true,
    paidAt: previous?.paidAt || new Date().toISOString(),
    paidAmount: typeof previous?.paidAmount === "number" ? previous.paidAmount : null
  };
}

// An empty box means "not charged" and is stored as null; a typed figure is
// stored as a number, never negative.
function money(raw) {
  if (raw === "" || raw == null) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

async function saveBooking() {
  showError(root, "booking-error", null);

  const carId = el(root, "b-car").value;
  const choice = el(root, "b-customer").value;
  const startDate = val(root, "b-start");
  const endDate = val(root, "b-end");

  let customerId, renter, phone, email;
  if (choice === "__quick__") {
    // No customer record is created or looked up, but the contact details are
    // still kept on the booking itself — otherwise there is nothing to send a
    // confirmation to, and this is the path most walk-ins are booked through.
    renter = val(root, "b-quickname");
    phone = val(root, "b-quickphone");
    email = val(root, "b-quickemail");
    if (!renter) { showError(root, "booking-error", "Enter a name for this booking."); return; }
  } else if (choice === "__new__") {
    renter = val(root, "b-name");
    phone = val(root, "b-phone");
    email = val(root, "b-email");
    if (!renter) { showError(root, "booking-error", "Enter the new customer's name."); return; }
  } else {
    const c = state.customers.find(x => x.id === choice);
    if (!c) { showError(root, "booking-error", "Pick a customer."); return; }
    // Email is copied the same way the phone is. Leaving it out meant saving
    // an edit wrote email: "" onto the booking — harmless for sending (which
    // falls back to the customer record) but needlessly asymmetric.
    customerId = c.id; renter = c.name; phone = c.phone || ""; email = c.email || "";
  }

  if (!carId || !startDate || !endDate) {
    showError(root, "booking-error", "Please fill in car and both dates."); return;
  }
  const startTimeVal = getTime(root, "b-start-time") || "12:00";
  const endTimeVal = getTime(root, "b-end-time") || "12:00";
  const startAt = `${startDate}T${startTimeVal}`;
  const endAt = `${endDate}T${endTimeVal}`;

  if (endAt <= startAt) {
    showError(root, "booking-error", startDate === endDate
      ? `Same-day rental: the return time (${endTimeVal}) must be later than the pick-up time (${startTimeVal}).`
      : "The return must be after the pick-up. Check the dates and times.");
    return;
  }

  const wasEditing = editingBookingId;
  const clash = findClash({ carId, startAt, endAt, ignoreId: editingBookingId });
  if (clash) {
    showError(root, "booking-error",
      `This car is already out ${describeInterval(clash)} (${clash.renter}). ` +
      `Adjust the times or dates, or choose another car.`);
    return;
  }

  const btn = el(root, "save-booking");
  btn.disabled = true; btn.textContent = "Saving...";
  setSync("saving");
  let newRef = null;
  try {
    // Only the "New customer" option adds to the register. The quick option used
    // to create a record too, despite saying it would not — which is why names
    // like "Blocked" and "customer 1" ended up in the customer list. The contact
    // details live on the booking instead, so a confirmation can still be sent.
    if (!customerId && choice === "__new__") {
      const ref = await addDoc(collection(db, "customers"), {
        companyId: state.ctx.companyId, name: renter, phone, email: email || "",
        license: "", notes: "", createdAt: new Date().toISOString()
      });
      customerId = ref.id;
    }

    const car = state.cars.find(x => x.id === carId);
    // The daily rate is snapshotted when the booking is created and then kept
    // through every edit — that is the promise the whole billing model makes.
    // This used to re-copy the car's *current* rate on every save, so opening
    // an old booking just to fix a note silently repriced it if the car's rate
    // had changed since. The snapshot moves only when the booking is put on a
    // different car, which is the same rule the drag-to-move dialog applies.
    const prevSnapshot = editingBookingId
      ? state.bookings.find(x => x.id === editingBookingId)
      : null;
    const keepRate = prevSnapshot && prevSnapshot.carId === carId &&
      typeof prevSnapshot.dailyRate === "number";
    const dailyRate = keepRate ? prevSnapshot.dailyRate : (car?.dailyRate || 0);
    const carName = car ? `${car.year || ""} ${car.make} ${car.model} (${car.plate || "no plate"})`.trim() : "";

    const totalRaw = val(root, "b-total");
    const fxSym = el(root, "b-currency").value;
    const fxTotalRaw = val(root, "b-fxtotal");
    // A foreign total without its Rs twin has no value the books can use, so
    // the pair is required together. (Currency alone, with no foreign total,
    // is fine — the deposits may be the only foreign part.)
    if (fxSym && fxTotalRaw !== "" && totalRaw === "") {
      showError(root, "booking-error",
        `You entered a total in ${fxSym} — also enter the agreed value in ` +
        `${state.settings?.currency || "Rs"} in the field below it. That figure is what the books record.`);
      btn.disabled = false; btn.textContent = "Save booking";
      return;
    }
    const details = {
      startTime: startTimeVal,
      endTime: endTimeVal,
      pickupLocation: val(root, "b-pickup"),
      dropoffLocation: val(root, "b-dropoff"),
      totalPrice: totalRaw === "" ? null : (parseFloat(totalRaw) || 0),
      // Switching back to the company currency clears every foreign figure,
      // so nothing stale can keep displaying against the Rs amounts.
      fxCurrency: fxSym || "",
      fxTotal: fxSym ? money(fxTotalRaw) : null,
      ...(fxSym ? {} : { fxAdvance: null, fxSecurity: null }),
      managedBy: val(root, "b-managedby"),
      deliveredBy: val(root, "b-deliveredby"),
      recoveredBy: val(root, "b-recoveredby"),
      broker: val(root, "b-broker"),
      // Snapshotted at save, like the daily rate: a later change to the company
      // default must never move the amount owed on a booking already agreed.
      // Unticking the box clears the rate too, so nothing stale can be revived
      // by ticking it again months later.
      ...(function () {
        const on = checked(root, "b-card");
        if (!on) return { cardPayment: false, bankChargePct: null };
        const n = parseFloat(val(root, "b-card-pct"));
        return { cardPayment: true, bankChargePct: Number.isFinite(n) && n > 0 ? n : null };
      })(),
      passport: val(root, "b-passport"),
      licence: val(root, "b-licence"),
      // Blank stays blank rather than becoming a zero, so an invoice only shows
      // the extras that were actually charged.
      // Extras typed in the booking currency are converted at the booking's
      // own rate and recorded in the home currency — the books never hold
      // mixed-currency arithmetic. Both figures are kept.
      ...(function () {
        const fx = extrasInFx();
        const raw = {
          delivery: money(val(root, "b-delivery")),
          insurance: money(val(root, "b-insurance")),
          other: money(val(root, "b-other"))
        };
        if (!fx) return {
          deliveryCost: raw.delivery, insuranceCost: raw.insurance, otherCost: raw.other,
          fxDelivery: null, fxInsurance: null, fxOther: null
        };
        const conv = v => (typeof v === "number" ? Math.round(v * fx.rate) : v);
        return {
          deliveryCost: conv(raw.delivery), insuranceCost: conv(raw.insurance), otherCost: conv(raw.other),
          fxDelivery: raw.delivery, fxInsurance: raw.insurance, fxOther: raw.other
        };
      })(),
      notes: val(root, "b-notes"),
      ...settlement(),
      barColour: getSwatch(root, "b-colour")
    };

    if (editingBookingId) {
      // If a date is edited here, any task-only override on that end is
      // cleared, so the hand-over or collection follows the booking again
      // rather than sitting on a day that no longer means anything.
      const prev = state.bookings.find(x => x.id === editingBookingId);
      const clearOverrides = {};
      if (prev?.deliveryDate && prev.startDate !== startDate) clearOverrides.deliveryDate = null;
      if (prev?.recoveryDate && prev.endDate !== endDate) clearOverrides.recoveryDate = null;
      // Ticking or unticking Paid here is a money-status change like the
      // Billing buttons, and is logged the same way.
      if (prev && !!prev.paid !== !!details.paid) {
        clearOverrides.paidLog = arrayUnion({
          at: new Date().toISOString(),
          action: details.paid ? "marked paid" : "marked unpaid",
          by: state.ctx?.user?.email || ""
        });
      }
      await updateDoc(doc(db, "bookings", editingBookingId),
        { carId, customerId: customerId ?? null, renter, phone, email: email || "",
          startDate, endDate, dailyRate, carName, ...details, ...clearOverrides });
    } else {
      // Generated once, here, so the reference stays the same for the life of the
      // booking however often it is edited afterwards.
      newRef = makeBookingRef();
      await addDoc(collection(db, "bookings"), {
        companyId: state.ctx.companyId, carId, customerId: customerId ?? null, renter, phone,
        email: email || "",
        startDate, endDate, dailyRate, carName, ...details,
        ref: newRef, status: "open", createdAt: new Date().toISOString()
      });
    }
    closeModal(root, "booking-modal");
    // The reference is only useful if staff actually see it, so it is shown on
    // saving rather than left to be found later in the list.
    showToast(newRef
      ? `Booking ${newRef} saved`
      : `Booking ${bookingRef(state.bookings.find(b => b.id === wasEditing)) || ""} updated`);
    editingBookingId = null;
    announce();
  } catch (e) {
    showError(root, "booking-error", "Couldn't save the booking (" + (e.code || e.message) + ").");
    setSync("error");
  }
  btn.disabled = false; btn.textContent = "Save booking";
}

// Deletes the booking currently open in the modal, so a bar tapped on the
// timeline can be removed without hunting for it in the list below.
async function deleteEditingBooking() {
  if (!editingBookingId) return;
  const b = state.bookings.find(x => x.id === editingBookingId);
  if (!confirm(deleteBookingWarning(b))) return;

  const btn = el(root, "delete-booking");
  btn.disabled = true; btn.textContent = "Deleting...";
  setSync("saving");
  try {
    await deleteDoc(doc(db, "bookings", editingBookingId));
    closeModal(root, "booking-modal");
    editingBookingId = null;
    announce();
  } catch (e) {
    showError(root, "booking-error", "Couldn't delete (" + (e.code || e.message) + "). Try again.");
    setSync("error");
  }
  btn.disabled = false; btn.textContent = "Delete booking";
}

