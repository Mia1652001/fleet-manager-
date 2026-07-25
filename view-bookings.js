// Bookings view — calendar and reservations with conflict prevention.
import { db, setSync } from "./firebase-init.js";
import { collection, addDoc, updateDoc, deleteDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  state, onDataChange, esc, formatDate, formatAmount, todayStr, bookingCarLabel, bookingState,
  findClash, describeInterval, sharesStartHandover, sharesEndHandover,
  startTime, endTime, pickupLabel, dropoffLabel, rentalTotal,
  el, val, setVal, openModal, closeModal, showError
} from "./store.js";

let root = null;
let filter = "all";
let editingBookingId = null;
let calYear, calMonth;
let planner = "timeline"; // "timeline" | "month"

// The timeline shows a rolling window of dates (not tied to calendar months),
// so it never dumps out a whole month of empty history on a wide screen.
// It starts a few days before today and scrolls forward from there.
const TIMELINE_DAYS = 21;
let timelineAnchor = null; // Date — first visible day in the timeline

function freshAnchor() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 3); // a little history for context, then the road ahead
  return d;
}
function dstr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function mount(container) {
  root = container;
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth();
  timelineAnchor = freshAnchor();

  el(root, "search").addEventListener("input", render);
  el(root, "new-booking").addEventListener("click", () => openBookingModal(null));
  el(root, "save-booking").addEventListener("click", saveBooking);
  el(root, "b-customer").addEventListener("change", toggleNewCustomer);

  // Only ever adjusts the return, never the pick-up, so the change is
  // predictable: the user's own input is left alone.
  ["b-start", "b-start-time", "b-end", "b-end-time"].forEach(n =>
    el(root, n).addEventListener("change", keepReturnAfterPickup));

  el(root, "view-timeline").addEventListener("click", () => setPlanner("timeline"));
  el(root, "view-month").addEventListener("click", () => setPlanner("month"));

  // Clicking a booking bar in the timeline opens it for editing
  el(root, "timeline").addEventListener("click", (e) => {
    const bar = e.target.closest("[data-booking]");
    if (bar) { openBookingModal(bar.dataset.booking); return; }

    // Clicking an empty day opens a new booking with that car and date
    // already filled in, so there is no need to pick them again.
    const cell = e.target.closest("[data-add-car]");
    if (cell) openBookingModal(null, { carId: cell.dataset.addCar, date: cell.dataset.addDate });
  });

  el(root, "cal-prev").addEventListener("click", () => {
    if (planner === "timeline") { timelineAnchor.setDate(timelineAnchor.getDate() - 7); render(); }
    else shiftMonth(-1);
  });
  el(root, "cal-next").addEventListener("click", () => {
    if (planner === "timeline") { timelineAnchor.setDate(timelineAnchor.getDate() + 7); render(); }
    else shiftMonth(1);
  });
  el(root, "cal-today").addEventListener("click", () => {
    if (planner === "timeline") { timelineAnchor = freshAnchor(); }
    else {
      const d = new Date();
      calYear = d.getFullYear(); calMonth = d.getMonth();
    }
    render();
  });

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

  el(root, "list").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.act === "complete") completeBooking(id);
    else if (btn.dataset.act === "edit") openBookingModal(id);
    else if (btn.dataset.act === "delete") deleteBooking(id);
  });

  onDataChange(() => { if (root.classList.contains("active")) render(); });
}

function shiftMonth(delta) {
  calMonth += delta;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  if (calMonth > 11) { calMonth = 0; calYear++; }
  render();
}

function stateLabel(s) {
  return { "active-b": "Active", upcoming: "Upcoming", overdue: "Overdue", completed: "Completed" }[s] || s;
}

export function render() {
  if (!root) return;
  renderStats();
  if (planner === "timeline") renderTimeline(); else renderCalendar();
  renderList();
}

function setPlanner(which) {
  planner = which;
  el(root, "view-timeline").classList.toggle("active", which === "timeline");
  el(root, "view-month").classList.toggle("active", which === "month");
  el(root, "timeline-wrap").style.display = which === "timeline" ? "block" : "none";
  el(root, "calendar").style.display = which === "month" ? "grid" : "none";
  const legend = root.querySelector(".tl-legend");
  if (legend) legend.style.display = which === "timeline" ? "flex" : "none";
  render();
}

function renderStats() {
  const states = state.bookings.map(bookingState);
  const count = s => states.filter(x => x === s).length;
  el(root, "stats").innerHTML = `
    <div class="stat"><div class="stat-label">Active now</div><div class="stat-val green">${count("active-b")}</div></div>
    <div class="stat"><div class="stat-label">Upcoming</div><div class="stat-val amber">${count("upcoming")}</div></div>
    <div class="stat"><div class="stat-label">Overdue</div><div class="stat-val red">${count("overdue")}</div></div>
    <div class="stat"><div class="stat-label">Completed</div><div class="stat-val">${count("completed")}</div></div>
  `;
}

// ---------- Timeline / fleet planner ----------
// Cars down the left, days across the top, one bar per rental.
// This is the layout most rental companies already use on paper or in a
// spreadsheet, so availability can be read across a whole month at a glance.
function renderTimeline() {
  const wrap = el(root, "timeline-wrap");
  const grid = el(root, "timeline");
  const t = todayStr();

  // Build the rolling window of dates from the anchor
  const days = [];
  for (let i = 0; i < TIMELINE_DAYS; i++) {
    const d = new Date(timelineAnchor);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  const first = dstr(days[0]);
  const last = dstr(days[days.length - 1]);

  // Title shows the visible range rather than a calendar month, since the
  // window can straddle two months.
  const fmt = d => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const yearLabel = days[days.length - 1].getFullYear();
  el(root, "cal-title").textContent = `${fmt(days[0])} – ${fmt(days[days.length - 1])} ${yearLabel}`;

  if (state.cars.length === 0) {
    grid.innerHTML = '<div class="tl-empty">No cars yet. Add cars on the Fleet view and they will appear here.</div>';
    grid.style.gridTemplateColumns = "1fr";
    return;
  }

  const cars = state.cars.slice().sort((a, b) =>
    (a.make + a.model).localeCompare(b.make + b.model));

  // minmax lets columns stretch to fill a wide screen instead of leaving
  // dead space after the window, while still enforcing a usable minimum
  // width (and staying horizontally scrollable) on narrow ones.
  // Two half-columns per day: a whole rental fills both, and on a handover day
  // the outgoing rental takes the first half and the incoming one the second,
  // so same-day turnarounds read clearly instead of overlapping.
  grid.style.gridTemplateColumns = `170px repeat(${TIMELINE_DAYS * 2}, minmax(18px, 1fr))`;

  const dowShort = ["Su","Mo","Tu","We","Th","Fr","Sa"];
  let html = `<div class="tl-corner" style="grid-row:1;grid-column:1;">Vehicle</div>`;

  days.forEach((d, i) => {
    const ds = dstr(d);
    const dow = d.getDay();
    const cls = ds === t ? "today" : (dow === 0 || dow === 6) ? "weekend" : "";
    html += `<div class="tl-daynum ${cls}" style="grid-row:1;grid-column:${i * 2 + 2} / span 2;">
      <span class="dow">${dowShort[dow]}</span>${d.getDate()}</div>`;
  });

  cars.forEach((car, i) => {
    const row = i + 2;
    const oos = !!car.outOfService;

    html += `<div class="tl-car ${oos ? "oos" : ""}" style="grid-row:${row};grid-column:1;">
      <strong>${esc(`${car.make} ${car.model}`)}</strong>
      <span>${esc(car.plate || "no plate")}</span>
    </div>`;

    days.forEach((d, i2) => {
      const ds = dstr(d);
      const dow = d.getDay();
      const cls = ds === t ? "today" : (dow === 0 || dow === 6) ? "weekend" : "";
      html += `<div class="tl-cell addable ${cls}" data-add-car="${car.id}" data-add-date="${ds}"
        title="Add a booking for this car on ${formatDate(ds)}"
        style="grid-row:${row};grid-column:${i2 * 2 + 2} / span 2;"></div>`;
    });

    if (oos) {
      html += `<div class="tl-oos-bar" style="grid-row:${row};grid-column:2 / ${TIMELINE_DAYS * 2 + 2};">Out of service</div>`;
    }

    // Bookings for this car that touch the visible window
    state.bookings
      .filter(b => b.carId === car.id && b.startDate <= last && b.endDate >= first)
      .sort((a, b) => a.startDate.localeCompare(b.startDate))
      .forEach(b => {
        // Clip the bar to the visible window, measured in day-offsets from the anchor
        const startOffset = b.startDate < first ? 0 : Math.round((new Date(b.startDate) - days[0]) / 86400000);
        const endOffset = b.endDate > last ? TIMELINE_DAYS - 1 : Math.round((new Date(b.endDate) - days[0]) / 86400000);
        if (!(endOffset >= 0 && startOffset <= TIMELINE_DAYS - 1 && endOffset >= startOffset)) return;

        const s = bookingState(b);
        const span = endOffset - startOffset + 1;

        // Only show the pick-up / drop-off detail when the bar is wide enough
        // to read it; narrow bars keep just the name and rely on the tooltip.
        const showEnds = span >= 4;
        const startTxt = showEnds ? pickupLabel(b) : "";
        const endTxt = showEnds ? dropoffLabel(b) : "";
        const nameTxt = span >= 2 ? esc(b.renter || "") : "";

        const paidCls = b.paid ? "paid" : "unpaid";
        const title =
          `${b.renter}\n` +
          `Out: ${formatDate(b.startDate)} ${startTime(b)}${b.pickupLocation ? " · " + b.pickupLocation : ""}\n` +
          `Back: ${formatDate(b.endDate)} ${endTime(b)}${b.dropoffLocation ? " · " + b.dropoffLocation : ""}\n` +
          `${formatAmount(rentalTotal(b))} · ${b.paid ? "Paid" : "Unpaid"}` +
          (b.managedBy ? `\nManaged by ${b.managedBy}` : "") +
          (b.deliveredBy ? `\nDelivered by ${b.deliveredBy}` : "") +
          (b.notes ? `\nNote: ${b.notes}` : "");

        // Give up half a day at either end when another rental hands over
        // on the same date, so both are visible side by side.
        const clipStart = sharesStartHandover(b) && b.startDate >= first;
        const clipEnd = sharesEndHandover(b) && b.endDate <= last;
        const colStart = startOffset * 2 + 2 + (clipStart ? 1 : 0);
        const colEnd = endOffset * 2 + 4 - (clipEnd ? 1 : 0);

        html += `<div class="tl-bar ${s} ${paidCls}" data-booking="${b.id}" title="${esc(title)}"
          style="grid-row:${row};grid-column:${colStart} / ${colEnd};">
            ${startTxt ? `<span class="tl-bar-start">${esc(startTxt)}</span>` : ""}
            <span class="tl-bar-name">${b.paid ? "✓ " : ""}${nameTxt}</span>
            ${endTxt ? `<span class="tl-bar-end">${esc(endTxt)}</span>` : ""}
          </div>`;
      });
  });

  grid.innerHTML = html;
  wrap.scrollLeft = 0; // the window itself is already anchored near today

  // Legend, added once, directly after the timeline
  if (!root.querySelector(".tl-legend")) {
    const legend = document.createElement("div");
    legend.className = "tl-legend";
    legend.innerHTML = `
      <span><i class="tl-key active-b"></i> Out now</span>
      <span><i class="tl-key upcoming"></i> Booked ahead</span>
      <span><i class="tl-key overdue"></i> Overdue</span>
      <span><i class="tl-key oos"></i> Out of service</span>
      <span><i class="tl-key paid"></i> Paid</span>
      <span><i class="tl-key unpaid"></i> Unpaid</span>
      <span style="opacity:0.7;">Tap a booking to edit it, or an empty day to add one</span>`;
    wrap.insertAdjacentElement("afterend", legend);
  }
}

function renderCalendar() {
  const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  el(root, "cal-title").textContent = `${monthNames[calMonth]} ${calYear}`;

  const first = new Date(calYear, calMonth, 1);
  const startDow = (first.getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const t = todayStr();

  let html = ["Mo","Tu","We","Th","Fr","Sa","Su"].map(d => `<div class="cal-dow">${d}</div>`).join("");
  for (let i = 0; i < startDow; i++) html += `<div class="cal-day other-month"></div>`;

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const dayBookings = state.bookings.filter(b => b.status !== "completed" && b.startDate <= dateStr && dateStr <= b.endDate);
    const shown = dayBookings.slice(0, 2);
    const extra = dayBookings.length - shown.length;

    html += `
      <div class="cal-day${dateStr === t ? " today" : ""}">
        <div class="cal-day-num">${day}</div>
        ${shown.map(b => `<div class="cal-booking ${bookingState(b)}">${esc(b.renter)}</div>`).join("")}
        ${extra > 0 ? `<div class="cal-more">+${extra} more</div>` : ""}
        <div class="cal-dots">${dayBookings.slice(0, 4).map(b => `<div class="cal-dot ${bookingState(b)}"></div>`).join("")}</div>
      </div>`;
  }

  el(root, "calendar").innerHTML = html;
}

function renderList() {
  const search = el(root, "search").value.toLowerCase();

  let list = state.bookings.filter(b => {
    const s = bookingState(b);
    const mf = filter === "all" ? s !== "completed" : s === filter;
    const ms = `${bookingCarLabel(b)} ${b.renter || ""}`.toLowerCase().includes(search);
    return mf && ms;
  });

  const order = { overdue: 0, "active-b": 1, upcoming: 2, completed: 3 };
  list.sort((a, b) => (order[bookingState(a)] - order[bookingState(b)]) || a.startDate.localeCompare(b.startDate));

  const listEl = el(root, "list");
  if (list.length === 0) {
    listEl.innerHTML = '<div class="empty">No bookings here yet. Create one with the button above.</div>';
    return;
  }

  listEl.innerHTML = list.map(b => {
    const s = bookingState(b);
    return `
    <div class="item-card ${s}">
      <div class="card-top">
        <div>
          <div class="card-title">${esc(b.renter)}</div>
          <div class="card-sub">${esc(bookingCarLabel(b))}</div>
        </div>
        <span class="badge ${s}">${stateLabel(s)}</span>
      </div>
      <div class="card-details">
        <span>Out: <strong>${formatDate(b.startDate)} ${startTime(b)}</strong>${b.pickupLocation ? " · " + esc(b.pickupLocation) : ""}</span>
        <span>Back: <strong>${formatDate(b.endDate)} ${endTime(b)}</strong>${b.dropoffLocation ? " · " + esc(b.dropoffLocation) : ""}</span>
        <span>Total: <strong>${formatAmount(rentalTotal(b))}</strong> ${b.paid ? "(paid)" : "(unpaid)"}</span>
        ${b.phone ? `<span>Phone: <strong>${esc(b.phone)}</strong></span>` : ""}
      </div>
      ${(b.managedBy || b.deliveredBy || b.notes) ? `
      <div class="card-details">
        ${b.managedBy ? `<span>Managed by: <strong>${esc(b.managedBy)}</strong></span>` : ""}
        ${b.deliveredBy ? `<span>Delivered by: <strong>${esc(b.deliveredBy)}</strong></span>` : ""}
        ${b.notes ? `<span>Note: <strong>${esc(b.notes)}</strong></span>` : ""}
      </div>` : ""}
      <div class="card-actions">
        ${s !== "completed" ? `<button class="btn" data-act="complete" data-id="${b.id}">Mark returned</button>
        <button class="btn" data-act="edit" data-id="${b.id}">Edit</button>` : ""}
        <button class="btn danger" data-act="delete" data-id="${b.id}">Delete</button>
      </div>
    </div>`;
  }).join("");
}

// ---------- Create / edit ----------
function keepReturnAfterPickup() {
  const sd = val(root, "b-start"), st = val(root, "b-start-time");
  let ed = val(root, "b-end"), et = val(root, "b-end-time");
  if (!sd || !st) return;

  // Return date before pick-up: pull it up to the pick-up day
  if (ed && ed < sd) { setVal(root, "b-end", sd); ed = sd; }
  if (!ed) return;

  // Same day but the return time is not after the pick-up: push it later
  if (ed === sd && et && et <= st) {
    const [h, m] = st.split(":").map(Number);
    const later = h + 2 <= 23 ? `${String(h + 2).padStart(2, "0")}:${String(m).padStart(2, "0")}` : "23:59";
    setVal(root, "b-end-time", later);
  }
}

function toggleNewCustomer() {
  const v = el(root, "b-customer").value;
  el(root, "b-new-fields").style.display = v === "__new__" ? "block" : "none";
  el(root, "b-quick-fields").style.display = v === "__quick__" ? "block" : "none";
}

function openBookingModal(bookingId, preset) {
  if (state.cars.length === 0) { alert("Add at least one car in the Fleet view first."); return; }

  editingBookingId = bookingId || null;
  const editing = editingBookingId ? state.bookings.find(b => b.id === editingBookingId) : null;
  el(root, "booking-modal-title").textContent = editing ? "Edit booking" : "New booking";

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
  csel.value = state.customers.length ? csel.options[0].value : "__quick__";

  ["b-name","b-phone","b-email","b-quickname","b-start","b-end",
   "b-pickup","b-dropoff","b-total","b-managedby","b-deliveredby","b-notes"]
    .forEach(n => setVal(root, n, ""));
  // Sensible default times so staff only change them when it matters
  setVal(root, "b-start-time", "12:00");
  setVal(root, "b-end-time", "12:00");

  if (editing) {
    sel.value = editing.carId;
    setVal(root, "b-start", editing.startDate);
    setVal(root, "b-end", editing.endDate);
    setVal(root, "b-start-time", startTime(editing));
    setVal(root, "b-end-time", endTime(editing));
    setVal(root, "b-pickup", editing.pickupLocation || "");
    setVal(root, "b-dropoff", editing.dropoffLocation || "");
    setVal(root, "b-total", editing.totalPrice ?? "");
    setVal(root, "b-managedby", editing.managedBy || "");
    setVal(root, "b-deliveredby", editing.deliveredBy || "");
    setVal(root, "b-notes", editing.notes || "");
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

  toggleNewCustomer();
  showError(root, "booking-error", null);
  openModal(root, "booking-modal");
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
  const startTimeVal = val(root, "b-start-time") || "12:00";
  const endTimeVal = val(root, "b-end-time") || "12:00";
  const startAt = `${startDate}T${startTimeVal}`;
  const endAt = `${endDate}T${endTimeVal}`;

  if (endAt <= startAt) {
    showError(root, "booking-error", startDate === endDate
      ? `Same-day rental: the return time (${endTimeVal}) must be later than the pick-up time (${startTimeVal}).`
      : "The return must be after the pick-up. Check the dates and times.");
    return;
  }

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
      startTime: val(root, "b-start-time") || "12:00",
      endTime: val(root, "b-end-time") || "12:00",
      pickupLocation: val(root, "b-pickup"),
      dropoffLocation: val(root, "b-dropoff"),
      totalPrice: totalRaw === "" ? null : (parseFloat(totalRaw) || 0),
      managedBy: val(root, "b-managedby"),
      deliveredBy: val(root, "b-deliveredby"),
      notes: val(root, "b-notes")
    };

    if (editingBookingId) {
      await updateDoc(doc(db, "bookings", editingBookingId),
        { carId, customerId: customerId ?? null, renter, phone, startDate, endDate, dailyRate, carName, ...details });
    } else {
      await addDoc(collection(db, "bookings"), {
        companyId: state.ctx.companyId, carId, customerId: customerId ?? null, renter, phone,
        startDate, endDate, dailyRate, carName, ...details,
        paid: false, status: "open", createdAt: new Date().toISOString()
      });
    }
    closeModal(root, "booking-modal");
    editingBookingId = null;
  } catch (e) {
    showError(root, "booking-error", "Couldn't save the booking (" + (e.code || e.message) + ").");
    setSync("error");
  }
  btn.disabled = false; btn.textContent = "Save booking";
}

async function completeBooking(id) {
  setSync("saving");
  try { await updateDoc(doc(db, "bookings", id), { status: "completed" }); }
  catch (e) { alert("Couldn't update (" + (e.code || e.message) + ")."); setSync("error"); }
}

async function deleteBooking(id) {
  if (!confirm("Delete this booking?")) return;
  setSync("saving");
  try { await deleteDoc(doc(db, "bookings", id)); }
  catch (e) { alert("Couldn't delete (" + (e.code || e.message) + ")."); setSync("error"); }
}
