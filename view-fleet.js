// Fleet view — inventory with status derived from bookings.
import { db, setSync } from "./firebase-init.js";
import { collection, addDoc, updateDoc, deleteDoc, doc, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { loadXlsx } from "./backup.js";
import {
  state, onDataChange, esc, formatDate, todayStr, findClash, describeInterval,
  fillTimeOptions, getTime, setTime, onTimeChange,
  currentBooking, nextUpcoming, carStatus, serviceDue, openBookingsForCar,
  orderedCars, getSwatch, setSwatch,
  initPanelToggle,
  el, val, setVal, checked, setChecked, openModal, closeModal, showError,
  takeFocus, carLimit, carDocsDue
} from "./store.js";

let root = null;
let summaryOpen = () => true;   // set on mount; see initPanelToggle
let filter = "all";
let editingCarId = null;
let rentingCarId = null;

export function mount(container) {
  root = container;

  // The summary figures start closed so the working part of the view is
  // first on screen — the phone screens had almost nothing else visible.
  summaryOpen = initPanelToggle(root, "fleetShowSummary", "toggle-summary", "hide-summary", "Summary");

  el(root, "search").addEventListener("input", render);
  el(root, "sort").addEventListener("change", render);
  wireImport();
  el(root, "add-car").addEventListener("click", () => {
    // The plan's car limit is checked where a car would be added, in words a
    // desk can act on — not a silent failure, not a technical error.
    const limit = carLimit();
    if (limit && state.cars.length >= limit) {
      alert(
        `Your plan includes ${limit} car${limit === 1 ? "" : "s"}, and all ` +
        `${limit === 1 ? "of it is" : "of them are"} in use.\n\n` +
        `To add more cars, ask about upgrading your plan.`);
      return;
    }
    openCarModal(null);
  });
  el(root, "save-car").addEventListener("click", saveCar);

  el(root, "c-rowcolour").addEventListener("click", (e) => {
    const sw = e.target.closest(".swatch");
    if (!sw) return;
    e.preventDefault();
    setSwatch(root, "c-rowcolour", sw.dataset.colour);
  });
  el(root, "confirm-rent").addEventListener("click", confirmRent);
  fillTimeOptions(root, "r-start-time");
  fillTimeOptions(root, "r-end-time");
  el(root, "r-customer").addEventListener("change", toggleRentNewCustomer);

  el(root, "r-date").addEventListener("change", keepRentReturnAfterPickup);
  onTimeChange(root, "r-start-time", keepRentReturnAfterPickup);
  onTimeChange(root, "r-end-time", keepRentReturnAfterPickup);

  // Rate auto-calculation
  const rd = el(root, "c-rate"), rw = el(root, "c-rate-week"), rm = el(root, "c-rate-month");
  const r2 = x => Math.round(x * 100) / 100;

  // Typing directly into the weekly or monthly box marks it as deliberate, so
  // later edits to the daily rate leave that figure alone. Clearing it hands
  // control back to the automatic calculation.
  rw.addEventListener("input", () => { rw.dataset.manual = rw.value.trim() ? "1" : ""; });
  rm.addEventListener("input", () => { rm.dataset.manual = rm.value.trim() ? "1" : ""; });

  rd.addEventListener("input", () => {
    const v = parseFloat(rd.value);
    if (isNaN(v)) return;
    if (!rw.dataset.manual) rw.value = r2(v * 7);
    if (!rm.dataset.manual) rm.value = r2(v * 30);
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
    if (btn.dataset.act === "rent") openRentModal(id);
    else if (btn.dataset.act === "return") markReturned(id);
    else if (btn.dataset.act === "editcar") openCarModal(id);
    else if (btn.dataset.act === "remove") removeCar(id);
  });

  onDataChange(() => { if (root.classList.contains("active")) render(); });
}

export function render() {
  if (!root) return;

  // Arriving from a planner: clear whatever was filtered or searched, or the car
  // being jumped to might not be in the list at all and the jump would silently
  // do nothing.
  const focusId = takeFocus("fleet");
  if (focusId) {
    setVal(root, "search", "");
    filter = "all";
    el(root, "filters").querySelectorAll(".tab").forEach(x =>
      x.classList.toggle("active", x.dataset.f === "all"));
  }

  const search = el(root, "search").value.toLowerCase();
  const sort = el(root, "sort").value;

  const withStatus = orderedCars().map(c => ({ ...c, _status: carStatus(c), _booking: currentBooking(c.id) }));
  const available = withStatus.filter(c => c._status === "available").length;
  const service = withStatus.filter(c => c._status === "service").length;
  const rented = withStatus.filter(c => c._status === "rented" || c._status === "overdue").length;

  if (summaryOpen()) el(root, "stats").innerHTML = `
    <div class="stat"><div class="stat-label">Total cars</div><div class="stat-val">${state.cars.length}${carLimit() ? `<span style="font-size:0.45em;color:${state.cars.length >= carLimit() ? "var(--red-text)" : "var(--muted)"};"> of ${carLimit()} on plan</span>` : ""}</div></div>
    <div class="stat"><div class="stat-label">Available</div><div class="stat-val green">${available}</div></div>
    <div class="stat"><div class="stat-label">Rented out</div><div class="stat-val amber">${rented}</div></div>
    <div class="stat"><div class="stat-label">Out of service</div><div class="stat-val red">${service}</div></div>
  `;

  let list = withStatus.filter(c => {
    const status = c._status === "overdue" ? "rented" : c._status;
    const mf = filter === "all" || status === filter;
    const renterName = c._booking ? c._booking.renter : "";
    const ms = `${c.make} ${c.model} ${c.plate} ${c.category || ""} ${c.colour || ""} ${renterName}`.toLowerCase().includes(search);
    return mf && ms;
  });

  // "custom" keeps the planner order that orderedCars() already applied
  if (sort === "name") list.sort((a, b) => (a.make + a.model).localeCompare(b.make + b.model));
  else if (sort === "status") list.sort((a, b) => a._status.localeCompare(b._status));

  const listEl = el(root, "list");
  if (list.length === 0) {
    listEl.innerHTML = '<div class="empty">No cars found. Add your first car with the button above.</div>';
    return;
  }

  listEl.innerHTML = list.map(c => {
    const s = c._status;
    const b = c._booking;
    const up = s === "available" ? nextUpcoming(c.id) : null;
    const cls = s === "service" ? "overdue" : s;
    return `
    <div class="item-card ${cls}" data-car-id="${c.id}">
      <div class="card-top">
        <div>
          <div class="card-title">${esc(c.year)} ${esc(c.make)} ${esc(c.model)}</div>
          <div class="card-sub">${esc(c.plate)}${c.category ? " · " + esc(c.category) : ""}${c.colour ? " · " + esc(c.colour) : ""}${c.automatic ? " · auto" : ""}${c.dailyRate ? " · " + esc(c.dailyRate) + "/day" : ""}</div>
        </div>
        <span class="badge ${cls}">${s === "available" ? "Available" : s === "overdue" ? "Overdue" : s === "service" ? "Out of service" : "Rented"}</span>
      </div>
      ${serviceDue(c) && s !== "service" ? `<div class="card-details" style="border-top:none;padding-top:0;margin-top:6px;"><span style="color:var(--amber-text);">⚠ Service due ${formatDate(c.nextServiceDate)}</span></div>` : ""}
      ${(() => {
        const due = carDocsDue(c);
        if (!due.length) return "";
        return `<div class="card-details" style="border-top:none;padding-top:0;margin-top:6px;">` +
          due.map(d => `<span style="color:${d.expired ? "var(--red-text)" : "var(--amber-text)"};">⚠ ${esc(d.label)} ${d.expired ? "expired" : "expires"} ${formatDate(d.date)}</span>`).join(" ") +
          `</div>`;
      })()}
      ${(c.weeklyRate || c.monthlyRate) ? `
      <div class="card-details" style="border-top:none;padding-top:0;margin-top:6px;">
        <span>Rates: <strong>${esc(c.dailyRate || 0)}</strong>/day · <strong>${esc(c.weeklyRate || 0)}</strong>/week · <strong>${esc(c.monthlyRate || 0)}</strong>/month</span>
      </div>` : ""}
      ${b ? `
      <div class="card-details">
        <span>Renter: <strong>${esc(b.renter) || "—"}</strong></span>
        <span>Phone: <strong>${esc(b.phone) || "—"}</strong></span>
        <span>Return: <strong>${formatDate(b.endDate)}</strong></span>
      </div>` : up ? `
      <div class="card-details">
        <span>Next booking: <strong>${formatDate(up.startDate)}</strong> (${esc(up.renter)})</span>
      </div>` : ""}
      <div class="card-actions">
        ${s === "available"
          ? `<button class="btn" data-act="rent" data-id="${c.id}">Rent out now</button>`
          : s === "service" ? ""
          : `<button class="btn" data-act="return" data-id="${c.id}">Mark as returned</button>`}
        <button class="btn" data-act="editcar" data-id="${c.id}">Edit</button>
        <button class="btn danger" data-act="remove" data-id="${c.id}">Remove</button>
      </div>
    </div>`;
  }).join("");

  if (focusId) revealCar(focusId);
}

// Brings one vehicle into view and marks it briefly, so it is obvious which of
// twenty near-identical cards was meant. The mark fades on its own — a card that
// stayed highlighted would be puzzling on the next visit.
function revealCar(id) {
  const card = el(root, "list").querySelector(`[data-car-id="${id}"]`);
  if (!card) return;

  card.classList.add("just-focused");
  setTimeout(() => card.classList.remove("just-focused"), 2600);

  // Deferred deliberately. Switching view renders the page and then sends it back
  // to the top — sensible for every normal navigation, but it landed immediately
  // after this scroll and cancelled it, so the card was outlined somewhere far
  // down a page still sitting at the top. Waiting a tick puts this second.
  setTimeout(() => {
    const still = el(root, "list").querySelector(`[data-car-id="${id}"]`);
    if (still) still.scrollIntoView({ block: "center", behavior: "smooth" });
  }, 0);
}

// ---------- Import from a spreadsheet ----------
// A fleet arrives as the company already keeps it: an Excel or CSV list. The
// file is read in the browser, matched by forgiving header names, previewed
// with every problem named, and written only when Import is pressed. Same
// library the backup uses, so backup files import cleanly — which is also a
// fleet restore.
const IMPORT_FIELDS = [
  { key: "make", heads: ["make", "brand", "marque"] },
  { key: "model", heads: ["model", "modele"] },
  { key: "year", heads: ["year", "annee", "yr"] },
  { key: "plate", heads: ["plate", "registration", "regno", "reg", "plateno", "numberplate", "immatriculation"] },
  { key: "dailyRate", heads: ["dailyrate", "daily", "rateday", "priceday", "dayrate", "rate"] },
  { key: "weeklyRate", heads: ["weeklyrate", "weekly", "weekrate"] },
  { key: "monthlyRate", heads: ["monthlyrate", "monthly", "monthrate"] },
  { key: "category", heads: ["category", "class", "type", "categorie"] },
  { key: "colour", heads: ["colour", "color"] },
  { key: "mileage", heads: ["mileage", "km", "odometer", "kilometrage"] },
  { key: "regDate", heads: ["registrationdate", "regdate", "firstregistration"] },
  { key: "licenceExpiry", heads: ["licenceexpiry", "licenseexpiry", "licence", "license"] },
  { key: "roadTaxExpiry", heads: ["roadtaxexpiry", "roadtax", "tax"] },
  { key: "insuranceExpiry", heads: ["insuranceexpiry", "insurance"] },
  { key: "fitnessExpiry", heads: ["fitnessexpiry", "fitness"] },
  { key: "leaseExpiry", heads: ["leaseexpiry", "lease"] }
];
const NUM_FIELDS = new Set(["dailyRate", "weeklyRate", "monthlyRate", "mileage"]);
const DATE_FIELDS = new Set(["regDate", "licenceExpiry", "roadTaxExpiry", "insuranceExpiry", "fitnessExpiry", "leaseExpiry"]);

let importReady = [];

function normHead(v) {
  return String(v || "").toLowerCase().replace(/[^a-z]/g, "");
}

function normPlate(v) {
  return String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Excel keeps dates as serial numbers as often as text; both become
// YYYY-MM-DD, and anything unreadable is simply left blank.
function toDateStr(v) {
  if (v == null || v === "") return "";
  if (typeof v === "number" && v > 20000 && v < 80000) {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return d.toISOString().slice(0, 10);
  }
  const t = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = t.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (m) {
    const yy = m[3].length === 2 ? "20" + m[3] : m[3];
    return `${yy}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return "";
}

function wireImport() {
  const btn = el(root, "import-cars");
  const file = el(root, "import-file");
  if (!btn || !file) return;

  btn.addEventListener("click", () => { file.value = ""; file.click(); });
  file.addEventListener("change", async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    try {
      const XLSX = await loadXlsx();
      const wb = XLSX.read(await f.arrayBuffer());
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
      buildImportPreview(rows);
    } catch (e) {
      importReady = [];
      el(root, "import-summary").textContent = "";
      el(root, "import-list").innerHTML = "";
      el(root, "import-go").disabled = true;
      showError(root, "import-error", "Couldn't read that file (" + (e.message || e) + "). Save it as .xlsx or .csv and try again.");
      openModal(root, "import-modal");
    }
  });

  el(root, "import-go").addEventListener("click", doImport);
}

function buildImportPreview(rows) {
  showError(root, "import-error", null);

  // The header row is the first row that matches at least make or model.
  let headRow = -1, colMap = {};
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const map = {};
    rows[i].forEach((cell, c) => {
      const n = normHead(cell);
      if (!n) return;
      IMPORT_FIELDS.forEach(f => { if (f.heads.includes(n) && !(f.key in map)) map[f.key] = c; });
    });
    if ("make" in map && "model" in map) { headRow = i; colMap = map; break; }
  }

  if (headRow === -1) {
    importReady = [];
    el(root, "import-summary").textContent = "";
    el(root, "import-list").innerHTML = "";
    el(root, "import-go").disabled = true;
    showError(root, "import-error",
      'No header row found. The sheet needs column titles — at least "Make" and "Model".');
    openModal(root, "import-modal");
    return;
  }

  const existingPlates = new Set(state.cars.map(c => normPlate(c.plate)).filter(Boolean));
  const seenPlates = new Set();
  const ok = [];
  const skipped = [];

  rows.slice(headRow + 1).forEach((r, idx) => {
    if (r.every(c => String(c).trim() === "")) return;
    const rowNo = headRow + idx + 2;
    const car = {};
    Object.entries(colMap).forEach(([key, c]) => {
      let v = r[c];
      if (NUM_FIELDS.has(key)) { v = parseFloat(v); v = Number.isFinite(v) ? v : 0; }
      else if (DATE_FIELDS.has(key)) v = toDateStr(v);
      else if (key === "year") { const y = parseInt(v); v = Number.isFinite(y) ? String(y) : String(v || "").trim(); }
      else v = String(v || "").trim();
      car[key] = v;
    });
    if (!car.make || !car.model) { skipped.push({ rowNo, why: "missing make or model" }); return; }
    const p = normPlate(car.plate);
    if (p && existingPlates.has(p)) { skipped.push({ rowNo, why: `plate ${car.plate} already in your fleet` }); return; }
    if (p && seenPlates.has(p)) { skipped.push({ rowNo, why: `plate ${car.plate} appears twice in the file` }); return; }
    if (p) seenPlates.add(p);
    ok.push(car);
  });

  const limit = carLimit();
  let limitNote = "";
  if (limit && state.cars.length + ok.length > limit) {
    el(root, "import-go").disabled = true;
    limitNote = ` Your plan includes ${limit} cars and you have ${state.cars.length} — this import would need ${state.cars.length + ok.length}. Reduce the file or ask about upgrading.`;
  } else {
    el(root, "import-go").disabled = ok.length === 0;
  }

  importReady = ok;
  el(root, "import-summary").textContent =
    `${ok.length} car${ok.length === 1 ? "" : "s"} ready to import` +
    (skipped.length ? ` · ${skipped.length} row${skipped.length === 1 ? "" : "s"} will be skipped` : "") +
    `.${limitNote}`;

  el(root, "import-list").innerHTML =
    ok.map(c => `<div class="jd-row"><span class="jd-v">${esc(`${c.year || ""} ${c.make} ${c.model}`.trim())}` +
      `${c.plate ? ` (${esc(c.plate)})` : " — no plate"}` +
      `${c.dailyRate ? ` · ${esc(String(c.dailyRate))}/day` : ""}</span></div>`).join("") +
    (skipped.length ? `<p style="margin:10px 0 4px;color:var(--muted);font-size:12px;">Skipped:</p>` +
      skipped.map(x => `<div class="jd-row"><span class="jd-v" style="color:var(--muted);">Row ${x.rowNo} — ${esc(x.why)}</span></div>`).join("") : "");

  openModal(root, "import-modal");
}

async function doImport() {
  if (!importReady.length) return;
  const btn = el(root, "import-go");
  btn.disabled = true; btn.textContent = "Importing...";
  setSync("saving");
  // Firestore caps a batch at 500 writes, so a big file goes in chunks. A
  // normal import fits one chunk and stays all-or-nothing exactly as before;
  // a huge one commits chunk by chunk, and if a later chunk fails the message
  // says how many cars did arrive rather than pretending nothing happened.
  const CHUNK = 450;
  let written = 0;
  try {
    for (let i = 0; i < importReady.length; i += CHUNK) {
      const batch = writeBatch(db);
      importReady.slice(i, i + CHUNK).forEach(c => {
        batch.set(doc(collection(db, "cars")), {
          companyId: state.ctx.companyId,
          automatic: false, rowColour: "",
          ...c,
          // Rates after the spread: an empty Weekly/Monthly column in the file
          // must not zero out the 7x/30x defaults computed from the daily rate.
          weeklyRate: c.weeklyRate || (c.dailyRate ? c.dailyRate * 7 : 0),
          monthlyRate: c.monthlyRate || (c.dailyRate ? c.dailyRate * 30 : 0)
        });
      });
      await batch.commit();
      written += Math.min(CHUNK, importReady.length - i);
    }
    closeModal(root, "import-modal");
    importReady = [];
  } catch (e) {
    if (written === 0) {
      showError(root, "import-error",
        "Import failed (" + (e.code || e.message) + "). Nothing was added — try again.");
    } else {
      // Some chunks landed. Leaving the list armed meant pressing Import again
      // would write the successful chunk a second time, so the list is cleared
      // (doImport refuses an empty list) and the file has to be picked again —
      // its preview then skips the plates that already arrived, so only the
      // missing cars import.
      const total = importReady.length;
      importReady = [];
      showError(root, "import-error",
        `Import stopped partway (${e.code || e.message}). ${written} of ${total} cars were added. ` +
        `Choose the file again — the preview will skip the ones already in your fleet and import the rest.`);
    }
    setSync("error");
  }
  btn.disabled = false; btn.textContent = "Import";
}

// ---------- Car add / edit ----------
function openCarModal(id) {
  editingCarId = id;
  const c = id ? state.cars.find(x => x.id === id) : null;
  el(root, "car-modal-title").textContent = c ? "Edit car" : "Add new car";
  setVal(root, "c-make", c?.make);
  setVal(root, "c-model", c?.model);
  setVal(root, "c-year", c?.year);
  setVal(root, "c-plate", c?.plate);
  setVal(root, "c-rate", c?.dailyRate);
  setVal(root, "c-rate-week", c?.weeklyRate);
  setVal(root, "c-rate-month", c?.monthlyRate);
  setVal(root, "c-category", c?.category || "");
  setVal(root, "c-colour", c?.colour || "");
  setVal(root, "c-regdate", c?.regDate || "");
  setVal(root, "c-licence-exp", c?.licenceExpiry || "");
  setVal(root, "c-roadtax-exp", c?.roadTaxExpiry || "");
  setVal(root, "c-insurance-exp", c?.insuranceExpiry || "");
  setVal(root, "c-fitness-exp", c?.fitnessExpiry || "");
  setVal(root, "c-lease-exp", c?.leaseExpiry || "");
  setChecked(root, "c-automatic", c?.automatic === true);
  setSwatch(root, "c-rowcolour", c?.rowColour || "");

  // Treat an existing car's weekly/monthly figures as deliberate, so changing
  // the daily rate later will not silently overwrite them.
  el(root, "c-rate-week").dataset.manual = c?.weeklyRate ? "1" : "";
  el(root, "c-rate-month").dataset.manual = c?.monthlyRate ? "1" : "";
  openModal(root, "car-modal");
}

async function saveCar() {
  // Checked again at save, not only at the button: another device may have
  // added a car while this form was open, and the limit may have changed.
  {
    const limit = carLimit();
    if (!editingCarId && limit && state.cars.length >= limit) {
      alert(`Your plan includes ${limit} cars and they are all in use. To add more, ask about upgrading your plan.`);
      return;
    }
  }
  const make = val(root, "c-make");
  const model = val(root, "c-model");
  if (!make || !model) { alert("Please enter at least a make and model."); return; }

  const year = val(root, "c-year");
  const plate = val(root, "c-plate");
  let dailyRate = parseFloat(val(root, "c-rate")) || 0;
  const weeklyIn = parseFloat(val(root, "c-rate-week")) || 0;
  const monthlyIn = parseFloat(val(root, "c-rate-month")) || 0;
  if (!dailyRate && weeklyIn) dailyRate = Math.round((weeklyIn / 7) * 100) / 100;
  if (!dailyRate && monthlyIn) dailyRate = Math.round((monthlyIn / 30) * 100) / 100;
  const weeklyRate = weeklyIn || Math.round(dailyRate * 7 * 100) / 100;
  const monthlyRate = monthlyIn || Math.round(dailyRate * 30 * 100) / 100;
  const category = val(root, "c-category");
  const colour = val(root, "c-colour");
  const docDates = {
    regDate: val(root, "c-regdate") || "",
    licenceExpiry: val(root, "c-licence-exp") || "",
    roadTaxExpiry: val(root, "c-roadtax-exp") || "",
    insuranceExpiry: val(root, "c-insurance-exp") || "",
    fitnessExpiry: val(root, "c-fitness-exp") || "",
    leaseExpiry: val(root, "c-lease-exp") || ""
  };
  const automatic = checked(root, "c-automatic");
  const rowColour = getSwatch(root, "c-rowcolour");

  const btn = el(root, "save-car");
  btn.disabled = true; btn.textContent = "Saving...";
  setSync("saving");
  try {
    if (editingCarId) {
      await updateDoc(doc(db, "cars", editingCarId), { make, model, year, plate, dailyRate, weeklyRate, monthlyRate, category, colour, automatic, rowColour, ...docDates });
    } else {
      await addDoc(collection(db, "cars"), {
        companyId: state.ctx.companyId, make, model, year, plate,
        dailyRate, weeklyRate, monthlyRate, category, colour, automatic, rowColour, ...docDates
      });
    }
    closeModal(root, "car-modal");
    editingCarId = null;
  } catch (e) {
    alert("Couldn't save the car (" + (e.code || e.message) + "). Try again.");
    setSync("error");
  }
  btn.disabled = false; btn.textContent = "Save car";
}

async function removeCar(id) {
  const open = openBookingsForCar(id);
  if (open.length > 0) {
    alert(
      `This car has ${open.length} booking(s) that aren't finished yet.\n\n` +
      "Mark them returned (or delete them) on the Bookings view before removing the car."
    );
    return;
  }
  const past = state.bookings.filter(b => b.carId === id).length;
  const msg = past > 0
    ? `Remove this car from the fleet?\n\nIts ${past} past rental(s) stay in Billing and customer history, listed as "removed from fleet".`
    : "Remove this car from the fleet?";
  if (!confirm(msg)) return;
  setSync("saving");
  try { await deleteDoc(doc(db, "cars", id)); }
  catch (e) { alert("Couldn't remove (" + (e.code || e.message) + ")."); setSync("error"); }
}

// ---------- Walk-in rental ----------
// A walk-in starts now, so a same-day return needs a time later than now.
// Adjust the return rather than making the user work the rule out from an error.
function keepRentReturnAfterPickup() {
  const today = todayStr();
  const st = getTime(root, "r-start-time");
  let ed = val(root, "r-date"), et = getTime(root, "r-end-time");
  if (!st) return;

  if (ed && ed < today) { setVal(root, "r-date", today); ed = today; }
  if (!ed) return;

  if (ed === today && et && et <= st) {
    const [h, m] = st.split(":").map(Number);
    const later = h + 2 <= 23 ? `${String(h + 2).padStart(2, "0")}:${String(m).padStart(2, "0")}` : "23:59";
    setTime(root, "r-end-time", later);
  }
}

function toggleRentNewCustomer() {
  const isNew = el(root, "r-customer").value === "__new__";
  el(root, "r-new-fields").style.display = isNew ? "block" : "none";
}

function openRentModal(carId) {
  const car = state.cars.find(x => x.id === carId);
  if (car && car.outOfService) {
    alert("This car is out of service. Put it back in service on the Maintenance view before renting it out.");
    return;
  }
  rentingCarId = carId;

  const csel = el(root, "r-customer");
  csel.innerHTML = state.customers
    .slice().sort((a, b) => a.name.localeCompare(b.name))
    .map(c => `<option value="${c.id}">${esc(c.name)}${c.phone ? " · " + esc(c.phone) : ""}</option>`)
    .join("") + `<option value="__new__">+ New customer...</option>`;
  csel.value = state.customers.length ? csel.options[0].value : "__new__";
  toggleRentNewCustomer();

  ["r-name", "r-phone", "r-email", "r-date", "r-pickup", "r-dropoff"].forEach(n => setVal(root, n, ""));
  // A walk-in is happening now, so default the pick-up time to the current
  // time rather than midday — this matters for same-day turnarounds.
  const now = new Date();
  // Round the current time down to the nearest five minutes so it matches the
  // options offered in the dropdown.
  const mins = Math.floor(now.getMinutes() / 5) * 5;
  setTime(root, "r-start-time", `${String(now.getHours()).padStart(2,"0")}:${String(mins).padStart(2,"0")}`);
  setTime(root, "r-end-time", "12:00");
  showError(root, "rent-error", null);
  openModal(root, "rent-modal");
}

async function confirmRent() {
  if (!rentingCarId) return;
  showError(root, "rent-error", null);

  const startDate = todayStr();
  const endDate = val(root, "r-date");
  const choice = el(root, "r-customer").value;

  let customerId, renter, phone, email;
  if (choice === "__new__") {
    renter = val(root, "r-name");
    phone = val(root, "r-phone");
    email = val(root, "r-email");
    if (!renter) { showError(root, "rent-error", "Enter the customer's name."); return; }
  } else {
    const c = state.customers.find(x => x.id === choice);
    if (!c) { showError(root, "rent-error", "Pick a customer."); return; }
    customerId = c.id; renter = c.name; phone = c.phone || "";
  }

  if (!endDate) { showError(root, "rent-error", "Choose a return date."); return; }

  const startTimeVal = getTime(root, "r-start-time") || "12:00";
  const endTimeVal = getTime(root, "r-end-time") || "12:00";
  const startAt = `${startDate}T${startTimeVal}`;
  const endAt = `${endDate}T${endTimeVal}`;

  if (endAt <= startAt) {
    showError(root, "rent-error", startDate === endDate
      ? `Same-day rental: the return time (${endTimeVal}) must be later than the pick-up time (${startTimeVal}).`
      : "The return must be after the pick-up. Check the date and time.");
    return;
  }

  const clash = findClash({ carId: rentingCarId, startAt, endAt });
  if (clash) {
    showError(root, "rent-error",
      `This car is already out ${describeInterval(clash)} (${clash.renter}). ` +
      `Choose an earlier return, or another car.`);
    return;
  }

  const btn = el(root, "confirm-rent");
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
    const car = state.cars.find(x => x.id === rentingCarId);
    await addDoc(collection(db, "bookings"), {
      companyId: state.ctx.companyId, carId: rentingCarId, customerId, renter, phone,
      startDate, endDate, dailyRate: car?.dailyRate || 0, paid: false,
      carName: car ? `${car.year || ""} ${car.make} ${car.model} (${car.plate || "no plate"})`.trim() : "",
      // Walk-ins default to midday; times and locations can be refined on the
      // Bookings view if the company needs them recorded precisely.
      startTime: startTimeVal, endTime: endTimeVal,
      pickupLocation: val(root, "r-pickup"), dropoffLocation: val(root, "r-dropoff"),
      totalPrice: null, managedBy: "", deliveredBy: "", notes: "",
      status: "open", createdAt: new Date().toISOString()
    });
    closeModal(root, "rent-modal");
    rentingCarId = null;
  } catch (e) {
    showError(root, "rent-error", "Couldn't save the rental (" + (e.code || e.message) + ").");
    setSync("error");
  }
  btn.disabled = false; btn.textContent = "Confirm rental";
}

async function markReturned(carId) {
  const b = currentBooking(carId);
  if (!b) return;
  setSync("saving");
  try { await updateDoc(doc(db, "bookings", b.id), { status: "completed" }); }
  catch (e) { alert("Couldn't update (" + (e.code || e.message) + ")."); setSync("error"); }
}
