// Fleet Manager — Firebase connection, created once for the whole app.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

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

// Long polling: Safari and some networks block Firestore's streaming
// connection. On-device cache: data is kept locally so the app opens instantly.
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

export { signInWithEmailAndPassword, signOut, onAuthStateChanged };

// Header sync indicator, shared by every view
export function setSync(stateName) {
  const dot = document.getElementById("sync-dot");
  const label = document.getElementById("sync-label");
  if (!dot || !label) return;
  if (stateName === "live") { dot.className = "sync-dot"; label.textContent = "Live"; }
  else if (stateName === "saving") { dot.className = "sync-dot loading"; label.textContent = "Saving"; }
  else { dot.className = "sync-dot error"; label.textContent = "Error"; }
}
