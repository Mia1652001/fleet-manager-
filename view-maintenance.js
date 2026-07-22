// Maintenance view — service schedules, due warnings, out-of-service toggle.
import { db, setSync } from "./firebase-init.js";
import { updateDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  state, onDataChange, esc, formatDate, serviceDue,
  el, val, setVal, openModal, closeModal, showError
} from "./store.js";

let root = null;
let filter = "all";
let editingCarId = null;

export function mount(container) {
  root = container;

  el(root, "search").addEventListener("input", render);
  el(root, "save-maint").addEventListener("click", saveMaintenance);

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

  el(root, "list").addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const id = btn.dataset.id;

    if (btn.dataset.act === "edit") { openMaintModal(id); return; }

    btn.disabled = true;
    setSync("saving");
    try {
      if (btn.dataset.act === "outofservice") {
        await updateDoc(doc(db, "cars", id), { outOfService: true });
      } else if (btn.dataset.act === "backinservice") {
        await updateDoc(doc(db, "cars", id), { outOfService: false });
      } else if (btn.dataset.act === "serviced") {
        await updateDoc(doc(db, "cars", id), {
          lastServicedAt: new Date().toISOString(), nextServiceDate: ""
        });
      }
    } catch (err) {
      alert("Couldn't update (" + (err.code || err.message) + ").");
      setSync("error");
    }
    btn.disabled = false;
  });

  onDataChange(() => { if (root.classList.contains("active")) render(); });
}

export function render() {
  if (!root) return;
  const search = el(root, "search").value.toLowerCase();

  const dueCount = state.cars.filter(serviceDue).length;
  const serviceCount = state.cars.filter(c => c.outOfService).length;

  el(root, "stats").innerHTML = `
    <div class="stat"><div class="stat-label">Total cars</div><div class="stat-val">${state.cars.length}</div></div>
    <div class="stat"><div class="stat-label">Service due</div><div class="stat-val amber">${dueCount}</div></div>
    <div class="stat"><div class="stat-label">Out of service</div><div class="stat-val red">${serviceCount}</div></div>
  `;

  let list = state.cars.filter(c => {
    let mf = true;
    if (filter === "due") mf = serviceDue(c);
    else if (filter === "service") mf = !!c.outOfService;
    const ms = `${c.make} ${c.model} ${c.plate}`.toLowerCase().includes(search);
    return mf && ms;
  });
  list.sort((a, b) => (serviceDue(b) - serviceDue(a)) || (a.make + a.model).localeCompare(b.make + b.model));

  const listEl = el(root, "list");
  if (list.length === 0) {
    listEl.innerHTML = '<div class="empty">No cars match. Add cars in the Fleet view first.</div>';
    return;
  }

  listEl.innerHTML = list.map(c => {
    const due = serviceDue(c);
    const oos = !!c.outOfService;
    const cls = oos ? "overdue" : due ? "upcoming" : "available";
    return `
    <div class="item-card ${cls}">
      <div class="card-top">
        <div>
          <div class="card-title">${esc(c.year)} ${esc(c.make)} ${esc(c.model)}</div>
          <div class="card-sub">${esc(c.plate)}</div>
        </div>
        <span class="badge ${cls}">${oos ? "Out of service" : due ? "Service due" : "OK"}</span>
      </div>
      <div class="card-details">
        <span>Next service: <strong>${formatDate(c.nextServiceDate)}</strong></span>
        <span>Mileage: <strong>${c.mileage ? esc(c.mileage) + " km" : "—"}</strong></span>
        ${c.serviceMileage ? `<span>Service at: <strong>${esc(c.serviceMileage)} km</strong></span>` : ""}
        ${c.notes_maint ? `<span>Notes: <strong>${esc(c.notes_maint)}</strong></span>` : ""}
      </div>
      <div class="card-actions">
        <button class="btn" data-act="edit" data-id="${c.id}">Edit schedule</button>
        ${due ? `<button class="btn" data-act="serviced" data-id="${c.id}">Mark serviced</button>` : ""}
        ${oos
          ? `<button class="btn" data-act="backinservice" data-id="${c.id}">Back in service</button>`
          : `<button class="btn danger" data-act="outofservice" data-id="${c.id}">Take out of service</button>`}
      </div>
    </div>`;
  }).join("");
}

function openMaintModal(id) {
  editingCarId = id;
  const c = state.cars.find(x => x.id === id);
  el(root, "maint-title").textContent = `${c.make} ${c.model} — maintenance`;
  setVal(root, "m-date", c.nextServiceDate || "");
  setVal(root, "m-mileage", c.mileage ?? "");
  setVal(root, "m-service-mileage", c.serviceMileage ?? "");
  setVal(root, "m-notes", c.notes_maint || "");
  showError(root, "maint-error", null);
  openModal(root, "maint-modal");
}

async function saveMaintenance() {
  if (!editingCarId) return;
  showError(root, "maint-error", null);

  const data = {
    nextServiceDate: val(root, "m-date"),
    mileage: parseFloat(val(root, "m-mileage")) || 0,
    serviceMileage: parseFloat(val(root, "m-service-mileage")) || 0,
    notes_maint: val(root, "m-notes")
  };

  const btn = el(root, "save-maint");
  btn.disabled = true; btn.textContent = "Saving...";
  setSync("saving");
  try {
    await updateDoc(doc(db, "cars", editingCarId), data);
    closeModal(root, "maint-modal");
    editingCarId = null;
  } catch (e) {
    showError(root, "maint-error", "Couldn't save (" + (e.code || e.message) + "). Try again.");
    setSync("error");
  }
  btn.disabled = false; btn.textContent = "Save";
}
