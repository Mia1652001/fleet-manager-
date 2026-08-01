// Settings — the company's own details, and how its data gets backed up.
//
// Company details live in a `settings` collection, one document per company,
// keyed by companyId. Anyone signed in to the company can read and edit them, so
// the office does not have to come back to the Firebase console for a phone
// number. Backup preferences deliberately stay on the device instead: the folder
// a backup writes into belongs to one computer and means nothing on another.

import { db, setSync } from "./firebase-init.js";
import { doc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { state, onDataChange, esc, el, val, setVal, showError, FX_CURRENCIES } from "./store.js";
import {
  CATEGORIES, INTERVALS, backupPrefs, saveBackupPrefs, daysSinceBackup,
  runBackup, folderSupported, folderStatus, chooseFolder, forgetFolder
} from "./backup.js";

let root = null;
let logoData = null;        // data URL held until Save is pressed
let logoTouched = false;    // so saving without touching the logo leaves it alone

// A logo goes into the Firestore document itself as text, because Firebase
// Storage needs a paid plan. A document has a 1MB ceiling and base64 inflates by
// about a third, so the image is shrunk hard before it is stored. 320px is ample
// for a screen and for a printed invoice header later.
const LOGO_MAX_PX = 320;
const LOGO_MAX_BYTES = 180 * 1024;

const CURRENCY_PRESETS = [
  { label: "Mauritian rupee — Rs", value: "Rs" },
  { label: "Euro — €", value: "€" },
  { label: "US dollar — $", value: "$" },
  { label: "Pound — £", value: "£" },
  { label: "Indian rupee — ₹", value: "₹" },
  { label: "South African rand — R", value: "R" }
];

export function mount(container) {
  root = container;

  const presets = el(root, "s-currency-preset");
  presets.innerHTML = `<option value="">Choose a currency…</option>` +
    CURRENCY_PRESETS.map(c => `<option value="${esc(c.value)}">${esc(c.label)}</option>`).join("");
  presets.addEventListener("change", () => {
    if (presets.value) setVal(root, "s-currency", presets.value);
  });

  el(root, "s-interval").innerHTML =
    INTERVALS.map(i => `<option value="${i.key}">${esc(i.label)}</option>`).join("");

  el(root, "s-categories").innerHTML = CATEGORIES.map(c => `
    <label class="check-row">
      <input type="checkbox" data-cat="${c.key}"> <span>${esc(c.label)}</span>
    </label>`).join("");

  // One row per foreign currency: "1 € = Rs ___". Built once; values are
  // filled on render like every other settings field. A single grid rather
  // than one row per currency, so every input lines up against the longest
  // label instead of each row placing its own box.
  const fxBox = el(root, "s-fxrates");
  fxBox.style.cssText = "display:grid;grid-template-columns:max-content minmax(110px,160px);gap:8px 12px;align-items:center;";
  fxBox.innerHTML = FX_CURRENCIES.map(c => `
    <label data-fxrow="${esc(c.sym)}" style="white-space:nowrap;margin:0;">1 ${esc(c.sym)} (${esc(c.label)}) =</label>
    <input type="number" min="0" step="any" data-fxrate="${esc(c.sym)}" data-fxrow="${esc(c.sym)}"
      placeholder="e.g. 48">`).join("");

  el(root, "save-settings").addEventListener("click", saveSettings);
  el(root, "s-logo-file").addEventListener("change", onLogoPicked);
  el(root, "s-logo-clear").addEventListener("click", () => {
    logoData = null; logoTouched = true; paintLogo();
  });

  el(root, "backup-now").addEventListener("click", () => doBackup());
  el(root, "s-choose-folder").addEventListener("click", pickFolder);
  el(root, "s-forget-folder").addEventListener("click", async () => {
    await forgetFolder();
    saveBackupPrefs({ auto: false });
    renderBackup();
  });

  // Backup preferences save as they are changed — there is no Save button in
  // that section, so nothing should need pressing to make a choice stick.
  el(root, "s-interval").addEventListener("change", () => {
    saveBackupPrefs({ interval: el(root, "s-interval").value });
    renderBackup();
  });
  el(root, "s-categories").addEventListener("change", () => {
    const chosen = Array.from(root.querySelectorAll("[data-cat]"))
      .filter(c => c.checked).map(c => c.dataset.cat);
    saveBackupPrefs({ categories: chosen });
    renderBackup();
  });
  el(root, "s-auto").addEventListener("change", () => {
    saveBackupPrefs({ auto: el(root, "s-auto").checked });
    renderBackup();
  });

  onDataChange(() => { if (root.classList.contains("active")) render(); });
}

export function render() {
  if (!root) return;
  const s = state.settings || {};

  // Only refill the form when the user is not part-way through editing it, so a
  // colleague's save elsewhere does not overwrite what is being typed.
  if (document.activeElement && root.contains(document.activeElement)) {
    renderBackup();
    return;
  }

  setVal(root, "s-name", s.companyName || state.ctx?.companyName || "");
  setVal(root, "s-phone", s.phone || "");
  setVal(root, "s-email", s.email || "");
  setVal(root, "s-address", s.address || "");
  setVal(root, "s-currency", s.currency || "");
  // Show the matching preset rather than "Choose a currency…" next to a symbol
  // that is plainly already set — it reads as though nothing has been chosen.
  const preset = el(root, "s-currency-preset");
  preset.value = CURRENCY_PRESETS.some(c => c.value === (s.currency || "")) ? s.currency : "";
  setVal(root, "s-terms", s.terms || "");
  setVal(root, "s-note", s.messageNote || "");
  setVal(root, "s-locations", linesFrom(s.locations));
  setVal(root, "s-staff", linesFrom(s.staff));
  setVal(root, "s-brokers", linesFrom(s.brokers));
  setVal(root, "s-expense-categories", linesFrom(s.expenseCategories));
  root.querySelectorAll("[data-fxrate]").forEach(inp => {
    const r = s.fxRates?.[inp.dataset.fxrate];
    inp.value = (typeof r === "number" && r > 0) ? r : "";
  });
  // No rate row for the company's own currency — "1 Rs in Rs" means nothing.
  const home = (s.currency || "Rs").trim();
  root.querySelectorAll("[data-fxrow]").forEach(row => {
    row.style.display = row.dataset.fxrow === home ? "none" : "";
  });

  if (!logoTouched) logoData = s.logo || null;
  paintLogo();
  renderBackup();
}

// ---------- Lists ----------
// Stored as arrays but edited as lines of text, which is far quicker than a row
// of add-and-remove buttons when someone is entering a dozen place names.

function linesFrom(arr) {
  return Array.isArray(arr) ? arr.join("\n") : "";
}

// The house rates as an object keyed by symbol; only positive numbers are
// kept, so a cleared field simply removes that currency's rate.
function collectFxRates() {
  const out = {};
  root.querySelectorAll("[data-fxrate]").forEach(inp => {
    const n = parseFloat(inp.value);
    if (Number.isFinite(n) && n > 0) out[inp.dataset.fxrate] = n;
  });
  return out;
}

function linesTo(text) {
  // Duplicates are dropped case-insensitively, so "Airport" and "airport" do not
  // both end up in the list and produce two suggestions for one place.
  const seen = new Map();
  String(text || "").split("\n").forEach(line => {
    const v = line.trim();
    if (!v) return;
    const k = v.toLowerCase();
    if (!seen.has(k)) seen.set(k, v);
  });
  return Array.from(seen.values());
}

// ---------- Logo ----------
function paintLogo() {
  const box = el(root, "s-logo-preview");
  box.innerHTML = logoData
    ? `<img src="${logoData}" alt="Company logo">`
    : `<span class="logo-empty">No logo yet</span>`;
  el(root, "s-logo-clear").style.display = logoData ? "inline-block" : "none";
}

function onLogoPicked(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  showError(root, "settings-error", null);

  if (!/^image\//.test(file.type)) {
    showError(root, "settings-error", "That file is not an image.");
    e.target.value = ""; return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      // Shrink in the browser before storing. Sending a phone photo straight to
      // the database would blow the document limit several times over.
      const scale = Math.min(1, LOGO_MAX_PX / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);

      // PNG keeps a flat logo crisp; a photograph is far smaller as JPEG. Try
      // PNG first and fall back when it comes out too heavy.
      let data = canvas.toDataURL("image/png");
      if (data.length > LOGO_MAX_BYTES) data = canvas.toDataURL("image/jpeg", 0.82);
      if (data.length > LOGO_MAX_BYTES) {
        showError(root, "settings-error",
          "That image is too detailed to store. Try a smaller or simpler logo.");
        return;
      }
      logoData = data;
      logoTouched = true;
      paintLogo();
    };
    img.onerror = () => showError(root, "settings-error", "That image could not be read.");
    img.src = reader.result;
  };
  reader.onerror = () => showError(root, "settings-error", "That file could not be read.");
  reader.readAsDataURL(file);
  e.target.value = "";
}

// ---------- Backup section ----------
async function renderBackup() {
  const p = backupPrefs();

  el(root, "s-interval").value = p.interval;
  root.querySelectorAll("[data-cat]").forEach(c => {
    c.checked = p.categories.includes(c.dataset.cat);
  });
  el(root, "s-auto").checked = p.auto;

  const since = daysSinceBackup();
  el(root, "s-last").textContent =
    since === null ? "No backup taken yet."
    : since === 0 ? "Last backup: today."
    : since === 1 ? "Last backup: yesterday."
    : `Last backup: ${since} days ago.`;
  el(root, "s-last").className = "settings-note" + (since === null || since > 14 ? " warn" : "");

  // Say plainly which of the two modes is actually in force. Someone who thinks
  // backups are automatic when they are not is worse off than someone who knows
  // they have to press a button.
  const box = el(root, "s-folder-state");
  if (!folderSupported()) {
    el(root, "s-choose-folder").style.display = "none";
    el(root, "s-forget-folder").style.display = "none";
    el(root, "s-auto-row").style.display = "none";
    box.innerHTML = `This browser can't save straight into a folder — that needs
      Chrome or Edge on a computer. Backups here download as a file instead,
      and the reminder above still works.`;
    return;
  }

  const st = await folderStatus();
  el(root, "s-auto-row").style.display = "";
  el(root, "s-choose-folder").style.display = "inline-block";
  el(root, "s-choose-folder").textContent = st.name ? "Change folder" : "Choose a folder";
  el(root, "s-forget-folder").style.display = st.name ? "inline-block" : "none";

  if (!st.name) {
    box.innerHTML = `Pick a folder and backups will be written straight into it,
      with no download to click. Pick one to switch this on.`;
  } else if (!st.ready) {
    box.innerHTML = `Folder: <strong>${esc(st.name)}</strong> — permission needs
      confirming again. Press <strong>Back up now</strong> once and the browser
      will ask; after that it is silent again.`;
  } else if (!p.auto) {
    box.innerHTML = `Folder: <strong>${esc(st.name)}</strong>. Tick the box above
      to write backups there automatically when one is due.`;
  } else {
    box.innerHTML = `Folder: <strong>${esc(st.name)}</strong>. Backups are written
      there automatically when the app is opened and one is due. Nothing runs
      while the app is closed — a browser cannot do that without a server.`;
  }
}

async function pickFolder() {
  showError(root, "settings-error", null);
  try {
    const name = await chooseFolder();
    saveBackupPrefs({ auto: true });
    await renderBackup();
    el(root, "backup-result").textContent = `Folder set to "${name}".`;
  } catch (e) {
    if (e && e.name === "AbortError") return;      // simply cancelled
    showError(root, "settings-error", "Couldn't set that folder (" + (e.message || e.name) + ").");
  }
}

export async function doBackup() {
  const btn = el(root, "backup-now");
  const out = el(root, "backup-result");
  btn.disabled = true; btn.textContent = "Backing up...";
  out.textContent = "";
  showError(root, "settings-error", null);
  try {
    const r = await runBackup({ mayPrompt: true });
    out.textContent = r.ok
      ? `${r.filename} — ${r.format}, ${r.where}.`
      : "";
    if (!r.ok) showError(root, "settings-error", r.reason);
  } catch (e) {
    showError(root, "settings-error", "Backup failed (" + (e.message || e.name) + ").");
  }
  btn.disabled = false; btn.textContent = "Back up now";
  await renderBackup();
}

// ---------- Saving company details ----------
async function saveSettings() {
  showError(root, "settings-error", null);

  const name = val(root, "s-name");
  if (!name) { showError(root, "settings-error", "Please enter the company name."); return; }

  const data = {
    companyId: state.ctx.companyId,
    companyName: name,
    phone: val(root, "s-phone"),
    email: val(root, "s-email"),
    address: val(root, "s-address"),
    currency: val(root, "s-currency"),
    terms: val(root, "s-terms"),
    messageNote: val(root, "s-note"),
    locations: linesTo(val(root, "s-locations")),
    staff: linesTo(val(root, "s-staff")),
    brokers: linesTo(val(root, "s-brokers")),
    expenseCategories: linesTo(val(root, "s-expense-categories")),
    fxRates: collectFxRates(),
    updatedAt: new Date().toISOString()
  };
  if (logoTouched) data.logo = logoData || null;

  const btn = el(root, "save-settings");
  btn.disabled = true; btn.textContent = "Saving...";
  setSync("saving");
  try {
    // One document per company, so this is a write to a known id rather than a
    // new record each time. merge keeps any field this form does not manage.
    await setDoc(doc(db, "settings", state.ctx.companyId), data, { merge: true });
    logoTouched = false;
    el(root, "settings-saved").textContent = "Saved.";
    setTimeout(() => { const n = el(root, "settings-saved"); if (n) n.textContent = ""; }, 2500);
  } catch (e) {
    showError(root, "settings-error", "Couldn't save (" + (e.code || e.message) + "). Try again.");
    setSync("error");
  }
  btn.disabled = false; btn.textContent = "Save company details";
}
