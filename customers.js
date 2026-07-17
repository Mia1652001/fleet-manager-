// Customers page — customer register with rental history
import { db, requireAuth, setCompanyLabel, setSync, wireLogout } from "./firebase-init.js";
import { collection, query, where, onSnapshot, addDoc, updateDoc, deleteDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let customers = [];
let bookings = [];
let cars = [];
let editingId = null; // null = adding new
let ctx = null;

(async function init() {
  ctx = await requireAuth();
  if (!ctx) return;
  document.getElementById("boot").style.display = "none";
  document.getElementById("app").style.display = "block";
  setCompanyLabel(ctx.companyName);
  wireLogout();
  wireUi();

  onSnapshot(query(collection(db, "customers"), where("companyId", "==", ctx.companyId)), (snap) => {
    customers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    setSync("live");
    render();
  }, () => setSync("error"));

  onSnapshot(query(collection(db, "bookings"), where("companyId", "==", ctx.companyId)), (snap) => {
    bookings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  });

  onSnapshot(query(collection(db, "cars"), where("companyId", "==", ctx.companyId)), (snap) => {
    cars = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  });
})();

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatDate(d) {
  if (!d) return "—";
  const p = d.split("-");
  return `${p[2]}/${p[1]}/${p[0]}`;
}

function carLabel(carId) {
  const c = cars.find(x => x.id === carId);
  return c ? `${c.year || ""} ${c.make} ${c.model} (${c.plate || "no plate"})`.trim() : "Unknown car";
}

function rentalCount(customerId) {
  return bookings.filter(b => b.customerId === customerId).length;
}

// ---------- UI ----------
function wireUi() {
  document.getElementById("search").addEventListener("input", render);
  document.getElementById("add-customer-btn").addEventListener("click", () => openCustomerModal(null));
  document.getElementById("save-customer-btn").addEventListener("click", saveCustomer);

  document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => {
    document.getElementById(b.dataset.close).classList.remove("open");
  }));

  document.querySelectorAll(".overlay").forEach(o => o.addEventListener("click", e => {
    if (e.target === o) o.classList.remove("open");
  }));

  document.getElementById("customer-list").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.act === "edit") openCustomerModal(id);
    else if (btn.dataset.act === "history") openHistory(id);
    else if (btn.dataset.act === "delete") deleteCustomer(id);
  });
}

// ---------- Render ----------
function render() {
  const search = document.getElementById("search").value.toLowerCase();

  document.getElementById("stats").innerHTML = `
    <div class="stat"><div class="stat-label">Customers</div><div class="stat-val">${customers.length}</div></div>
    <div class="stat"><div class="stat-label">Total rentals</div><div class="stat-val blue">${bookings.length}</div></div>
  `;

  let list = customers.filter(c =>
    `${c.name} ${c.phone || ""} ${c.email || ""} ${c.license || ""}`.toLowerCase().includes(search)
  );

  list.sort((a,b) => a.name.localeCompare(b.name));

  const el = document.getElementById("customer-list");
  if (list.length === 0) { el.innerHTML = '<div class="empty">No customers yet. Add your first customer with the button above.</div>'; return; }

  el.innerHTML = list.map(c => {
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

// ---------- Add / Edit ----------
function openCustomerModal(id) {
  editingId = id;
  const c = id ? customers.find(x => x.id === id) : null;
  document.getElementById("customer-modal-title").textContent = c ? "Edit customer" : "Add customer";
  document.getElementById("c-name").value = c?.name || "";
  document.getElementById("c-phone").value = c?.phone || "";
  document.getElementById("c-email").value = c?.email || "";
  document.getElementById("c-license").value = c?.license || "";
  document.getElementById("c-notes").value = c?.notes || "";
  document.getElementById("customer-error").classList.remove("show");
  document.getElementById("customer-modal").classList.add("open");
}

async function saveCustomer() {
  const errEl = document.getElementById("customer-error");
  errEl.classList.remove("show");

  const data = {
    name: document.getElementById("c-name").value.trim(),
    phone: document.getElementById("c-phone").value.trim(),
    email: document.getElementById("c-email").value.trim(),
    license: document.getElementById("c-license").value.trim(),
    notes: document.getElementById("c-notes").value.trim(),
  };

  if (!data.name) { errEl.textContent = "Please enter at least a name."; errEl.classList.add("show"); return; }

  const btn = document.getElementById("save-customer-btn");
  btn.disabled = true; btn.textContent = "Saving...";
  setSync("saving");
  try {
    if (editingId) {
      await updateDoc(doc(db, "customers", editingId), data);
    } else {
      await addDoc(collection(db, "customers"), { companyId: ctx.companyId, createdAt: new Date().toISOString(), ...data });
    }
    document.getElementById("customer-modal").classList.remove("open");
  } catch (e) {
    errEl.textContent = "Couldn't save (" + (e.code || e.message || "unknown error") + "). Try again.";
    errEl.classList.add("show");
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
  await deleteDoc(doc(db, "customers", id));
}

// ---------- History ----------
function openHistory(id) {
  const c = customers.find(x => x.id === id);
  document.getElementById("history-title").textContent = `${c.name} — rental history`;

  const list = bookings
    .filter(b => b.customerId === id)
    .sort((a,b) => b.startDate.localeCompare(a.startDate));

  const el = document.getElementById("history-list");
  el.innerHTML = list.length === 0
    ? '<div class="empty">No rentals recorded for this customer yet.</div>'
    : list.map(b => `
      <div class="item-card ${b.status === "completed" ? "completed" : ""}">
        <div class="card-top">
          <div>
            <div class="card-title" style="font-size:1rem;">${esc(carLabel(b.carId))}</div>
            <div class="card-sub">${formatDate(b.startDate)} – ${formatDate(b.endDate)}</div>
          </div>
          <span class="badge ${b.status === "completed" ? "completed" : "active-b"}">${b.status === "completed" ? "Completed" : "Open"}</span>
        </div>
      </div>`).join("");

  document.getElementById("history-modal").classList.add("open");
}
