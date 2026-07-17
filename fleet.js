// Fleet page — car inventory & quick rent/return
import { db, auth, signInWithEmailAndPassword, requireAuth, setCompanyLabel, setSync, wireLogout } from "./firebase-init.js";
import { collection, query, where, onSnapshot, addDoc, updateDoc, deleteDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let cars = [];
let filter = "all";
let rentingId = null;
let ctx = null;

// ---------- Login handling ----------
async function doLogin() {
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const errEl = document.getElementById("login-error");
  const btn = document.getElementById("login-btn");
  errEl.classList.remove("show");
  if (!email || !password) { errEl.textContent = "Enter your email and password."; errEl.classList.add("show"); return; }
  btn.disabled = true; btn.textContent = "Signing in...";
  try {
    await signInWithEmailAndPassword(auth, email, password);
    window.location.reload();
  } catch (e) {
    errEl.textContent = "Incorrect email or password.";
    errEl.classList.add("show");
    btn.disabled = false; btn.textContent = "Sign in";
  }
}

// ---------- Boot ----------
(async function init() {
  ctx = await requireAuth({ isLoginPage: true });
  document.getElementById("boot").style.display = "none";

  if (!ctx) {
    document.getElementById("login").style.display = "flex";
    document.getElementById("login-btn").addEventListener("click", doLogin);
    document.getElementById("login-password").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
    return;
  }

  document.getElementById("app").style.display = "block";
  setCompanyLabel(ctx.companyName);
  wireLogout();
  wireUi();
  startListening();
})();

function startListening() {
  const q = query(collection(db, "cars"), where("companyId", "==", ctx.companyId));
  onSnapshot(q, (snap) => {
    cars = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    setSync("live");
    render();
  }, () => setSync("error"));
}

// ---------- UI wiring ----------
function wireUi() {
  document.getElementById("search").addEventListener("input", render);
  document.getElementById("sortBy").addEventListener("change", render);
  document.getElementById("add-car-btn").addEventListener("click", openAddModal);
  document.getElementById("save-car-btn").addEventListener("click", addCar);
  document.getElementById("confirm-rent-btn").addEventListener("click", confirmRent);

  document.querySelectorAll("#filters .tab").forEach(t => t.addEventListener("click", () => {
    filter = t.dataset.f;
    document.querySelectorAll("#filters .tab").forEach(x => x.classList.remove("active"));
    t.classList.add("active");
    render();
  }));

  document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => {
    document.getElementById(b.dataset.close).classList.remove("open");
  }));

  document.querySelectorAll(".overlay").forEach(o => o.addEventListener("click", e => {
    if (e.target === o) o.classList.remove("open");
  }));

  // Event delegation for card buttons
  document.getElementById("car-list").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.act === "rent") openRentModal(id);
    else if (btn.dataset.act === "return") markReturned(id);
    else if (btn.dataset.act === "remove") removeCar(id);
  });
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatDate(d) {
  if (!d) return "—";
  const p = d.split("-");
  return `${p[2]}/${p[1]}/${p[0]}`;
}

// ---------- Render ----------
function render() {
  const search = document.getElementById("search").value.toLowerCase();
  const sort = document.getElementById("sortBy").value;
  const available = cars.filter(c => c.status === "available").length;
  const rented = cars.filter(c => c.status === "rented").length;

  document.getElementById("stats").innerHTML = `
    <div class="stat"><div class="stat-label">Total cars</div><div class="stat-val">${cars.length}</div></div>
    <div class="stat"><div class="stat-label">Available</div><div class="stat-val green">${available}</div></div>
    <div class="stat"><div class="stat-label">Rented out</div><div class="stat-val amber">${rented}</div></div>
  `;

  let list = cars.filter(c => {
    const mf = filter === "all" || c.status === filter;
    const ms = `${c.make} ${c.model} ${c.plate} ${c.renter || ""}`.toLowerCase().includes(search);
    return mf && ms;
  });

  if (sort === "name") list.sort((a,b) => (a.make+a.model).localeCompare(b.make+b.model));
  else list.sort((a,b) => a.status.localeCompare(b.status));

  const el = document.getElementById("car-list");
  if (list.length === 0) { el.innerHTML = '<div class="empty">No cars found. Add your first car with the button above.</div>'; return; }

  el.innerHTML = list.map(c => `
    <div class="item-card ${c.status}">
      <div class="card-top">
        <div>
          <div class="card-title">${esc(c.year)} ${esc(c.make)} ${esc(c.model)}</div>
          <div class="card-sub">${esc(c.plate)}</div>
        </div>
        <span class="badge ${c.status}">${c.status === "available" ? "Available" : "Rented"}</span>
      </div>
      ${c.status === "rented" ? `
      <div class="card-details">
        <span>Renter: <strong>${esc(c.renter) || "—"}</strong></span>
        <span>Phone: <strong>${esc(c.phone) || "—"}</strong></span>
        <span>Return: <strong>${formatDate(c.returnDate)}</strong></span>
      </div>` : ""}
      <div class="card-actions">
        ${c.status === "available"
          ? `<button class="btn" data-act="rent" data-id="${c.id}">Mark as rented</button>`
          : `<button class="btn" data-act="return" data-id="${c.id}">Mark as returned</button>`}
        <button class="btn danger" data-act="remove" data-id="${c.id}">Remove</button>
      </div>
    </div>
  `).join("");
}

// ---------- Actions ----------
function openAddModal() {
  ["a-make","a-model","a-year","a-plate"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("add-modal").classList.add("open");
}

async function addCar() {
  const make = document.getElementById("a-make").value.trim();
  const model = document.getElementById("a-model").value.trim();
  const year = document.getElementById("a-year").value.trim();
  const plate = document.getElementById("a-plate").value.trim();
  if (!make || !model) { alert("Please enter at least a make and model."); return; }
  setSync("saving");
  await addDoc(collection(db, "cars"), {
    companyId: ctx.companyId, make, model, year, plate,
    status: "available", renter: "", phone: "", returnDate: ""
  });
  document.getElementById("add-modal").classList.remove("open");
}

function openRentModal(id) {
  rentingId = id;
  ["r-name","r-phone","r-date"].forEach(i => document.getElementById(i).value = "");
  document.getElementById("rent-modal").classList.add("open");
}

async function confirmRent() {
  if (!rentingId) return;
  const renter = document.getElementById("r-name").value.trim();
  const phone = document.getElementById("r-phone").value.trim();
  const returnDate = document.getElementById("r-date").value;
  setSync("saving");
  await updateDoc(doc(db, "cars", rentingId), { status: "rented", renter, phone, returnDate });
  document.getElementById("rent-modal").classList.remove("open");
  rentingId = null;
}

async function markReturned(id) {
  setSync("saving");
  await updateDoc(doc(db, "cars", id), { status: "available", renter: "", phone: "", returnDate: "" });
}

async function removeCar(id) {
  if (!confirm("Remove this car from the fleet?")) return;
  setSync("saving");
  await deleteDoc(doc(db, "cars", id));
}
