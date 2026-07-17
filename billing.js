// Billing page — every booking is an invoice: days × daily rate, paid/unpaid.
import { db, requireAuth, setCompanyLabel, setSync, wireLogout } from "./firebase-init.js";
import { collection, query, where, onSnapshot, updateDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let bookings = [];
let cars = [];
let filter = "unpaid";
let ctx = null;

(async function init() {
  ctx = await requireAuth();
  if (!ctx) return;
  document.getElementById("boot").style.display = "none";
  document.getElementById("app").style.display = "block";
  setCompanyLabel(ctx.companyName);
  wireLogout();
  wireUi();

  onSnapshot(query(collection(db, "bookings"), where("companyId", "==", ctx.companyId)), (snap) => {
    bookings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    setSync("live");
    render();
  }, () => setSync("error"));

  onSnapshot(query(collection(db, "cars"), where("companyId", "==", ctx.companyId)), (snap) => {
    cars = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  });
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

function formatAmount(n) {
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function carLabel(carId) {
  const c = cars.find(x => x.id === carId);
  return c ? `${c.year || ""} ${c.make} ${c.model} (${c.plate || "no plate"})`.trim() : "Unknown car";
}

// Rental length in days: each started day counts, minimum 1.
// 17/07 -> 19/07 = 3 days (17th, 18th, 19th).
function rentalDays(b) {
  const ms = new Date(b.endDate) - new Date(b.startDate);
  return Math.max(1, Math.round(ms / 86400000) + 1);
}

// The rate locked onto the booking when it was made; falls back to the car's current rate for old bookings
function rateFor(b) {
  if (typeof b.dailyRate === "number" && b.dailyRate > 0) return b.dailyRate;
  const c = cars.find(x => x.id === b.carId);
  return c?.dailyRate || 0;
}

// Rental total before any deposit is applied
function rentalTotal(b) {
  return rentalDays(b) * rateFor(b);
}

// Advance part-payment already collected (reduces the balance owed)
function advancePaid(b) {
  return typeof b.advancePaid === "number" ? b.advancePaid : 0;
}

// Balance still owed = rental total minus advance already paid (never below 0)
function balanceFor(b) {
  return Math.max(0, rentalTotal(b) - advancePaid(b));
}

// Refundable security deposit currently held (only while status is "held")
function securityHeld(b) {
  return (b.securityDeposit && b.securityStatus === "held") ? b.securityDeposit : 0;
}

// Legacy helper name kept for the mark-paid record: the balance being settled
function amountFor(b) {
  if (b.paid && typeof b.paidAmount === "number") return b.paidAmount;
  return balanceFor(b);
}

// Only bookings that have started (or finished) are billable — future reservations aren't invoices yet
function isBillable(b) {
  return b.startDate <= todayStr() || b.status === "completed";
}

// ---------- UI ----------
function wireUi() {
  document.getElementById("search").addEventListener("input", render);

  document.getElementById("save-deposit-btn").addEventListener("click", saveDeposits);
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

  document.getElementById("invoice-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const id = btn.dataset.id;
    const b = bookings.find(x => x.id === id);
    if (!b) return;

    btn.disabled = true;
    setSync("saving");
    try {
      if (btn.dataset.act === "markpaid") {
        await updateDoc(doc(db, "bookings", id), {
          paid: true,
          paidAmount: amountFor(b),
          paidAt: new Date().toISOString()
        });
      } else if (btn.dataset.act === "markunpaid") {
        await updateDoc(doc(db, "bookings", id), { paid: false, paidAmount: null, paidAt: null });
      } else if (btn.dataset.act === "deposits") {
        openDepositModal(id); btn.disabled = false; return;
      } else if (btn.dataset.act === "refund") {
        await updateDoc(doc(db, "bookings", id), { securityStatus: "refunded" });
      } else if (btn.dataset.act === "keep") {
        await updateDoc(doc(db, "bookings", id), { securityStatus: "kept" });
      }
    } catch (err) {
      alert("Couldn't update (" + (err.code || err.message) + "). Try again.");
      setSync("error");
    }
    btn.disabled = false;
  });
}

// ---------- Render ----------
function render() {
  const search = document.getElementById("search").value.toLowerCase();
  const billable = bookings.filter(isBillable);

  const unpaid = billable.filter(b => !b.paid);
  const outstanding = unpaid.reduce((sum, b) => sum + amountFor(b), 0);

  const now = new Date();
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
  const paidThisMonth = billable
    .filter(b => b.paid && (b.paidAt || "").startsWith(monthPrefix))
    .reduce((sum, b) => sum + amountFor(b), 0);

  const depositsHeld = billable.reduce((sum, b) => sum + securityHeld(b), 0);

  document.getElementById("stats").innerHTML = `
    <div class="stat"><div class="stat-label">Outstanding</div><div class="stat-val red">${formatAmount(outstanding)}</div></div>
    <div class="stat"><div class="stat-label">Unpaid invoices</div><div class="stat-val amber">${unpaid.length}</div></div>
    <div class="stat"><div class="stat-label">Received this month</div><div class="stat-val green">${formatAmount(paidThisMonth)}</div></div>
    <div class="stat"><div class="stat-label">Deposits held</div><div class="stat-val blue">${formatAmount(depositsHeld)}</div></div>
  `;

  let list = billable.filter(b => {
    const mf = filter === "all" || (filter === "paid" ? b.paid : !b.paid);
    const ms = `${b.renter || ""} ${carLabel(b.carId)}`.toLowerCase().includes(search);
    return mf && ms;
  });

  // Unpaid first, newest start date first within each group
  list.sort((a,b) => (a.paid - b.paid) || b.startDate.localeCompare(a.startDate));

  const el = document.getElementById("invoice-list");
  if (list.length === 0) {
    el.innerHTML = '<div class="empty">No invoices here. Invoices appear when a booking starts.</div>';
    return;
  }

  el.innerHTML = list.map(b => {
    const days = rentalDays(b);
    const rate = rateFor(b);
    const total = rentalTotal(b);
    const adv = advancePaid(b);
    const balance = balanceFor(b);
    const noRate = rate === 0;
    const sec = b.securityDeposit || 0;
    const secStatus = b.securityStatus || "held";
    return `
    <div class="item-card ${b.paid ? "completed" : "upcoming"}">
      <div class="card-top">
        <div>
          <div class="card-title">${esc(b.renter)} — ${formatAmount(b.paid ? total : balance)}${b.paid ? "" : " owed"}</div>
          <div class="card-sub">${esc(carLabel(b.carId))}</div>
        </div>
        <span class="badge ${b.paid ? "available" : "overdue"}">${b.paid ? "Paid" : "Unpaid"}</span>
      </div>
      <div class="card-details">
        <span>Period: <strong>${formatDate(b.startDate)} – ${formatDate(b.endDate)}</strong></span>
        <span>${days} day${days === 1 ? "" : "s"} × <strong>${formatAmount(rate)}</strong>/day = <strong>${formatAmount(total)}</strong></span>
        ${adv > 0 ? `<span>Advance paid: <strong>-${formatAmount(adv)}</strong></span>` : ""}
        ${adv > 0 && !b.paid ? `<span>Balance: <strong>${formatAmount(balance)}</strong></span>` : ""}
        ${b.paid && b.paidAt ? `<span>Paid on: <strong>${formatDate(b.paidAt.slice(0,10))}</strong></span>` : ""}
        ${noRate ? `<span style="color:var(--red-text);">No daily rate set on this car — edit the car in Fleet to set one</span>` : ""}
      </div>
      ${sec > 0 ? `
      <div class="card-details" style="margin-top:6px;">
        <span>Security deposit: <strong>${formatAmount(sec)}</strong></span>
        <span>Status: <strong>${secStatus === "held" ? "Held (refundable)" : secStatus === "refunded" ? "Refunded" : "Kept"}</strong></span>
      </div>` : ""}
      <div class="card-actions">
        ${b.paid
          ? `<button class="btn" data-act="markunpaid" data-id="${b.id}">Mark as unpaid</button>`
          : `<button class="btn" data-act="markpaid" data-id="${b.id}">Mark balance paid</button>`}
        <button class="btn" data-act="deposits" data-id="${b.id}">Deposits</button>
        ${sec > 0 && secStatus === "held" ? `
          <button class="btn" data-act="refund" data-id="${b.id}">Refund deposit</button>
          <button class="btn" data-act="keep" data-id="${b.id}">Keep deposit</button>` : ""}
      </div>
    </div>`;
  }).join("");
}


// ---------- Deposit editing ----------
let depositBookingId = null;

function openDepositModal(id) {
  depositBookingId = id;
  const b = bookings.find(x => x.id === id);
  document.getElementById("dep-advance").value = b?.advancePaid || "";
  document.getElementById("dep-security").value = b?.securityDeposit || "";
  document.getElementById("deposit-error").classList.remove("show");
  document.getElementById("deposit-modal").classList.add("open");
}

async function saveDeposits() {
  if (!depositBookingId) return;
  const errEl = document.getElementById("deposit-error");
  errEl.classList.remove("show");
  const advance = parseFloat(document.getElementById("dep-advance").value) || 0;
  const security = parseFloat(document.getElementById("dep-security").value) || 0;
  if (advance < 0 || security < 0) { errEl.textContent = "Amounts can't be negative."; errEl.classList.add("show"); return; }

  const b = bookings.find(x => x.id === depositBookingId);
  const btn = document.getElementById("save-deposit-btn");
  btn.disabled = true; btn.textContent = "Saving...";
  setSync("saving");
  try {
    const update = { advancePaid: advance, securityDeposit: security };
    // Preserve existing security status; default new security deposits to "held"
    if (security > 0 && !b.securityStatus) update.securityStatus = "held";
    if (security === 0) update.securityStatus = null;
    await updateDoc(doc(db, "bookings", depositBookingId), update);
    document.getElementById("deposit-modal").classList.remove("open");
    depositBookingId = null;
  } catch (e) {
    errEl.textContent = "Couldn't save (" + (e.code || e.message) + "). Try again.";
    errEl.classList.add("show");
    setSync("error");
  }
  btn.disabled = false; btn.textContent = "Save deposits";
}

