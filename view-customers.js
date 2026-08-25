// Customers view — register with rental history.
import { db, setSync } from "./firebase-init.js";
import { collection, addDoc, updateDoc, deleteDoc, doc, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  state, onDataChange, esc, formatDate, bookingCarLabel,
  el, val, setVal, openModal, closeModal, showError,
  takeFocus
} from "./store.js";
import { loadXlsx } from "./backup.js";

let root = null;
let importReady = [];
let letter = "";                // "" is everyone; otherwise "A".."Z" or "#"
let editingId = null;

export function mount(container) {
  root = container;

  el(root, "search").addEventListener("input", render);

  el(root, "alpha").addEventListener("click", (e) => {
    const b = e.target.closest("[data-letter]");
    if (!b || b.disabled) return;
    // All sets it empty; tapping the letter you are already on also clears it.
    letter = (b.dataset.letter === letter) ? "" : b.dataset.letter;
    render();
  });
  el(root, "add-customer").addEventListener("click", () => openCustomerModal(null));
  wireImport();
  el(root, "save-customer").addEventListener("click", saveCustomer);

  root.querySelectorAll("[data-close]").forEach(b =>
    b.addEventListener("click", () => closeModal(root, b.dataset.close)));
  root.querySelectorAll(".overlay").forEach(o =>
    o.addEventListener("click", e => { if (e.target === o) o.classList.remove("open"); }));

  el(root, "list").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.act === "edit") openCustomerModal(id);
    else if (btn.dataset.act === "history") openHistory(id);
    else if (btn.dataset.act === "delete") deleteCustomer(id);
  });

  onDataChange(() => { if (root.classList.contains("active")) render(); });
}

// ---------- A to Z index ----------
// The register only ever grows, so scrolling it stops being practical fairly
// quickly. Letters with nobody behind them are shown but disabled, which keeps
// the row a stable shape and makes an empty letter obvious at a glance rather
// than something you tap and wonder about.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

function initialOf(c) {
  // Accents are stripped before the letter is taken, so Émile files under E and
  // Ålesund under A. Mauritius has plenty of French names and putting them all
  // in the "#" bucket would make the index close to useless.
  const ch = (c.name || "")
    .trim()
    .normalize("NFD")                    // é becomes e + combining accent
    .replace(/[\u0300-\u036f]/g, "")    // drop the accent
    .charAt(0)
    .toUpperCase();
  return /[A-Z]/.test(ch) ? ch : "#";
}

function renderAlphaIndex(people) {
  const counts = {};
  people.forEach(c => { const k = initialOf(c); counts[k] = (counts[k] || 0) + 1; });

  const keys = [...ALPHABET];
  if (counts["#"]) keys.push("#");          // only when something needs it

  // An explicit All button. Tapping the selected letter again also clears it, but
  // nothing on screen says so, so relying on that alone left people stuck inside
  // a letter with no obvious way back to the whole register.
  const all = `<button type="button" class="alpha-btn alpha-all${letter === "" ? " active" : ""}"
      data-letter="" title="Show every customer">All</button>`;

  el(root, "alpha").innerHTML = all + keys.map(k => {
    const n = counts[k] || 0;
    return `<button type="button" class="alpha-btn${letter === k ? " active" : ""}"
      data-letter="${k}" ${n ? "" : "disabled"}
      title="${n ? `${n} customer${n === 1 ? "" : "s"}` : "nobody yet"}">${k}</button>`;
  }).join("");
}

function rentalCount(customerId) {
  return state.bookings.filter(b => b.customerId === customerId).length;
}

export function render() {
  if (!root) return;

  // Arriving from a booking: clear the search and the letter, or the customer
  // being jumped to might not be in the list and the jump would do nothing.
  const focusId = takeFocus("customers");
  if (focusId) {
    setVal(root, "search", "");
    letter = "";
  }

  const search = el(root, "search").value.toLowerCase();

  // Search first, so the letters reflect what the search has already narrowed to
  // rather than offering letters that would come back empty.
  const searched = state.customers.filter(c =>
    `${c.name} ${c.phone || ""} ${c.email || ""} ${c.license || ""}`.toLowerCase().includes(search));

  renderAlphaIndex(searched);

  let list = searched.filter(c => !letter || initialOf(c) === letter);
  list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  el(root, "list-total").textContent = list.length === searched.length
    ? `${list.length} customer${list.length === 1 ? "" : "s"}`
    : `${list.length} of ${searched.length} · ${letter === "#" ? "not starting with a letter" : "starting with " + letter}`;

  const listEl = el(root, "list");
  if (list.length === 0) {
    listEl.innerHTML = letter
      ? `<div class="empty">Nobody under ${esc(letter)}. Tap the letter again to see everyone.</div>`
      : '<div class="empty">No customers yet. Add your first customer with the button above.</div>';
    return;
  }

  listEl.innerHTML = list.map(c => {
    const n = rentalCount(c.id);
    return `
    <div class="item-card" data-customer-id="${c.id}">
      <div class="card-top">
        <div>
          <div class="card-title">${esc(c.name)}</div>
          <div class="card-sub">${esc(c.phone) || "no phone"}${c.email ? " · " + esc(c.email) : ""}</div>
        </div>
        <span class="badge completed">${n} rental${n === 1 ? "" : "s"}</span>
      </div>
      <div class="card-details">
        <span>License: <strong>${esc(c.license) || "—"}</strong></span>
        ${c.notes ? `<span>Notes: <strong>${esc(c.notes)}</strong></span>` : ""}
      </div>
      <div class="card-actions">
        <button class="btn" data-act="history" data-id="${c.id}">History</button>
        <button class="btn" data-act="edit" data-id="${c.id}">Edit</button>
        <button class="btn danger" data-act="delete" data-id="${c.id}">Delete</button>
      </div>
    </div>`;
  }).join("");

  if (focusId) revealCustomer(focusId);
}

// Brings the customer into view and opens them for editing straight away —
// arriving here from a booking, editing is the whole reason for the trip.
function revealCustomer(id) {
  const card = el(root, "list").querySelector(`[data-customer-id="${id}"]`);
  if (card) {
    card.classList.add("just-focused");
    setTimeout(() => card.classList.remove("just-focused"), 2600);
    // Deferred, or the view switch scrolls the page back to the top afterwards.
    setTimeout(() => card.scrollIntoView({ block: "center", behavior: "smooth" }), 0);
  }
  if (state.customers.some(c => c.id === id)) openCustomerModal(id);
}

function openCustomerModal(id) {
  editingId = id;
  const c = id ? state.customers.find(x => x.id === id) : null;
  el(root, "customer-modal-title").textContent = c ? "Edit customer" : "Add customer";
  setVal(root, "cu-name", c?.name);
  setVal(root, "cu-phone", c?.phone);
  setVal(root, "cu-email", c?.email);
  setVal(root, "cu-license", c?.license);
  setVal(root, "cu-notes", c?.notes);
  showError(root, "customer-error", null);
  openModal(root, "customer-modal");
}

async function saveCustomer() {
  showError(root, "customer-error", null);

  const data = {
    name: val(root, "cu-name"),
    phone: val(root, "cu-phone"),
    email: val(root, "cu-email"),
    license: val(root, "cu-license"),
    notes: val(root, "cu-notes")
  };
  if (!data.name) { showError(root, "customer-error", "Please enter at least a name."); return; }

  const btn = el(root, "save-customer");
  btn.disabled = true; btn.textContent = "Saving...";
  setSync("saving");
  try {
    if (editingId) {
      await updateDoc(doc(db, "customers", editingId), data);
    } else {
      await addDoc(collection(db, "customers"), {
        companyId: state.ctx.companyId, createdAt: new Date().toISOString(), ...data
      });
    }
    closeModal(root, "customer-modal");
    editingId = null;
  } catch (e) {
    showError(root, "customer-error", "Couldn't save (" + (e.code || e.message) + "). Try again.");
    setSync("error");
  }
  btn.disabled = false; btn.textContent = "Save";
}

async function deleteCustomer(id) {
  const n = rentalCount(id);
  const msg = n > 0
    ? `This customer has ${n} booking(s) in the system. Deleting the customer keeps those bookings but unlinks them. Delete anyway?`
    : "Delete this customer?";
  if (!confirm(msg)) return;
  setSync("saving");
  try { await deleteDoc(doc(db, "customers", id)); }
  catch (e) { alert("Couldn't delete (" + (e.code || e.message) + ")."); setSync("error"); }
}

function openHistory(id) {
  const c = state.customers.find(x => x.id === id);
  el(root, "history-title").textContent = `${c.name} — rental history`;

  const list = state.bookings
    .filter(b => b.customerId === id)
    .sort((a, b) => b.startDate.localeCompare(a.startDate));

  el(root, "history-list").innerHTML = list.length === 0
    ? '<div class="empty">No rentals recorded for this customer yet.</div>'
    : list.map(b => `
      <div class="item-card ${b.status === "completed" ? "completed" : ""}">
        <div class="card-top">
          <div>
            <div class="card-title" style="font-size:1rem;">${esc(bookingCarLabel(b))}</div>
            <div class="card-sub">${formatDate(b.startDate)} – ${formatDate(b.endDate)}</div>
          </div>
          <span class="badge ${b.status === "completed" ? "completed" : "active-b"}">${b.status === "completed" ? "Completed" : "Open"}</span>
        </div>
      </div>`).join("");

  openModal(root, "history-modal");
}


// ---------- Import from a spreadsheet ----------
// Same shape as the fleet importer so the two feel identical: only the first
// sheet is read, the header row is found in the first ten rows, unrecognised
// columns are ignored rather than refused, and nothing is written until the
// preview has named every problem.
//
// The duplicate rule (Arshad, 25 Aug): the same NAME is fine — two real people
// share a name, and one person is spelled three ways — but a phone number, an
// email or a licence number that already exists means the same person. Any one
// of the three matching is enough to skip the row.

const CUST_FIELDS = [
  { key: "name", heads: ["name", "fullname", "customer", "customername", "renter", "client", "nom"] },
  { key: "phone", heads: ["phone", "phoneno", "phonenumber", "mobile", "tel", "telephone", "contact", "contactno", "telephonenumber"] },
  { key: "email", heads: ["email", "emailaddress", "mail", "courriel"] },
  { key: "license", heads: ["license", "licence", "licenseno", "licenceno", "licensenumber", "licencenumber",
                            "drivinglicence", "drivinglicense", "drivinglicenceno", "drivinglicenseno", "permis"] },
  { key: "notes", heads: ["notes", "note", "comment", "comments", "remarks"] }
];

// Titles are matched loosely: lowercased with everything that is not a letter
// stripped, so "Phone no.", "phone_no" and "PHONENO" are one thing.
function normHead(v) {
  return String(v == null ? "" : v).toLowerCase().replace(/[^a-z]/g, "");
}
// Two phone numbers match if their digits match. Spacing, dashes, brackets and
// a country code written as 00 or + are all noise: +230 5712 3456, 5712-3456
// and 57123456 are one number. Compared on the last 7 digits, which is what a
// Mauritian number carries once the prefix is stripped.
function normPhone(v) {
  const d = String(v == null ? "" : v).replace(/\D/g, "");
  return d.length > 7 ? d.slice(-7) : d;
}
const normEmail = v => String(v == null ? "" : v).trim().toLowerCase();
// Licence numbers get written with and without punctuation and case.
const normLicence = v => String(v == null ? "" : v).toUpperCase().replace(/[^A-Z0-9]/g, "");
// Only used for rows carrying no contact detail at all (see below).
const normName = v => String(v == null ? "" : v).toLowerCase().replace(/[^a-z]/g, "");

function wireImport() {
  const btn = el(root, "import-customers");
  const file = el(root, "import-file");
  if (!btn || !file) return;      // guarded, like Fleet: missing markup must not crash the page

  btn.addEventListener("click", () => { file.value = ""; file.click(); });
  file.addEventListener("change", async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    try {
      const XLSX = await loadXlsx();
      const wb = XLSX.read(await f.arrayBuffer());
      const sheet = wb.Sheets[wb.SheetNames[0]];
      buildImportPreview(XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" }));
    } catch (e) {
      importReady = [];
      el(root, "import-summary").textContent = "";
      el(root, "import-list").innerHTML = "";
      el(root, "import-go").disabled = true;
      showError(root, "import-error",
        "Couldn't read that file (" + (e.message || e) + "). Save it as .xlsx or .csv and try again.");
      openModal(root, "import-modal");
    }
  });

  el(root, "import-go").addEventListener("click", doImport);
}

function buildImportPreview(rows) {
  showError(root, "import-error", null);

  // A name column is the minimum: without it there is no customer to create.
  let headRow = -1, colMap = {};
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const map = {};
    (rows[i] || []).forEach((cell, c) => {
      const n = normHead(cell);
      if (!n) return;
      CUST_FIELDS.forEach(f => { if (f.heads.includes(n) && !(f.key in map)) map[f.key] = c; });
    });
    if ("name" in map) { headRow = i; colMap = map; break; }
  }

  if (headRow === -1) {
    importReady = [];
    el(root, "import-summary").textContent = "";
    el(root, "import-list").innerHTML = "";
    el(root, "import-go").disabled = true;
    showError(root, "import-error",
      'No header row found. The sheet needs column titles \u2014 at least "Name".');
    openModal(root, "import-modal");
    return;
  }

  // What the register already holds, by each of the three identifiers.
  const have = { phone: new Map(), email: new Map(), license: new Map() };
  // A row with no phone, email or licence has nothing to be matched on, so it
  // would import again on every run. For those — and only those — the name is
  // the last resort: a bare name already held as a bare name is treated as the
  // same person. Anyone with a contact detail is still judged on that alone,
  // so two real people called Jean Martin both import.
  const bareNames = new Set();
  state.customers.forEach(c => {
    const p = normPhone(c.phone), e = normEmail(c.email), l = normLicence(c.license);
    if (p && !have.phone.has(p)) have.phone.set(p, c.name || "");
    if (e && !have.email.has(e)) have.email.set(e, c.name || "");
    if (l && !have.license.has(l)) have.license.set(l, c.name || "");
    if (!p && !e && !l) bareNames.add(normName(c.name));
  });
  const seen = { phone: new Map(), email: new Map(), license: new Map() };
  const seenBare = new Set();

  const LABEL = { phone: "phone", email: "email", license: "licence number" };
  const ok = [], skipped = [];

  rows.slice(headRow + 1).forEach((r, idx) => {
    if (!r || r.every(c => String(c).trim() === "")) return;
    const rowNo = headRow + idx + 2;
    const cust = {};
    Object.entries(colMap).forEach(([key, c]) => { cust[key] = String(r[c] == null ? "" : r[c]).trim(); });
    if (!cust.name) { skipped.push({ rowNo, why: "no name" }); return; }

    const keys = { phone: normPhone(cust.phone), email: normEmail(cust.email), license: normLicence(cust.license) };
    // Any one of the three is enough to call it the same person. Checked
    // against the register first, then against earlier rows of this file.
    let clash = null;
    for (const k of ["phone", "email", "license"]) {
      if (!keys[k]) continue;
      if (have[k].has(keys[k])) { clash = { k, who: have[k].get(keys[k]), where: "already in your customers" }; break; }
      if (seen[k].has(keys[k])) { clash = { k, who: seen[k].get(keys[k]), where: "appears earlier in the file" }; break; }
    }
    if (clash) {
      skipped.push({ rowNo, why: `same ${LABEL[clash.k]} as ${clash.who || "another customer"} \u2014 ${clash.where}` });
      return;
    }
    if (!keys.phone && !keys.email && !keys.license) {
      const n = normName(cust.name);
      if (bareNames.has(n) || seenBare.has(n)) {
        skipped.push({ rowNo, why: `${cust.name} is already listed with no contact details \u2014 ` +
          "add them by hand if this is a different person" });
        return;
      }
      seenBare.add(n);
    }
    for (const k of ["phone", "email", "license"]) if (keys[k]) seen[k].set(keys[k], cust.name);
    ok.push(cust);
  });

  importReady = ok;
  el(root, "import-go").disabled = ok.length === 0;
  el(root, "import-summary").textContent =
    `${ok.length} customer${ok.length === 1 ? "" : "s"} ready to import` +
    (skipped.length ? ` \u00b7 ${skipped.length} row${skipped.length === 1 ? "" : "s"} will be skipped` : "") +
    ". Two people may share a name; a repeated phone, email or licence number is treated as the same person.";

  el(root, "import-list").innerHTML =
    ok.map(c => `<div class="jd-row"><span class="jd-v">${esc(c.name)}` +
      `${c.phone ? ` \u00b7 ${esc(c.phone)}` : ""}${c.email ? ` \u00b7 ${esc(c.email)}` : ""}` +
      `${!c.phone && !c.email && !c.license ? ' <span style="color:var(--muted);">\u2014 no contact details</span>' : ""}` +
      `</span></div>`).join("") +
    (skipped.length ? `<p style="margin:10px 0 4px;color:var(--muted);font-size:12px;">Skipped:</p>` +
      skipped.map(x => `<div class="jd-row"><span class="jd-v" style="color:var(--muted);">Row ${x.rowNo} \u2014 ${esc(x.why)}</span></div>`).join("") : "");

  openModal(root, "import-modal");
}

async function doImport() {
  if (!importReady.length) return;
  const btn = el(root, "import-go");
  btn.disabled = true; btn.textContent = "Importing...";
  setSync("saving");
  // Firestore caps a batch at 500 writes, so a long register goes in chunks.
  const CHUNK = 450;
  let written = 0;
  try {
    for (let i = 0; i < importReady.length; i += CHUNK) {
      const batch = writeBatch(db);
      importReady.slice(i, i + CHUNK).forEach(c => {
        batch.set(doc(collection(db, "customers")), {
          companyId: state.ctx.companyId,
          name: c.name,
          phone: c.phone || "",
          email: c.email || "",
          license: c.license || "",
          notes: c.notes || ""
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
        "Import failed (" + (e.code || e.message) + "). Nobody was added \u2014 try again.");
    } else {
      // Some chunks landed. The list is cleared so pressing Import again
      // cannot write them twice; picking the file again skips whoever
      // already arrived, because they are now in the register.
      const total = importReady.length;
      importReady = [];
      showError(root, "import-error",
        `Import stopped partway (${e.code || e.message}). ${written} of ${total} customers were added. ` +
        "Choose the file again \u2014 the preview will skip the ones already in.");
    }
    setSync("error");
  } finally {
    btn.textContent = "Import";
    btn.disabled = importReady.length === 0;
  }
}
