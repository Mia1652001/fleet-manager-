// Booking form — the add/edit dialog for a booking.
//
// This lives outside any single view because more than one screen shows a
// planner, and each of them needs to open the same form. It owns its own root
// element (#booking-form-root) so the shared el()/val() helpers keep working.

import { db, setSync } from "./firebase-init.js";
import { openAgreement, emailBooking, whatsappBooking } from "./agreement.js";
import { collection, addDoc, updateDoc, deleteDoc, doc, arrayUnion } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  state, esc, formatDate, todayStr, findClash, describeInterval,
  makeBookingRef, bookingRef, showToast,
  staffNames, locationNames, brokerNames, FX_CURRENCIES, fxRate, deleteBookingWarning,
  startTime, endTime,
  fillTimeOptions, getTime, setTime, onTimeChange,
  getSwatch, setSwatch,
  el, val, setVal, checked, setChecked, openModal, closeModal, showError,
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
    el(root, name).addEventListener("input", syncExtrasHint));
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

  ["b-start", "b-end"].forEach(n =>
    el(root, n).addEventListener("change", keepReturnAfterPickup));
  onTimeChange(root, "b-start-time", keepReturnAfterPickup);
  onTimeChange(root, "b-end-time", keepReturnAfterPickup);

  el(root, "b-colour").addEventListener("click", (e) => {
    const sw = e.target.closest(".swatch");
    if (!sw) return;
    e.preventDefault();
    setSwatch(root, "b-colour", sw.dataset.colour);
  });

  root.querySelectorAll("[data-close]").forEach(b =>
    b.addEventListener("click", () => closeModal(root, b.dataset.close)));
  root.querySelectorAll(".overlay").forEach(o =>
    o.addEventListener("click", e => { if (e.target === o) o.classList.remove("open"); }));
}

function keepReturnAfterPickup() {
  const sd = val(root, "b-start"), st = getTime(root, "b-start-time");
  let ed = val(root, "b-end"), et = getTime(root, "b-end-time");
  if (!sd || !st) return;

  // Return date before pick-up: pull it up to the pick-up day
  if (ed && ed < sd) { setVal(root, "b-end", sd); ed = sd; }
  if (!ed) return;

  // Same day but the return time is not after the pick-up: push it later
  if (ed === sd && et && et <= st) {
    const [h, m] = st.split(":").map(Number);
    const later = h + 2 <= 23 ? `${String(h + 2).padStart(2, "0")}:${String(m).padStart(2, "0")}` : "23:59";
    setTime(root, "b-end-time", later);
  }
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
   "b-pickup","b-dropoff","b-total","b-delivery","b-insurance","b-other",
   "b-managedby","b-deliveredby","b-recoveredby","b-broker","b-notes"]
    .forEach(n => setVal(root, n, ""));
  el(root, "b-currency").value = "";
  setVal(root, "b-fxtotal", "");
  syncCurrencyFields();
  setChecked(root, "b-paid", false);
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
    setVal(root, "b-delivery", editing.fxDelivery ?? editing.deliveryCost ?? "");
    setVal(root, "b-insurance", editing.fxInsurance ?? editing.insuranceCost ?? "");
    setVal(root, "b-other", editing.fxOther ?? editing.otherCost ?? "");
    setVal(root, "b-notes", editing.notes || "");
    setChecked(root, "b-paid", editing.paid === true);
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
  }

  el(root, "delete-booking").style.display = editing ? "inline-block" : "none";
  el(root, "print-agreement").style.display = editing ? "inline-block" : "none";
  el(root, "email-booking").style.display = editing ? "inline-block" : "none";
  el(root, "whatsapp-booking").style.display = editing ? "inline-block" : "none";

  toggleNewCustomer();
  showError(root, "booking-error", null);
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
    customerId = c.id; renter = c.name; phone = c.phone || "";
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
    const dailyRate = car?.dailyRate || 0;
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

