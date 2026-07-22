// Fleet Manager — main controller.
// Signs the user in, loads all company data once, keeps it live, and switches
// between views without ever reloading the page.

import { db, auth, signInWithEmailAndPassword, signOut, onAuthStateChanged, setSync } from "./firebase-init.js";
import { collection, query, where, onSnapshot, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { state, notifyDataChange } from "./store.js";

import * as fleet from "./view-fleet.js";
import * as bookings from "./view-bookings.js";
import * as customers from "./view-customers.js";
import * as billing from "./view-billing.js";
import * as maintenance from "./view-maintenance.js";

const VIEWS = {
  fleet: { mod: fleet, root: null },
  bookings: { mod: bookings, root: null },
  customers: { mod: customers, root: null },
  billing: { mod: billing, root: null },
  maintenance: { mod: maintenance, root: null }
};

let started = false;
let unsubs = [];

// ---------- Boot ----------
onAuthStateChanged(auth, async (user) => {
  document.getElementById("boot").style.display = "none";

  if (!user) {
    stopListeners();
    started = false;
    showLogin();
    return;
  }

  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    if (!snap.exists() || !snap.data().companyId) {
      await signOut(auth);
      showLogin("This account isn't linked to a company yet. Contact your administrator.");
      return;
    }
    state.ctx = {
      user,
      companyId: snap.data().companyId,
      companyName: snap.data().companyName || snap.data().companyId
    };
    startApp();
  } catch (e) {
    showLogin("Signed in, but couldn't load your profile (" + (e.code || e.message) + ").");
  }
});

function showLogin(msg) {
  document.getElementById("app").style.display = "none";
  document.getElementById("login").style.display = "flex";
  const err = document.getElementById("login-error");
  if (msg) { err.textContent = msg; err.classList.add("show"); }
  else { err.classList.remove("show"); }
  const btn = document.getElementById("login-btn");
  btn.disabled = false; btn.textContent = "Sign in";
}

async function doLogin() {
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const err = document.getElementById("login-error");
  const btn = document.getElementById("login-btn");
  err.classList.remove("show");

  if (!email || !password) {
    err.textContent = "Enter your email and password."; err.classList.add("show"); return;
  }

  btn.disabled = true; btn.textContent = "Signing in...";
  try {
    await signInWithEmailAndPassword(auth, email, password);
    // onAuthStateChanged takes it from here
  } catch (e) {
    const code = e.code || "";
    err.textContent =
      /wrong-password|user-not-found|invalid-credential|invalid-email/.test(code)
        ? "Incorrect email or password."
        : "Couldn't sign in (" + (code || e.message) + ").";
    err.classList.add("show");
    btn.disabled = false; btn.textContent = "Sign in";
  }
}

document.getElementById("login-btn").addEventListener("click", doLogin);
document.getElementById("login-password").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });

// ---------- App start ----------
function startApp() {
  document.getElementById("login").style.display = "none";
  document.getElementById("app").style.display = "block";
  document.getElementById("company-label").textContent = state.ctx.companyName;

  if (!started) {
    started = true;
    document.getElementById("logout-btn").addEventListener("click", async () => {
      stopListeners();
      await signOut(auth);
      state.ctx = null; state.cars = []; state.bookings = []; state.customers = [];
    });

    // Mount every view once. They stay in the DOM; navigation just shows/hides.
    for (const [name, v] of Object.entries(VIEWS)) {
      v.root = document.getElementById("view-" + name);
      v.mod.mount(v.root);
    }

    wireNav();
    showView(currentViewFromHash());
  }

  startListeners();
}

// ---------- Live data ----------
function startListeners() {
  stopListeners();
  const cid = state.ctx.companyId;

  unsubs.push(onSnapshot(query(collection(db, "cars"), where("companyId", "==", cid)), snap => {
    state.cars = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    setSync("live");
    notifyDataChange();
  }, () => setSync("error")));

  unsubs.push(onSnapshot(query(collection(db, "bookings"), where("companyId", "==", cid)), snap => {
    state.bookings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    notifyDataChange();
  }, () => setSync("error")));

  unsubs.push(onSnapshot(query(collection(db, "customers"), where("companyId", "==", cid)), snap => {
    state.customers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    notifyDataChange();
  }, () => setSync("error")));
}

function stopListeners() {
  unsubs.forEach(u => { try { u(); } catch {} });
  unsubs = [];
}

// ---------- Navigation ----------
function currentViewFromHash() {
  const name = (location.hash || "#fleet").replace("#", "");
  return VIEWS[name] ? name : "fleet";
}

function wireNav() {
  document.getElementById("main-nav").addEventListener("click", (e) => {
    const link = e.target.closest("a[data-view]");
    if (!link) return;
    e.preventDefault();
    const name = link.dataset.view;
    location.hash = "#" + name;   // keeps the back button working
    showView(name);
  });

  window.addEventListener("hashchange", () => showView(currentViewFromHash()));
}

function showView(name) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.getElementById("view-" + name).classList.add("active");

  document.querySelectorAll("#main-nav a").forEach(a => {
    a.classList.toggle("active", a.dataset.view === name);
  });

  // Views render from data already in memory — nothing is refetched.
  VIEWS[name].mod.render();
  window.scrollTo(0, 0);
}
