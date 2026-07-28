// Booking form — the add/edit dialog for a booking.
//
// This lives outside any single view because more than one screen shows a
// planner, and each of them needs to open the same form. It owns its own root
// element (#booking-form-root) so the shared el()/val() helpers keep working.

import { db, setSync } from "./firebase-init.js";
import { collection, addDoc, updateDoc, deleteDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  state, esc, formatDate, todayStr, findClash, describeInterval,
  makeBookingRef, bookingRef, showToast,
  startTime, endTime,
  fillTimeOptions, getTime, setTime, onTimeChange,
  getSwatch, setSwatch,
  el, val, setVal, checked, setChecked, openModal, closeModal, showError
} from "./store.js";

let root = null;
let editingBookingId = null;

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
  el(root, "b-customer").addEventListener("change", toggleNewCustomer);

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
}

export function openBookingModal(bookingId, preset) {
  if (state.cars.length === 0) { alert("Add at least one car in the Fleet view first."); return; }

  editingBookingId = bookingId || null;
  const editing = editingBookingId ? state.bookings.find(b => b.id === editingBookingId) : null;
  // Shown in the title when editing, which is where someone looks when a
  // customer rings up quoting a number.
  el(root, "booking-modal-title").textContent = editing
    ? `Edit booking ${bookingRef(editing)}`
    : "New booking";

  const sel = el(root, "b-car");
  sel.innerHTML = state.cars.slice()
    .sort((a, b) => (a.make + a.model).localeCompare(b.make + b.model))
    .map(c => `<option value="${c.id}">${esc(`${c.year || ""} ${c.make} ${c.model} (${c.plate || "no plate"})`.trim())}</option>`)
    .join("");

  const csel = el(root, "b-customer");
  csel.innerHTML = state.customers.slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(c => `<option value="${c.id}">${esc(c.name)}${c.phone ? " · " + esc(c.phone) : ""}</option>`)
    .join("")
    + `<option value="__new__">+ New customer (save to register)</option>`
    + `<option value="__quick__">Just type a name (don't save)</option>`;
  // They mostly take a name rather than creating a customer record, so this
  // is the default; picking a saved customer is still one click away.
  csel.value = "__quick__";

  ["b-name","b-phone","b-email","b-quickname","b-start","b-end",
   "b-pickup","b-dropoff","b-total","b-managedby","b-deliveredby","b-notes"]
    .forEach(n => setVal(root, n, ""));
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
    setVal(root, "b-notes", editing.notes || "");
    setChecked(root, "b-paid", editing.paid === true);
    setSwatch(root, "b-colour", editing.barColour || "");
    if (editing.customerId && state.customers.some(c => c.id === editing.customerId)) {
      csel.value = editing.customerId;
    } else {
      csel.value = "__quick__";
      setVal(root, "b-quickname", editing.renter || "");
    }
  }

  // Pre-fill from a clicked timeline cell
  if (!editing && preset) {
    if (preset.carId) sel.value = preset.carId;
    if (preset.date) { setVal(root, "b-start", preset.date); setVal(root, "b-end", preset.date); }
  }

  el(root, "delete-booking").style.display = editing ? "inline-block" : "none";

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

async function saveBooking() {
  showError(root, "booking-error", null);

  const carId = el(root, "b-car").value;
  const choice = el(root, "b-customer").value;
  const startDate = val(root, "b-start");
  const endDate = val(root, "b-end");

  let customerId, renter, phone, email;
  if (choice === "__quick__") {
    // A name only — no customer record is created or looked up
    renter = val(root, "b-quickname");
    phone = "";
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
    if (!customerId) {
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
    const details = {
      startTime: startTimeVal,
      endTime: endTimeVal,
      pickupLocation: val(root, "b-pickup"),
      dropoffLocation: val(root, "b-dropoff"),
      totalPrice: totalRaw === "" ? null : (parseFloat(totalRaw) || 0),
      managedBy: val(root, "b-managedby"),
      deliveredBy: val(root, "b-deliveredby"),
      notes: val(root, "b-notes"),
      ...settlement(),
      barColour: getSwatch(root, "b-colour")
    };

    if (editingBookingId) {
      await updateDoc(doc(db, "bookings", editingBookingId),
        { carId, customerId: customerId ?? null, renter, phone, startDate, endDate, dailyRate, carName, ...details });
    } else {
      // Generated once, here, so the reference stays the same for the life of the
      // booking however often it is edited afterwards.
      newRef = makeBookingRef();
      await addDoc(collection(db, "bookings"), {
        companyId: state.ctx.companyId, carId, customerId: customerId ?? null, renter, phone,
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
  const who = b ? ` for ${b.renter}` : "";
  if (!confirm(`Delete this booking${who}?\n\nThis also removes its jobs from the Tasks list and its invoice from Billing.`)) return;

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

