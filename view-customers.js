// Customers view — register with rental history.
import { db, setSync } from "./firebase-init.js";
import { collection, addDoc, updateDoc, deleteDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  state, onDataChange, esc, formatDate, bookingCarLabel,
  el, val, setVal, openModal, closeModal, showError
} from "./store.js";

let root = null;
let editingId = null;

export function mount(container) {
  root = container;

  el(root, "search").addEventListener("input", render);
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

function rentalCount(customerId) {
  return state.bookings.filter(b => b.customerId === customerId).length;
}

export function render() {
  if (!root) return;
  const search = el(root, "search").value.toLowerCase();

  el(root, "stats").innerHTML = `
    <div class="stat"><div class="stat-label">Customers</div><div class="stat-val">${state.customers.length}</div></div>
    <div class="stat"><div class="stat-label">Total rentals</div><div class="stat-val blue">${state.bookings.length}</div></div>
  `;

  let list = state.customers.filter(c =>
    `${c.name} ${c.phone || ""} ${c.email || ""} ${c.license || ""}`.toLowerCase().includes(search));
  list.sort((a, b) => a.name.localeCompare(b.name));

  const listEl = el(root, "list");
  if (list.length === 0) {
    listEl.innerHTML = '<div class="empty">No customers yet. Add your first customer with the button above.</div>';
    return;
  }

  listEl.innerHTML = list.map(c => {
    const n = rentalCount(c.id);
    return `
    <div class="item-card">
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
