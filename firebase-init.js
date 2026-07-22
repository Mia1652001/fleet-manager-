// Fleet Manager — shared Firebase setup
// This file is imported by every page. It connects to Firebase,
// checks that the user is logged in, and loads their company profile.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDgNxoaK9q3nxKKV7vg2pIzmtLFPDl5Lkk",
  authDomain: "car-rental-system-2a93b.firebaseapp.com",
  projectId: "car-rental-system-2a93b",
  storageBucket: "car-rental-system-2a93b.firebasestorage.app",
  messagingSenderId: "373289375853",
  appId: "1:373289375853:web:2246358765e53a04924764"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
// Safari and some restrictive networks block Firestore's default streaming
// connection (WebChannel), which shows up as "Could not reach Cloud Firestore
// backend". Forcing long polling uses a plain-HTTP method that works
// everywhere, at a small cost in update latency.
// On-device cache: pages open showing the last known data immediately, then
// update in the background. Falls back to a memory-only cache if the browser
// blocks local storage (e.g. private browsing), so the app still works.
let _db;
try {
  _db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    experimentalForceLongPolling: true,
    useFetchStreams: false
  });
} catch (e) {
  _db = initializeFirestore(app, {
    experimentalForceLongPolling: true,
    useFetchStreams: false
  });
}
export const db = _db;

export { signInWithEmailAndPassword, signOut };

// Waits for auth, loads the user's company profile, and returns
// { user, companyId, companyName }. If not logged in, redirects to index.html
// (unless this IS the login page, in which case it resolves with null).
export function requireAuth({ isLoginPage = false } = {}) {
  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        if (isLoginPage) { resolve(null); return; }
        window.location.href = "index.html";
        return;
      }
      try {
        const snap = await getDoc(doc(db, "users", user.uid));
        if (!snap.exists() || !snap.data().companyId) {
          await signOut(auth);
          if (!isLoginPage) window.location.href = "index.html";
          resolve(null);
          return;
        }
        resolve({
          user,
          companyId: snap.data().companyId,
          companyName: snap.data().companyName || snap.data().companyId
        });
      } catch (e) {
        await signOut(auth);
        if (!isLoginPage) window.location.href = "index.html";
        resolve(null);
      }
    });
  });
}

// Shared header helpers
export function setCompanyLabel(name) {
  const el = document.getElementById("company-label");
  if (el) el.textContent = name;
}

export function setSync(state) {
  const dot = document.getElementById("sync-dot");
  const label = document.getElementById("sync-label");
  if (!dot || !label) return;
  if (state === "live") { dot.className = "sync-dot"; label.textContent = "Live"; }
  else if (state === "saving") { dot.className = "sync-dot loading"; label.textContent = "Saving"; }
  else { dot.className = "sync-dot error"; label.textContent = "Error"; }
}

export function wireLogout() {
  const btn = document.getElementById("logout-btn");
  if (btn) btn.addEventListener("click", async () => {
    await signOut(auth);
    window.location.href = "index.html";
  });
}
