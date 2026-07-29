// Customers view — register with rental history.
import { db, setSync } from "./firebase-init.js";
import { collection, addDoc, updateDoc, deleteDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  state, onDataChange, esc, formatDate, bookingCarLabel,
  initPanelToggle,
  el, val, setVal, openModal, closeModal, showError,
  takeFocus
} from "./store.js";

let root = null;
let summaryOpen = () => true;   // set on mount; see initPanelToggle
let letter = "";                // "" is everyone; otherwise "A".."Z" or "#"
let editingId = null;

export function mount(container) {
  root = container;

  // The summary figures start closed so the working part of the view is
  // first on screen — the phone screens had almost nothing else visible.
  summaryOpen = initPanelToggle(root, "customersShowSummary", "toggle-summary", "hide-summary", "Summary");

  el(root, "search").addEventListener("input", render);

  el(root, "alpha").addEventListener("click", (e) => {
    const b = e.target.closest("[data-letter]");
    if (!b || b.disabled) return;
    // All sets it empty; tapping the letter you are already on also clears it.
    letter = (b.dataset.letter === letter) ? "" : b.dataset.letter;
    render();
  });
  el(root, "add-customer").addEventListener("click", () => openCustomerModal(null));
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

  if (summaryOpen()) el(root, "stats").innerHTML = `
    <div class="stat"><div class="stat-label">Customers</div><div class="stat-val">${state.customers.length}</div></div>
    <div class="stat"><div class="stat-label">Total rentals</div><div class="stat-val blue">${state.bookings.length}</div></div>
  `;

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
