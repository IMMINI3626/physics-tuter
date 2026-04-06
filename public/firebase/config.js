import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth }       from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore }  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getFunctions }  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';

const firebaseConfig = {
  apiKey: "AIzaSyA31PBtQ-sF3mRKPcwAFYNduVPhPSokaaQ",
  authDomain: "physics-tuter.firebaseapp.com",
  projectId: "physics-tuter",
  storageBucket: "physics-tuter.firebasestorage.app",
  messagingSenderId: "681593815271",
  appId: "1:681593815271:web:3c826fea6ae990403ce242",
  measurementId: "G-FFWX9B00DS"
};

const app       = initializeApp(firebaseConfig);
const auth      = getAuth(app);
const db        = getFirestore(app);
const functions = getFunctions(app, 'asia-northeast3');

export { app, auth, db, functions };
