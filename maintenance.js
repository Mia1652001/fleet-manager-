// Maintenance page — service schedules, due warnings, out-of-service toggle.
import { db, requireAuth, setCompanyLabel, setSync, wireLogout } from "./firebase-init.js";
import { collection, query, where, onSnapshot, updateDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let cars = [];
let filter = "all";
let editingCarId = null;
let ctx = null;

(async function init() {
  ctx = await requireAuth();
  if (!ctx) return;
  document.getElementById("boot").style.display = "none";
  document.getElementById("app").style.display = "block";
  setCompanyLabel(ctx.companyName);
  wireLogout();
  wireUi();

  onSnapshot(query(collection(db, "cars"), where("companyId", "==", ctx.companyId)), (snap) => {
    cars = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    setSync("live");
    render();
  }, () => setSync("error"));
})();

// ---------- Helpers ----------
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function formatDate(d) {
  if (!d) return "—";
  const p = d.split("-");
  return `${p[2]}/${p[1]}/${p[0]}`;
}

// Service due by date (within 14 days or past) OR by mileage (current >= due)
function serviceDueByDate(c) {
  if (!c.nextServiceDate) return false;
  const soon = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  return c.nextServiceDate <= soon;
}
function serviceDueByMileage(c) {
  return c.serviceMileage && c.mileage && Number(c.mileage) >= Number(c.serviceMileage);
}
function isDue(c) {
  return serviceDueByDate(c) || serviceDueByMileage(c);
}

// ---------- UI ----------
function wireUi() {
  document.getElementById("search").addEventListener("input", render);
  document.getElementById("save-maint-btn").addEventListener("click", saveMaintenance);

  document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => {
    document.getElementById(b.dataset.close).classList.remove("open");
  }));
  document.querySelectorAll(".overlay").forEach(o => o.addEventListener("click", e => {
    if (e.target === o) o.classList.remove("open");
  }));

  document.querySelectorAll("#filters .tab").forEach(t => t.addEventListener("click", () => {
    filter = t.dataset.f;
    document.querySelectorAll("#filters .tab").forEach(x => x.classList.remove("active"));
    t.classList.add("active");
    render();
  }));

  document.getElementById("car-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.act === "edit") { openMaintModal(id); return; }
    if (btn.dataset.act === "outofservice" || btn.dataset.act === "backinservice") {
      btn.disabled = true; setSync("saving");
      try {
        await updateDoc(doc(db, "cars", id), { outOfService: btn.dataset.act === "outofservice" });
      } catch (err) { alert("Couldn't update (" + (err.code || err.message) + ")."); setSync("error"); }
      btn.disabled = false;
    }
    if (btn.dataset.act === "serviced") {
      // Mark serviced: clear the due date and bump nothing else (staff set the next date manually)
      btn.disabled = true; setSync("saving");
      try {
        await updateDoc(doc(db, "cars", id), { lastServicedAt: new Date().toISOString(), nextServiceDate: "" });
      } catch (err) { alert("Couldn't update (" + (err.code || err.message) + ")."); setSync("error"); }
      btn.disabled = false;
    }
  });
}

// ---------- Render ----------
function render() {
  const search = document.getElementById("search").value.toLowerCase();

  const dueCount = cars.filter(isDue).length;
  const serviceCount = cars.filter(c => c.outOfService).length;

  document.getElementById("stats").innerHTML = `
    <div class="stat"><div class="stat-label">Total cars</div><div class="stat-val">${cars.length}</div></div>
    <div class="stat"><div class="stat-label">Service due</div><div class="stat-val amber">${dueCount}</div></div>
    <div class="stat"><div class="stat-label">Out of service</div><div class="stat-val red">${serviceCount}</div></div>
  `;

  let list = cars.filter(c => {
    let mf = true;
    if (filter === "due") mf = isDue(c);
    else if (filter === "service") mf = !!c.outOfService;
    const ms = `${c.make} ${c.model} ${c.plate}`.toLowerCase().includes(search);
    return mf && ms;
  });

  list.sort((a,b) => (isDue(b) - isDue(a)) || (a.make+a.model).localeCompare(b.make+b.model));

  const el = document.getElementById("car-list");
  if (list.length === 0) { el.innerHTML = '<div class="empty">No cars match. Add cars on the Fleet page first.</div>'; return; }

  el.innerHTML = list.map(c => {
    const due = isDue(c);
    const oos = !!c.outOfService;
    return `
    <div class="item-card ${oos ? "overdue" : due ? "upcoming" : "available"}">
      <div class="card-top">
        <div>
          <div class="card-title">${esc(c.year)} ${esc(c.make)} ${esc(c.model)}</div>
          <div class="card-sub">${esc(c.plate)}</div>
        </div>
        <span class="badge ${oos ? "overdue" : due ? "upcoming" : "available"}">${oos ? "Out of service" : due ? "Service due" : "OK"}</span>
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

// ---------- Edit schedule ----------
function openMaintModal(id) {
  editingCarId = id;
  const c = cars.find(x => x.id === id);
  document.getElementById("maint-title").textContent = `${c.make} ${c.model} — maintenance`;
  document.getElementById("m-service-date").value = c.nextServiceDate || "";
  document.getElementById("m-mileage").value = c.mileage ?? "";
  document.getElementById("m-service-mileage").value = c.serviceMileage ?? "";
  document.getElementById("m-notes").value = c.notes_maint || "";
  document.getElementById("maint-error").classList.remove("show");
  document.getElementById("maint-modal").classList.add("open");
}

async function saveMaintenance() {
  if (!editingCarId) return;
  const errEl = document.getElementById("maint-error");
  errEl.classList.remove("show");

  const data = {
    nextServiceDate: document.getElementById("m-service-date").value || "",
    mileage: parseFloat(document.getElementById("m-mileage").value) || 0,
    serviceMileage: parseFloat(document.getElementById("m-service-mileage").value) || 0,
    notes_maint: document.getElementById("m-notes").value.trim()
  };

  const btn = document.getElementById("save-maint-btn");
  btn.disabled = true; btn.textContent = "Saving...";
  setSync("saving");
  try {
    await updateDoc(doc(db, "cars", editingCarId), data);
    document.getElementById("maint-modal").classList.remove("open");
    editingCarId = null;
  } catch (e) {
    errEl.textContent = "Couldn't save (" + (e.code || e.message) + "). Try again.";
    errEl.classList.add("show");
    setSync("error");
  }
  btn.disabled = false; btn.textContent = "Save";
}
