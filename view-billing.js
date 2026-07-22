// Billing view — each started booking is an invoice, with advance and
// security deposits tracked separately.
import { db, setSync } from "./firebase-init.js";
import { updateDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  state, onDataChange, esc, formatDate, formatAmount, bookingCarLabel,
  rentalDays, rateFor, rentalTotal, advancePaid, balanceFor, securityHeld,
  settledAmount, isBillable,
  el, val, setVal, openModal, closeModal, showError
} from "./store.js";

let root = null;
let filter = "unpaid";
let depositBookingId = null;

export function mount(container) {
  root = container;

  el(root, "search").addEventListener("input", render);
  el(root, "save-deposit").addEventListener("click", saveDeposits);

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
    const b = state.bookings.find(x => x.id === id);
    if (!b) return;

    if (btn.dataset.act === "deposits") { openDepositModal(id); return; }

    btn.disabled = true;
    setSync("saving");
    try {
      if (btn.dataset.act === "markpaid") {
        await updateDoc(doc(db, "bookings", id), {
          paid: true, paidAmount: settledAmount(b), paidAt: new Date().toISOString()
        });
      } else if (btn.dataset.act === "markunpaid") {
        await updateDoc(doc(db, "bookings", id), { paid: false, paidAmount: null, paidAt: null });
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

  onDataChange(() => { if (root.classList.contains("active")) render(); });
}

export function render() {
  if (!root) return;
  const search = el(root, "search").value.toLowerCase();
  const billable = state.bookings.filter(isBillable);

  const unpaid = billable.filter(b => !b.paid);
  const outstanding = unpaid.reduce((sum, b) => sum + balanceFor(b), 0);

  const now = new Date();
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const paidThisMonth = billable
    .filter(b => b.paid && (b.paidAt || "").startsWith(monthPrefix))
    .reduce((sum, b) => sum + settledAmount(b), 0);

  const depositsHeld = billable.reduce((sum, b) => sum + securityHeld(b), 0);

  el(root, "stats").innerHTML = `
    <div class="stat"><div class="stat-label">Outstanding</div><div class="stat-val red">${formatAmount(outstanding)}</div></div>
    <div class="stat"><div class="stat-label">Unpaid invoices</div><div class="stat-val amber">${unpaid.length}</div></div>
    <div class="stat"><div class="stat-label">Received this month</div><div class="stat-val green">${formatAmount(paidThisMonth)}</div></div>
    <div class="stat"><div class="stat-label">Deposits held</div><div class="stat-val blue">${formatAmount(depositsHeld)}</div></div>
  `;

  let list = billable.filter(b => {
    const mf = filter === "all" || (filter === "paid" ? b.paid : !b.paid);
    const ms = `${b.renter || ""} ${bookingCarLabel(b)}`.toLowerCase().includes(search);
    return mf && ms;
  });
  list.sort((a, b) => (a.paid - b.paid) || b.startDate.localeCompare(a.startDate));

  const listEl = el(root, "list");
  if (list.length === 0) {
    listEl.innerHTML = '<div class="empty">No invoices here. Invoices appear when a booking starts.</div>';
    return;
  }

  listEl.innerHTML = list.map(b => {
    const days = rentalDays(b);
    const rate = rateFor(b);
    const total = rentalTotal(b);
    const adv = advancePaid(b);
    const balance = balanceFor(b);
    const sec = b.securityDeposit || 0;
    const secStatus = b.securityStatus || "held";
    return `
    <div class="item-card ${b.paid ? "completed" : "upcoming"}">
      <div class="card-top">
        <div>
          <div class="card-title">${esc(b.renter)} — ${formatAmount(b.paid ? total : balance)}${b.paid ? "" : " owed"}</div>
          <div class="card-sub">${esc(bookingCarLabel(b))}</div>
        </div>
        <span class="badge ${b.paid ? "available" : "overdue"}">${b.paid ? "Paid" : "Unpaid"}</span>
      </div>
      <div class="card-details">
        <span>Period: <strong>${formatDate(b.startDate)} – ${formatDate(b.endDate)}</strong></span>
        <span>${days} day${days === 1 ? "" : "s"} × <strong>${formatAmount(rate)}</strong>/day = <strong>${formatAmount(total)}</strong></span>
        ${adv > 0 ? `<span>Advance paid: <strong>-${formatAmount(adv)}</strong></span>` : ""}
        ${adv > 0 && !b.paid ? `<span>Balance: <strong>${formatAmount(balance)}</strong></span>` : ""}
        ${b.paid && b.paidAt ? `<span>Paid on: <strong>${formatDate(b.paidAt.slice(0, 10))}</strong></span>` : ""}
        ${rate === 0 ? `<span style="color:var(--red-text);">No daily rate set on this car — edit the car in Fleet to set one</span>` : ""}
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

function openDepositModal(id) {
  depositBookingId = id;
  const b = state.bookings.find(x => x.id === id);
  setVal(root, "dep-advance", b?.advancePaid || "");
  setVal(root, "dep-security", b?.securityDeposit || "");
  showError(root, "deposit-error", null);
  openModal(root, "deposit-modal");
}

async function saveDeposits() {
  if (!depositBookingId) return;
  showError(root, "deposit-error", null);

  const advance = parseFloat(val(root, "dep-advance")) || 0;
  const security = parseFloat(val(root, "dep-security")) || 0;
  if (advance < 0 || security < 0) {
    showError(root, "deposit-error", "Amounts can't be negative."); return;
  }

  const b = state.bookings.find(x => x.id === depositBookingId);
  const btn = el(root, "save-deposit");
  btn.disabled = true; btn.textContent = "Saving...";
  setSync("saving");
  try {
    const update = { advancePaid: advance, securityDeposit: security };
    if (security > 0 && !b.securityStatus) update.securityStatus = "held";
    if (security === 0) update.securityStatus = null;
    await updateDoc(doc(db, "bookings", depositBookingId), update);
    closeModal(root, "deposit-modal");
    depositBookingId = null;
  } catch (e) {
    showError(root, "deposit-error", "Couldn't save (" + (e.code || e.message) + "). Try again.");
    setSync("error");
  }
  btn.disabled = false; btn.textContent = "Save deposits";
}
