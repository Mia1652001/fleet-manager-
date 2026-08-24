// Fleet view — inventory with status derived from bookings.
import { db, setSync } from "./firebase-init.js";
import { collection, addDoc, updateDoc, deleteDoc, doc, writeBatch , arrayUnion } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { loadXlsx } from "./backup.js";
import {
  state, onDataChange, esc, formatDate, formatAmount, todayStr, describeInterval,
  getTime, setTime,
  currentBooking, nextUpcoming, carStatus, serviceDue, openBookingsForCar,
  orderedCars, getSwatch, setSwatch,
  el, val, setVal, checked, setChecked, openModal, closeModal, showError,
  takeFocus, carLimit, carDocsDue
, allEntities, entityForCar, carCustomFields } from "./store.js";

let root = null;
// A one-shot focus handed over from a Dashboard chip: "docs" shows only cars
// with documents expired or expiring within 30 days; "service" only cars due.
let fleetFocus = null;
export function setFleetFocus(kind) { fleetFocus = kind || null; }

let editingCarId = null;

export function mount(container) {
  root = container;

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
    // The + is a label wrapping a real colour input — the click itself opens
    // the native picker. Same fix as the booking form, same original sin.
    if (e.target.closest(".swatch-add")) return;
    const sw = e.target.closest(".swatch");
    if (!sw) return;
    e.preventDefault();
    setSwatch(root, "c-rowcolour", sw.dataset.colour);
  });
  el(root, "c-rowcolour").addEventListener("change", async (e) => {
    const pick = e.target.closest(".swatch-pick");
    if (!pick) return;
    const hex = String(pick.value || "").toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(hex)) return;
    paintCarColourSwatches(hex);
    setSwatch(root, "c-rowcolour", hex);
    try {
      await updateDoc(doc(db, "settings", state.ctx.companyId),
        { companyId: state.ctx.companyId, plannerColours: arrayUnion(hex) });
    } catch (err) { console.warn("Could not save the colour", err); }
  });

  // Rate auto-calculation removed at the pilot's request (Aug 2026): typing a
  // daily rate used to fill weekly and monthly in automatically, and saving a
  // car with only a daily rate silently stored all three. All three rates are
  // now exactly what was typed — a blank stays blank.

  root.querySelectorAll("[data-close]").forEach(b =>
    b.addEventListener("click", () => closeModal(root, b.dataset.close)));
  root.querySelectorAll(".overlay").forEach(o =>
    o.addEventListener("click", e => { if (e.target === o) o.classList.remove("open"); }));

  el(root, "list").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (btn) {
      const id = btn.dataset.id;
      if (btn.dataset.act === "editcar") openCarModal(id);
      else if (btn.dataset.act === "remove") removeCar(id);
      return;
    }
    // Tapping anywhere else on the card opens the record — the gesture the
    // pilot's other tools have taught. The inline cells stay inline: a tap
    // on a field is editing, not opening.
    if (e.target.closest("input, select, textarea, a")) return;
    const card = e.target.closest("[data-car-id]");
    if (card) openCarModal(card.dataset.carId);
  });

  // Autosave for the inline cells: the moment a field is left (or a date is
  // picked), that one value is written. Nothing else on the car is touched,
  // so two people editing different fields of the same car cannot overwrite
  // each other.
  el(root, "list").addEventListener("change", async (e) => {
    const inp = e.target.closest(".car-cell");
    if (!inp) return;
    const { id, field, kind } = inp.dataset;
    let value;
    if (kind === "date") value = inp.value || "";
    else if (kind === "text") value = inp.value.trim();
    else if (kind === "numnull") {
      const n = parseFloat(inp.value);
      value = Number.isFinite(n) && n >= 0 && inp.value !== "" ? n : null;
    } else {
      const n = parseFloat(inp.value);
      value = Number.isFinite(n) && n >= 0 ? n : 0;
    }
    setSync("saving");
    try {
      await updateDoc(doc(db, "cars", id), { [field]: value });
    } catch (err) {
      setSync("error");
      alert("Couldn't save that value (" + (err.code || err.message) + "). It has been put back.");
      render();
    }
  });

  {
    // guarded: a missing banner must degrade to a missing feature, never to
    // a boot crash on the login screen (24 Aug — misplaced markup did exactly
    // that; the guard makes the whole class impossible)
    const ff = el(root, "fleet-focus");
    if (ff) ff.addEventListener("click", (e) => {
      if (!e.target.closest("[data-el='fleet-focus-clear']")) return;
      fleetFocus = null;
      render();
    });
  }

  onDataChange(() => { if (root.classList.contains("active")) render(); });
}

export function render() {
  if (!root) return;

  // Someone is typing straight into a card — a snapshot arriving now (very
  // often the echo of their own last cell save) must not rebuild the list
  // under their cursor. The next change after they leave the field repaints.
  const active = document.activeElement;
  if (active && active.classList?.contains("car-cell") && root.contains(active)) return;

  // Arriving from a planner: clear the search, or the car being jumped to
  // might not be in the list at all and the jump would silently do nothing.
  const focusId = takeFocus("fleet");
  if (focusId) setVal(root, "search", "");

  const search = el(root, "search").value.toLowerCase();
  const sort = el(root, "sort").value;


  // The fleet page is the vehicle register now — what each car is, what it
  // costs, which papers expire when. Who is in a car today, and until when,
  // lives on the planner and nowhere else (pilot request, Aug 2026): the same
  // fact kept on two screens is the fact that ends up contradicting itself.
  let list = orderedCars().filter(c =>
    `${c.make} ${c.model} ${c.plate} ${c.category || ""} ${c.colour || ""}`.toLowerCase().includes(search));

  // "custom" keeps the planner order that orderedCars() already applied
  if (sort === "name") list.sort((a, b) => (a.make + a.model).localeCompare(b.make + b.model));

  const listEl = el(root, "list");
  if (list.length === 0) {
    listEl.innerHTML = '<div class="empty">No cars found. Add your first car with the button above.</div>';
    return;
  }

  const t = todayStr();
  const soonD = new Date(t + "T12:00");
  soonD.setDate(soonD.getDate() + 30);
  const soon = `${soonD.getFullYear()}-${String(soonD.getMonth() + 1).padStart(2, "0")}-${String(soonD.getDate()).padStart(2, "0")}`;

  // Every figure is typed straight into the card and saved the moment the
  // field is left — no Edit dialog for the numbers the office updates all
  // year (pilot request, Aug 2026). The Edit button remains for identity:
  // make, model, plate, colour, planner highlight.
  const dateCell = (c, field, label, isExpiry = true) => {
    const v = c[field] || "";
    // Registered is history, not a deadline — it never colours (pilot, 23 Aug).
    const cls = !isExpiry || !v ? "" : v < t ? " car-cell-red" : v <= soon ? " car-cell-amber" : "";
    return `<div class="car-row${cls}"><span class="car-row-l">${label}</span>
      <input type="date" class="car-cell" data-id="${c.id}" data-field="${field}" data-kind="date" value="${esc(v)}"></div>`;
  };
  const textCell = (c, field, ph) =>
    `<input type="text" class="car-cell" data-id="${c.id}" data-field="${field}" data-kind="text"
       value="${esc(c[field] || "")}" placeholder="${ph}">`;
  const numCell = (c, field, kind, ph) =>
    `<input type="number" min="0" class="car-cell car-cell-num" data-id="${c.id}" data-field="${field}" data-kind="${kind}"
       value="${typeof c[field] === "number" && (kind === "numnull" ? true : c[field] > 0) ? esc(c[field]) : ""}" placeholder="${ph}">`;

  {
    const banner = el(root, "fleet-focus");
    if (fleetFocus) {
      const d2 = new Date(); d2.setDate(d2.getDate() + 30);
      const soon2 = `${d2.getFullYear()}-${String(d2.getMonth() + 1).padStart(2, "0")}-${String(d2.getDate()).padStart(2, "0")}`;
      const DOCS = ["licenceExpiry", "roadTaxExpiry", "insuranceExpiry", "fitnessExpiry", "leaseExpiry"];
      if (fleetFocus === "docs") {
        list = list.filter(c => DOCS.some(f => c[f] && c[f] <= soon2));
      } else if (fleetFocus === "service") {
        list = list.filter(c => serviceDue(c));
      }
      if (banner) {
        banner.style.display = "";
        banner.innerHTML = `Showing ${list.length} car${list.length === 1 ? "" : "s"} ${
          fleetFocus === "docs" ? "with documents expired or expiring within 30 days" : "due a service"}
          <button type="button" class="btn btn-small" data-el="fleet-focus-clear">Show all</button>`;
      }
    } else if (banner) { banner.style.display = "none"; }
  }
  listEl.innerHTML = list.map(c => `
    <div class="item-card car-compact ${c.outOfService ? "overdue" : ""}" data-car-id="${c.id}">
      <div class="card-top">
        <div>
          <div class="card-title">${esc(c.make)} ${esc(c.model)}</div>
          <div class="card-sub">${esc(c.plate) || "no plate"}${c.category ? " · " + esc(c.category) : ""}${c.colour ? " · " + esc(c.colour) : ""}${c.automatic ? " · auto" : ""}${c.entityId ? ` · <span class="car-ent">${esc(entityForCar(c).name)}</span>` : ""}${
  carCustomFields().map(f => (c.customFields || {})[f.id]
    ? ` · <span class="car-ent">${esc(f.label)}: ${esc(c.customFields[f.id])}</span>` : "").join("")}</div>
        </div>
        ${c.outOfService ? `<span class="badge overdue">Out of service</span>` : ""}
      </div>
      ${serviceDue(c) ? `<div class="card-details" style="border-top:none;padding-top:0;margin-top:4px;"><span style="color:var(--amber-text);">⚠ Service due ${formatDate(c.nextServiceDate)}</span></div>` : ""}
      <div class="car-rows">
        <div class="car-row"><span class="car-row-l">Rates /d·/w·/m</span>
          <span class="car-rates">${numCell(c, "dailyRate", "num0", "day")}${numCell(c, "weeklyRate", "num0", "week")}${numCell(c, "monthlyRate", "num0", "month")}</span></div>
        ${dateCell(c, "regDate", "Registered", false)}
        ${dateCell(c, "licenceExpiry", "Licence exp.")}
        ${dateCell(c, "roadTaxExpiry", "Road tax exp.")}
        ${dateCell(c, "insuranceExpiry", "Insurance exp.")}
        ${dateCell(c, "fitnessExpiry", "Fitness exp.")}
        ${dateCell(c, "leaseExpiry", "Lease exp.")}
        <div class="car-row"><span class="car-row-l">Lease amount</span>${numCell(c, "leaseAmount", "numnull", "—")}</div>
        <div class="car-row"><span class="car-row-l">Purchase</span>${numCell(c, "purchaseAmount", "numnull", "—")}</div>
        <div class="car-row"><span class="car-row-l">Lease paid</span>${numCell(c, "totalLeasePaid", "numnull", "—")}</div>
        <div class="car-row"><span class="car-row-l">GPS SIM</span>${textCell(c, "gpsSim", "—")}</div>
        <div class="car-row"><span class="car-row-l">PSV no.</span>${textCell(c, "psvNumber", "—")}</div>
      </div>
      <div class="card-actions">
        <button class="btn" data-act="editcar" data-id="${c.id}">Edit</button>
        <button class="btn danger" data-act="remove" data-id="${c.id}">Remove</button>
      </div>
    </div>`).join("");

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
          // Exactly what the file says — the 7x/30x defaults are gone with
          // the rest of the rate autofill (Aug 2026).
          weeklyRate: c.weeklyRate || 0,
          monthlyRate: c.monthlyRate || 0
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
  setVal(root, "c-lease-amount", c?.leaseAmount ?? "");
  setVal(root, "c-purchase-amount", c?.purchaseAmount ?? "");
  setVal(root, "c-lease-paid", c?.totalLeasePaid ?? "");
  setVal(root, "c-category", c?.category || "");
  setVal(root, "c-colour", c?.colour || "");
  // the company's own fields, rendered from their Settings definitions
  {
    const slot = el(root, "c-customs");
    if (slot) slot.innerHTML = carCustomFields().map(f => `
      <div class="field"><label>${esc(f.label)}</label>
        <input type="text" data-cf="${esc(f.id)}" value="${esc((c?.customFields || {})[f.id] || "")}"></div>`).join("");
  }
  // Which company this car is rented under — its documents follow this tag.
  {
    const entSel = el(root, "c-entity");
    if (entSel) {
      entSel.innerHTML = allEntities().map(e =>
        `<option value="${esc(e.id)}">${esc(e.name)}${e.id ? "" : " (main)"}</option>`).join("");
      entSel.value = c?.entityId || "";
    }
  }
  setVal(root, "c-regdate", c?.regDate || "");
  setVal(root, "c-licence-exp", c?.licenceExpiry || "");
  setVal(root, "c-roadtax-exp", c?.roadTaxExpiry || "");
  setVal(root, "c-insurance-exp", c?.insuranceExpiry || "");
  setVal(root, "c-fitness-exp", c?.fitnessExpiry || "");
  setVal(root, "c-lease-exp", c?.leaseExpiry || "");
  setChecked(root, "c-automatic", c?.automatic === true);
  paintCarColourSwatches(c?.rowColour || "");
  setSwatch(root, "c-rowcolour", c?.rowColour || "");

  // Treat an existing car's weekly/monthly figures as deliberate, so changing
  // the daily rate later will not silently overwrite them.
  openModal(root, "car-modal");
}

// Same company palette as booking colours — one set of colours, chosen by
// the company, offered everywhere a colour is picked.
function paintCarColourSwatches(selected) {
  const row = el(root, "c-rowcolour");
  if (!row) return;
  const palette = Array.isArray(state.settings?.plannerColours)
    ? state.settings.plannerColours.filter(x => /^#[0-9a-fA-F]{6}$/.test(String(x)))
    : [];
  const sel = String(selected || "");
  const shown = palette.includes(sel) || !sel ? palette : [...palette, sel];
  row.innerHTML =
    `<button type="button" class="swatch auto" data-colour="" title="No colour">\u2014</button>` +
    shown.map(x =>
      `<button type="button" class="swatch" data-colour="${x}" style="background:${x}" title="${x}"></button>`).join("") +
    `<label class="swatch swatch-add" title="Add a colour to the company palette">+<input type="color" class="swatch-pick" data-el="c-rowcolour-pick"></label>`;
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
  // Exactly as typed, nothing derived: the autofill that turned one daily rate
  // into three figures is gone at the pilot's request.
  const dailyRate = parseFloat(val(root, "c-rate")) || 0;
  const weeklyRate = parseFloat(val(root, "c-rate-week")) || 0;
  const monthlyRate = parseFloat(val(root, "c-rate-month")) || 0;
  // The leasing figures are typed by hand for now — including "total lease
  // paid", which per the pilot is an amount they carry forward themselves
  // until a decision is made on recording lease payments inside the app.
  const moneyOrNull = (n) => { const x = parseFloat(val(root, n)); return Number.isFinite(x) && x >= 0 && val(root, n) !== "" ? x : null; };
  const leaseAmount = moneyOrNull("c-lease-amount");
  const purchaseAmount = moneyOrNull("c-purchase-amount");
  const totalLeasePaid = moneyOrNull("c-lease-paid");
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
  const entityId = val(root, "c-entity") || "";
  const customFields = {};
  const cfSlot = el(root, "c-customs");
  if (cfSlot) cfSlot.querySelectorAll("[data-cf]").forEach(i => {
    customFields[i.dataset.cf] = i.value.trim();
  });

  const btn = el(root, "save-car");
  btn.disabled = true; btn.textContent = "Saving...";
  setSync("saving");
  try {
    if (editingCarId) {
      await updateDoc(doc(db, "cars", editingCarId), { make, model, year, plate, dailyRate, weeklyRate, monthlyRate, leaseAmount, purchaseAmount, totalLeasePaid, category, colour, automatic, rowColour, entityId, customFields, ...docDates });
    } else {
      await addDoc(collection(db, "cars"), {
        companyId: state.ctx.companyId, make, model, year, plate,
        dailyRate, weeklyRate, monthlyRate, leaseAmount, purchaseAmount, totalLeasePaid,
        category, colour, automatic, rowColour, entityId, customFields, ...docDates
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

// A walk-in starts now, so a same-day return needs a time later than now.
// Adjust the return rather than making the user work the rule out from an error.




