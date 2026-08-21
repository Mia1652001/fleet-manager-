// Settings — the company's own details, and how its data gets backed up.
//
// Company details live in a `settings` collection, one document per company,
// keyed by companyId. Anyone signed in to the company can read and edit them, so
// the office does not have to come back to the Firebase console for a phone
// number. Backup preferences deliberately stay on the device instead: the folder
// a backup writes into belongs to one computer and means nothing on another.

import { db, setSync, auth, updatePassword, EmailAuthProvider, reauthenticateWithCredential } from "./firebase-init.js";
import { doc, setDoc, deleteField } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { state, onDataChange, esc, el, val, setVal, checked, setChecked, showError, showToast, FX_CURRENCIES, THEME_LIST, themePresetOf, themeVars, applyTheme, FONT_LIST, themeFontOf, extraEntities, openModal, closeModal } from "./store.js";
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

// The same four currencies the booking form offers, in the same order — a
// symbol offered here but not there would be pickable as the home currency
// and then unavailable on a booking. The box below the list still accepts any
// symbol typed by hand, so a company outside this list is not shut out.
const CURRENCY_PRESETS = [
  { label: "Mauritian rupee — Rs", value: "Rs" },
  { label: "Euro — €", value: "€" },
  { label: "US dollar — $", value: "$" },
  { label: "Pound — £", value: "£" }
];

// ---------- Theme draft ----------
// What the person has clicked but not yet saved. null means "follow whatever
// is saved". Applied to the screen immediately so choosing a theme is seeing
// it; written to the database only by Save, like every other setting.
let themeDraft = { preset: null, bg: null, accent: null, font: null, text: null, headInk: null };

function effectiveTheme() {
  const s = state.settings || {};
  return {
    themePreset: themeDraft.preset !== null ? themeDraft.preset : themePresetOf(s),
    themeBg: themeDraft.bg !== null ? themeDraft.bg : (s.themeBg || ""),
    themeAccent: themeDraft.accent !== null ? themeDraft.accent : (s.themeAccent || ""),
    themeFont: themeDraft.font !== null ? themeDraft.font : themeFontOf(s),
    themeText: themeDraft.text !== null ? themeDraft.text : (s.themeText || ""),
    themeHeadInk: themeDraft.headInk !== null ? themeDraft.headInk : (s.themeHeadInk || "")
  };
}

function paintThemeControls() {
  const grid = el(root, "theme-presets");
  if (!grid) return;
  const eff = effectiveTheme();
  grid.innerHTML = THEME_LIST.map(t => `
    <button type="button" class="theme-opt${t.key === eff.themePreset ? " selected" : ""}" data-theme="${t.key}">
      <span class="theme-chips">
        <span class="theme-chip" style="background:${t.bg}"></span>
        <span class="theme-chip" style="background:${t.accent}"></span>
      </span>
      ${esc(t.name)}
    </button>`).join("");
  const vars = themeVars(eff);
  const bgIn = el(root, "s-theme-bg");
  if (bgIn) bgIn.value = eff.themeBg || vars["--bg"];
  const acIn = el(root, "s-theme-accent");
  if (acIn) acIn.value = eff.themeAccent || vars["--accent"];
  const fSel = el(root, "s-theme-font");
  if (fSel) {
    if (!fSel.options.length) fSel.innerHTML = FONT_LIST.map(f =>
      `<option value="${f.key}">${esc(f.name)}</option>`).join("");
    fSel.value = eff.themeFont;
  }
  const txIn = el(root, "s-theme-text");
  if (txIn) txIn.value = eff.themeText || vars["--text"];
  const hkIn = el(root, "s-theme-headink");
  if (hkIn) hkIn.value = eff.themeHeadInk || vars["--accent-ink"];
}

function previewTheme() {
  applyTheme(effectiveTheme());
  paintThemeControls();
}

// ---------- Trading companies ----------
let entEditingId = null;   // null = adding a new one
let entLogoDraft = undefined;   // undefined = untouched, "" = removed, string = new data URL

function paintEntities() {
  const box = el(root, "ent-list");
  if (!box) return;
  const list = extraEntities();
  box.innerHTML = list.length ? list.map(e => `
    <div class="ent-row" data-ent="${esc(e.id)}">
      <span class="ent-row-name">${esc(e.name || "(unnamed)")}</span>
      <span class="ent-row-sub">${esc(e.prefix || "")}${e.vatRegistered ? " · VAT" : ""}</span>
      <button type="button" class="btn" data-ent-edit="${esc(e.id)}">Edit</button>
    </div>`).join("")
    : `<div class="ent-row" style="color:var(--muted);">Only the main company so far.</div>`;
}

function openEntModal(id) {
  entEditingId = id || null;
  entLogoDraft = undefined;
  const e = extraEntities().find(x => x.id === id) || {};
  el(root, "ent-title").textContent = id ? "Edit company" : "New company";
  showError(root, "ent-error", null);
  setVal(root, "ent-name", e.name || "");
  setVal(root, "ent-addr", e.addr || "");
  setVal(root, "ent-phone", e.phone || "");
  setVal(root, "ent-email", e.email || "");
  setVal(root, "ent-brn", e.brn || "");
  setVal(root, "ent-prefix", e.prefix || "");
  setChecked(root, "ent-vatreg", !!e.vatRegistered);
  setVal(root, "ent-vat", e.vatNumber || "");
  el(root, "ent-logo").value = "";
  el(root, "ent-logo-now").textContent = e.logo ? "Has a logo — choose a file to replace it." : "";
  el(root, "ent-remove").style.display = id ? "" : "none";
  openModal(root, "ent-modal");
}

// Logos print at most a few centimetres wide, so they are shrunk hard on the
// way in — several of them must share the settings record's fixed size limit.
function compressLogo(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, 320 / img.width, 160 / img.height);
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.width * scale));
      c.height = Math.max(1, Math.round(img.height * scale));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      // PNG keeps transparency; fall to JPEG when PNG comes out heavy
      let out = c.toDataURL("image/png");
      if (out.length > 80000) out = c.toDataURL("image/jpeg", 0.82);
      if (out.length > 120000) return reject(new Error("That image stays too large even compressed — try a simpler logo file."));
      resolve(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file could not be read as an image.")); };
    img.src = url;
  });
}

async function saveEntity() {
  const name = val(root, "ent-name").trim();
  if (!name) { showError(root, "ent-error", "The company needs a name — it prints at the top of its documents."); return; }
  const prefix = val(root, "ent-prefix").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 8);
  const btn = el(root, "ent-save");
  btn.disabled = true;
  setSync("saving");
  try {
    const list = extraEntities().map(e => ({ ...e }));
    let e;
    if (entEditingId) {
      e = list.find(x => x.id === entEditingId);
      if (!e) throw new Error("not-found");
    } else {
      e = { id: "e" + Date.now().toString(36) };
      list.push(e);
    }
    Object.assign(e, {
      name, addr: val(root, "ent-addr"), phone: val(root, "ent-phone"),
      email: val(root, "ent-email"), brn: val(root, "ent-brn"), prefix,
      vatRegistered: checked(root, "ent-vatreg"), vatNumber: val(root, "ent-vat")
    });
    if (entLogoDraft !== undefined) e.logo = entLogoDraft;
    await setDoc(doc(db, "settings", state.ctx.companyId),
      { companyId: state.ctx.companyId, entities: list }, { merge: true });
    setSync("live");
    closeModal(root, "ent-modal");
    showToast(`${name} saved`);
  } catch (err) {
    setSync("error");
    showError(root, "ent-error", "Couldn't save the company (" + (err.code || err.message) + ").");
  }
  btn.disabled = false;
}

async function removeEntity() {
  if (!entEditingId) return;
  const e = extraEntities().find(x => x.id === entEditingId);
  const used = state.cars.filter(c => c.entityId === entEditingId).length;
  const msg = used
    ? `Remove ${e?.name || "this company"}? ${used} car${used === 1 ? " is" : "s are"} tagged to it — they will fall back to the main company on their documents.`
    : `Remove ${e?.name || "this company"}?`;
  if (!confirm(msg)) return;
  setSync("saving");
  try {
    const list = extraEntities().filter(x => x.id !== entEditingId);
    await setDoc(doc(db, "settings", state.ctx.companyId),
      { companyId: state.ctx.companyId, entities: list }, { merge: true });
    setSync("live");
    closeModal(root, "ent-modal");
    showToast("Company removed — tagged cars fall back to the main company");
  } catch (err) {
    setSync("error");
    showError(root, "ent-error", "Couldn't remove it (" + (err.code || err.message) + ").");
  }
}

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
  const pwBtn = el(root, "pw-change");
  if (pwBtn) pwBtn.addEventListener("click", changePassword);

  const themeGrid = el(root, "theme-presets");
  if (themeGrid) themeGrid.addEventListener("click", (e) => {
    const b = e.target.closest("[data-theme]");
    if (!b) return;
    themeDraft.preset = b.dataset.theme;
    // A new theme starts clean: custom colours picked against the old one
    // rarely survive the change of everything around them.
    themeDraft.bg = ""; themeDraft.accent = "";
    themeDraft.text = ""; themeDraft.headInk = "";
    previewTheme();
  });
  const tBg = el(root, "s-theme-bg");
  if (tBg) tBg.addEventListener("input", () => { themeDraft.bg = tBg.value; previewTheme(); });
  const tAc = el(root, "s-theme-accent");
  if (tAc) tAc.addEventListener("input", () => { themeDraft.accent = tAc.value; previewTheme(); });
  const tBgClear = el(root, "s-theme-bg-clear");
  if (tBgClear) tBgClear.addEventListener("click", () => { themeDraft.bg = ""; previewTheme(); });
  const tAcClear = el(root, "s-theme-accent-clear");
  if (tAcClear) tAcClear.addEventListener("click", () => { themeDraft.accent = ""; previewTheme(); });
  const tFont = el(root, "s-theme-font");
  if (tFont) tFont.addEventListener("change", () => { themeDraft.font = tFont.value; previewTheme(); });
  const tText = el(root, "s-theme-text");
  if (tText) tText.addEventListener("input", () => { themeDraft.text = tText.value; previewTheme(); });
  const tTextClear = el(root, "s-theme-text-clear");
  if (tTextClear) tTextClear.addEventListener("click", () => { themeDraft.text = ""; previewTheme(); });
  const tHk = el(root, "s-theme-headink");
  if (tHk) tHk.addEventListener("input", () => { themeDraft.headInk = tHk.value; previewTheme(); });
  const tHkClear = el(root, "s-theme-headink-clear");
  if (tHkClear) tHkClear.addEventListener("click", () => { themeDraft.headInk = ""; previewTheme(); });

  // Settings had no popups before the entity modal, so the standard
  // data-close wiring every other view does in mount was missing here —
  // which is why Cancel did nothing (pilot, 21 Aug).
  root.querySelectorAll("[data-close]").forEach(b =>
    b.addEventListener("click", () => closeModal(root, b.dataset.close)));

  el(root, "ent-add").addEventListener("click", () => openEntModal(null));
  el(root, "ent-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-ent-edit]");
    if (b) openEntModal(b.dataset.entEdit);
  });
  el(root, "ent-save").addEventListener("click", saveEntity);
  el(root, "ent-remove").addEventListener("click", removeEntity);
  el(root, "ent-logo").addEventListener("change", async () => {
    const f = el(root, "ent-logo").files?.[0];
    if (!f) return;
    try {
      entLogoDraft = await compressLogo(f);
      el(root, "ent-logo-now").textContent = "New logo ready — Save company keeps it.";
    } catch (err) {
      showError(root, "ent-error", err.message);
      el(root, "ent-logo").value = "";
    }
  });
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

  // The trading-companies list follows the data. (Its one call previously sat
  // inside previewTheme — companies saved to the server but never appeared
  // unless the person happened to touch the theme controls. Pilot, 20 Aug.)
  paintEntities();

  // Whose password the card changes — filled before the focus check below, so
  // it is right even when the rest of the form is skipped mid-edit.
  {
    const who = el(root, "pw-email");
    if (who) who.textContent = state.ctx?.user?.email || "\u2014";
  }

  // The theme swatches live in this view but the theme itself is applied
  // globally, so the picker repaints on every render to reflect what is
  // actually on screen — draft included.
  paintThemeControls();

  // Only refill the form when the user is not part-way through editing it, so a
  // colleague's save elsewhere does not overwrite what is being typed.
  if (document.activeElement && root.contains(document.activeElement)) {
    renderBackup();
    return;
  }

  setVal(root, "s-name", s.companyName || state.ctx?.companyName || "");
  setVal(root, "s-phone", s.phone || "");
  setVal(root, "s-email", s.email || "");
  setVal(root, "s-website", s.website || "");
  setVal(root, "s-address", s.address || "");
  setVal(root, "s-currency", s.currency || "");
  setVal(root, "s-receiptprefix", s.receiptPrefix || "");
  setVal(root, "s-bankcharge",
    (typeof s.bankChargePct === "number" && s.bankChargePct > 0) ? s.bankChargePct : "");
  setVal(root, "s-licence-number", s.licenceNumber || "");
  setVal(root, "s-licence-fleet",
    (typeof s.licenceFleet === "number" && s.licenceFleet > 0) ? s.licenceFleet : "");
  setVal(root, "s-licence-start", s.licenceStart || "");
  setVal(root, "s-licence-end", s.licenceEnd || "");
  setChecked(root, "s-vat-registered", !!s.vatRegistered);
  setVal(root, "s-vat-number", s.vatNumber || "");
  setVal(root, "s-vat-rate",
    (typeof s.vatRate === "number" && s.vatRate > 0) ? s.vatRate : "");
  setVal(root, "s-brn", s.brn || "");
  setVal(root, "s-invoice-note", s.invoiceNote || "");
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

// The house rates as an object keyed by symbol. A cleared field must actually
// remove that currency's rate from the database: the save uses merge:true,
// which deep-merges maps, so simply leaving the key out kept the old rate
// alive — clearing a rate on screen did nothing and it came straight back.
// deleteField() is Firestore's way of saying "remove this key" inside a merge.
function collectFxRates() {
  const out = {};
  root.querySelectorAll("[data-fxrate]").forEach(inp => {
    const n = parseFloat(inp.value);
    out[inp.dataset.fxrate] = (Number.isFinite(n) && n > 0) ? n : deleteField();
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

// ---------- Changing your own password ----------
// Firebase requires a recent sign-in before it will change a password, so the
// current password is asked for and checked first (reauthentication) — which
// is also what stops anyone at an unlocked screen quietly changing it.
//
// Passwords are read raw, never through val(): val() trims whitespace, and a
// password that genuinely starts or ends with a space must survive intact.
async function changePassword() {
  showError(root, "pw-error", null);
  const saved = el(root, "pw-saved");
  if (saved) saved.textContent = "";

  const user = auth.currentUser;
  if (!user || !user.email) {
    showError(root, "pw-error", "Not signed in — reload the page and sign in again.");
    return;
  }

  const current = el(root, "pw-current").value;
  const next = el(root, "pw-new").value;
  const again = el(root, "pw-new2").value;

  if (!current) { showError(root, "pw-error", "Enter your current password first."); return; }
  if (next.length < 8) {
    // Firebase's own floor is 6; 8 costs nothing to type and rules out the
    // very shortest passwords without inventing complexity rules nobody keeps.
    showError(root, "pw-error", "The new password needs at least 8 characters.");
    return;
  }
  if (next !== again) { showError(root, "pw-error", "The two new passwords don't match."); return; }
  if (next === current) { showError(root, "pw-error", "The new password is the same as the current one."); return; }

  const btn = el(root, "pw-change");
  btn.disabled = true; btn.textContent = "Changing...";
  setSync("saving");
  try {
    await reauthenticateWithCredential(user,
      EmailAuthProvider.credential(user.email, current));
    await updatePassword(user, next);

    ["pw-current", "pw-new", "pw-new2"].forEach(n => { el(root, n).value = ""; });
    setSync("live");
    if (saved) saved.textContent = "Password changed.";
    // Firebase signs this user out everywhere else when the password changes;
    // this device stays signed in. Said out loud, or a colleague's phone
    // suddenly showing the login screen looks like a fault.
    showToast("Password changed — any other device signed in as you will need the new one");
  } catch (e) {
    setSync("error");
    const code = e.code || "";
    showError(root, "pw-error",
      /wrong-password|invalid-credential|invalid-login-credentials/.test(code)
        ? "The current password is wrong."
        : /weak-password/.test(code)
        ? "That new password is too weak — choose a longer one."
        : /too-many-requests/.test(code)
        ? "Too many attempts — wait a few minutes and try again."
        : /network|unavailable|timeout/i.test(code + (e.message || ""))
        ? "Couldn't reach the server. Check the connection and try again."
        : "Couldn't change the password (" + (code || e.message) + "). Try again.");
  }
  btn.disabled = false; btn.textContent = "Change password";
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
    website: val(root, "s-website"),
    address: val(root, "s-address"),
    currency: val(root, "s-currency"),
    // Uppercased and stripped here as well as on the way out, so what is
    // stored is exactly what a receipt will print.
    receiptPrefix: val(root, "s-receiptprefix").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 8),
    // Blank means "we never take cards" and must stay distinguishable
    // from a rate of zero, so it is stored as null rather than 0.
    bankChargePct: (function () {
      const n = parseFloat(val(root, "s-bankcharge"));
      return Number.isFinite(n) && n > 0 ? n : null;
    })(),
    // Company operating licence — the Dashboard reads these for its warnings.
    // Blank fleet size means "not tracked" and is stored as null, the same
    // rule as the bank charge above.
    licenceNumber: val(root, "s-licence-number"),
    licenceFleet: (function () {
      const n = parseFloat(val(root, "s-licence-fleet"));
      return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
    })(),
    licenceStart: val(root, "s-licence-start"),
    licenceEnd: val(root, "s-licence-end"),
    // VAT & invoicing. The rate is stored only when it differs from blank —
    // blank means "the standard 15%", exactly like the bank charge's blank.
    vatRegistered: checked(root, "s-vat-registered"),
    vatNumber: val(root, "s-vat-number"),
    vatRate: (function () {
      const n = parseFloat(val(root, "s-vat-rate"));
      return Number.isFinite(n) && n > 0 ? n : null;
    })(),
    brn: val(root, "s-brn"),
    // Printed at the foot of every invoice — bank details for payment being
    // the case that asked for it (pilot, Aug 2026).
    invoiceNote: val(root, "s-invoice-note"),
    // Appearance — whatever is on screen right now is what Save keeps.
    themePreset: effectiveTheme().themePreset,
    themeBg: effectiveTheme().themeBg,
    themeAccent: effectiveTheme().themeAccent,
    themeFont: effectiveTheme().themeFont,
    themeText: effectiveTheme().themeText,
    themeHeadInk: effectiveTheme().themeHeadInk,
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
    // The saved theme is now the theme; the draft has nothing left to say.
    themeDraft = { preset: null, bg: null, accent: null, font: null, text: null, headInk: null };
    el(root, "settings-saved").textContent = "Saved.";
    setTimeout(() => { const n = el(root, "settings-saved"); if (n) n.textContent = ""; }, 2500);
  } catch (e) {
    showError(root, "settings-error", "Couldn't save (" + (e.code || e.message) + "). Try again.");
    setSync("error");
  }
  btn.disabled = false; btn.textContent = "Save company details";
}
