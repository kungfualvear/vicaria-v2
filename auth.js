// ============================================================
// ViCaRiA · Ingreso de usuarios y sincronización de ajustes
// ============================================================
// - Carga Firebase (Auth + Firestore) desde la CDN de Google.
// - Muestra la pantalla de ingreso; recién después carga la app
//   (vicaria-sheet.js y vicaria.js).
// - Usuario = "Nombre Apellido". Internamente se convierte en un correo
//   ficticio (nombre.apellido@vicaria.app); nunca se envían correos.
// - Los ajustes de cada usuario (códigos, favoritos, umbrales, tipo de
//   alarma, etc.) se guardan en la nube y se aplican al ingresar.
// - "Invitado": sin contraseña y sin sincronización.
// ============================================================

const APP_VERSION = '9.1.0';
const FIREBASE_CDN = 'https://www.gstatic.com/firebasejs/12.9.0/';
const EMAIL_DOMAIN = 'vicaria.app';
const APP_SCRIPTS = ['vicaria-sheet.js', 'vicaria.js'];

const firebaseConfig = {
  apiKey: "AIzaSyC5Vr1Lo3Etz40k1ZB4KuOrEpBn_YrPbTw",
  authDomain: "vicaria-atuel.firebaseapp.com",
  projectId: "vicaria-atuel",
  storageBucket: "vicaria-atuel.firebasestorage.app",
  messagingSenderId: "373178803754",
  appId: "1:373178803754:web:d5273eee8dda55d6424553"
};

// Claves de localStorage que se sincronizan con la nube.
const SYNC_KEY_RE =
  /^vicaria_(selected_codes|hidden_codes|favorite_codes|alarm_mode|settings_.+)$/;

// Copia local del perfil, para poder abrir la app sin conexión (no se sincroniza).
const PROFILE_CACHE = 'vicaria_profile';

const $ = id => document.getElementById(id);

let A = null;   // firebase-auth
let F = null;   // firebase-firestore
let auth = null;
let db = null;

const state = {
  role: 'guest',        // 'admin' | 'user' | 'guest'
  username: 'Invitado',
  key: '',              // usernameLower
  sync: false,
  offline: false
};

let applyingRemote = false;
let appStarted = false;
let pushTimer = null;
let pushFailed = false;
let dirty = false;   // hay cambios locales todavía sin subir

const origSetItem = Storage.prototype.setItem;
const origRemoveItem = Storage.prototype.removeItem;

class UserError extends Error {}

// ---------- utilidades ----------

function normalizeUser(text) {

  let t = String(text || '').trim();

  if (t.includes('@')) {
    t = t.split('@')[0];
  }

  return t
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '.')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '');
}

const ERROR_TEXT = {
  'auth/invalid-credential': 'Usuario o contraseña incorrectos.',
  'auth/user-not-found': 'Usuario o contraseña incorrectos.',
  'auth/wrong-password': 'Usuario o contraseña incorrectos.',
  'auth/invalid-email': 'Usuario inválido.',
  'auth/too-many-requests': 'Demasiados intentos. Esperá unos minutos e intentá de nuevo.',
  'auth/network-request-failed': 'Sin conexión. Revisá tu internet.',
  'auth/user-disabled': 'Este usuario está deshabilitado.',
  'auth/weak-password': 'La contraseña es muy débil (mínimo 8 caracteres).',
  'auth/requires-recent-login': 'Volvé a escribir tu contraseña actual.',
  'auth/admin-restricted-operation': 'El ingreso de invitado todavía no está habilitado.',
  'auth/operation-not-allowed': 'El ingreso de invitado todavía no está habilitado.',
  'unavailable': 'Sin conexión con el servidor. Intentá de nuevo.',
  'permission-denied': 'Tu usuario no tiene permiso. Avisá al administrador.'
};

function errorText(err) {

  if (err instanceof UserError) {
    return err.message;
  }

  return ERROR_TEXT[err && err.code] || 'Ocurrió un error. Intentá de nuevo.';
}

function deviceLabel() {

  const ua = navigator.userAgent;

  const os =
    /Android/.test(ua) ? 'Android' :
    /iPhone|iPad|iPod/.test(ua) ? 'iOS' :
    /Windows/.test(ua) ? 'Windows' :
    /Mac/.test(ua) ? 'Mac' :
    /Linux/.test(ua) ? 'Linux' : 'Otro';

  const browser =
    /Edg\//.test(ua) ? 'Edge' :
    /Firefox\//.test(ua) ? 'Firefox' :
    /Chrome\//.test(ua) ? 'Chrome' :
    /Safari\//.test(ua) ? 'Safari' : 'Navegador';

  return `${browser} · ${os}`;
}

// ---------- pantallas ----------

function setScreen(name) {

  const screen = $('authScreen');

  screen.hidden = name === 'none';

  ['authSplash', 'loginCard', 'changeCard'].forEach(id => {
    $(id).hidden = id !== { splash: 'authSplash', login: 'loginCard', change: 'changeCard' }[name];
  });
}

function setMsg(id, text) {
  $(id).textContent = text || '';
}

function busy(button, isBusy) {
  button.disabled = isBusy;
}

// ---------- Firebase ----------

async function loadFirebase() {

  const [appMod, authMod, fsMod] = await Promise.all([
    import(FIREBASE_CDN + 'firebase-app.js'),
    import(FIREBASE_CDN + 'firebase-auth.js'),
    import(FIREBASE_CDN + 'firebase-firestore.js')
  ]);

  const app = appMod.initializeApp(firebaseConfig);

  A = authMod;
  F = fsMod;

  // Sin ventanas emergentes ni iframes: solo usuario y contraseña.
  auth = A.initializeAuth(app, {
    persistence: [A.indexedDBLocalPersistence, A.browserLocalPersistence]
  });

  db = F.getFirestore(app);
}

// ---------- perfil ----------

function readProfileCache() {

  try {
    return JSON.parse(localStorage.getItem(PROFILE_CACHE) || 'null');
  } catch (error) {
    return null;
  }
}

async function loadProfile(user) {

  try {

    const snap = await F.getDoc(F.doc(db, 'users', user.uid));

    if (!snap.exists()) {
      throw new UserError('Tu usuario todavía no fue habilitado. Pedile al administrador que lo active.');
    }

    const profile = snap.data();

    origSetItem.call(localStorage, PROFILE_CACHE, JSON.stringify({
      uid: user.uid,
      username: profile.username,
      usernameLower: profile.usernameLower,
      role: profile.role
    }));

    return profile;

  } catch (error) {

    const cached = readProfileCache();

    const offline =
      error && (error.code === 'unavailable' || navigator.onLine === false);

    if (offline && cached && cached.uid === user.uid) {
      state.offline = true;
      return { ...cached, mustChangePassword: false, disabled: false };
    }

    throw error;
  }
}

// ---------- cambio de contraseña ----------

async function changePassword(user, current, p1, p2) {

  if (!p1 || p1.length < 8) {
    throw new UserError('La nueva contraseña debe tener al menos 8 caracteres.');
  }

  if (p1 !== p2) {
    throw new UserError('Las contraseñas nuevas no coinciden.');
  }

  if (p1 === current) {
    throw new UserError('La nueva contraseña debe ser distinta de la actual.');
  }

  const credential = A.EmailAuthProvider.credential(user.email, current);

  await A.reauthenticateWithCredential(user, credential);

  await A.updatePassword(user, p1);
}

function forceChangePassword(user, knownPassword) {

  return new Promise(resolve => {

    setScreen('change');

    $('curPassRow').hidden = !!knownPassword;
    $('changeCurPass').value = knownPassword || '';
    $('changePass1').value = '';
    $('changePass2').value = '';
    setMsg('changeMsg', '');

    $('changeForm').onsubmit = async event => {

      event.preventDefault();

      const button = $('changeBtn');

      busy(button, true);
      setMsg('changeMsg', '');

      try {

        await changePassword(
          user,
          $('changeCurPass').value,
          $('changePass1').value,
          $('changePass2').value
        );

        await F.updateDoc(F.doc(db, 'users', user.uid), { mustChangePassword: false });

        resolve();

      } catch (error) {

        setMsg('changeMsg', errorText(error));

      } finally {

        busy(button, false);
      }
    };
  });
}

// ---------- sincronización de ajustes ----------

function collectLocal() {

  const data = {};

  for (let i = 0; i < localStorage.length; i++) {

    const key = localStorage.key(i);

    if (SYNC_KEY_RE.test(key)) {
      data[key] = localStorage.getItem(key);
    }
  }

  return data;
}

function wipeLocalSettings() {

  const keys = [];

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (SYNC_KEY_RE.test(key)) {
      keys.push(key);
    }
  }

  keys.forEach(key => origRemoveItem.call(localStorage, key));

  origRemoveItem.call(localStorage, PROFILE_CACHE);
}

function applyRemote(data) {

  applyingRemote = true;

  try {

    Object.keys(collectLocal()).forEach(key => {
      if (!(key in data)) {
        origRemoveItem.call(localStorage, key);
      }
    });

    Object.entries(data).forEach(([key, value]) => {
      if (SYNC_KEY_RE.test(key)) {
        origSetItem.call(localStorage, key, String(value));
      }
    });

  } finally {

    applyingRemote = false;
  }
}

async function pushSettings() {

  if (!state.sync || state.offline) {
    return;
  }

  await F.setDoc(F.doc(db, 'settings', state.key), {
    data: collectLocal(),
    updatedAt: F.serverTimestamp(),
    device: deviceLabel(),
    by: auth.currentUser.uid
  });

  pushFailed = false;
  dirty = false;
  showToast('');
}

function showToast(text) {

  const toast = $('syncToast');

  toast.textContent = text || '';
  toast.hidden = !text;
}

async function safePush() {

  try {
    await pushSettings();
  } catch (error) {
    pushFailed = true;
    showToast('No se pudieron guardar tus ajustes en la nube. Se reintentará.');
    console.warn('ViCaRiA: no se pudo sincronizar', error);
  }
}

function schedulePush() {

  dirty = true;

  clearTimeout(pushTimer);

  pushTimer = setTimeout(() => {
    pushTimer = null;
    safePush();
  }, 1500);
}

async function flushPush() {

  // Solo se sube si hay cambios propios pendientes: así un dispositivo con datos
  // viejos nunca pisa lo que se guardó desde otro.
  if (!dirty) {
    return;
  }

  clearTimeout(pushTimer);
  pushTimer = null;

  await Promise.race([
    safePush(),
    new Promise(resolve => setTimeout(resolve, 3000))
  ]);
}

function installSyncHooks() {

  Storage.prototype.setItem = function (key, value) {

    origSetItem.call(this, key, value);

    if (this === localStorage && !applyingRemote && state.sync && SYNC_KEY_RE.test(key)) {
      schedulePush();
    }
  };

  Storage.prototype.removeItem = function (key) {

    origRemoveItem.call(this, key);

    if (this === localStorage && !applyingRemote && state.sync && SYNC_KEY_RE.test(key)) {
      schedulePush();
    }
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushPush();
    }
  });

  window.addEventListener('pagehide', flushPush);

  window.addEventListener('online', () => {
    if (pushFailed) {
      safePush();
    }
  });
}

async function pullSettings() {

  try {

    const snap = await F.getDoc(F.doc(db, 'settings', state.key));

    if (snap.exists()) {

      applyRemote((snap.data() || {}).data || {});

    } else if (Object.keys(collectLocal()).length > 0) {

      // Primer ingreso: se suben a la nube los ajustes que ya había en este dispositivo.
      await pushSettings();
    }

  } catch (error) {

    console.warn('ViCaRiA: se usan los ajustes locales (sin conexión)', error);
  }
}

// ---------- cuenta ----------

const ROLE_LABEL = { admin: 'Administrador', user: 'Usuario', guest: 'Invitado' };

function updateAccountUI() {

  document.querySelectorAll('.account-name').forEach(el => {
    el.textContent = state.username;
  });

  $('accName').textContent = state.username;
  $('accRole').textContent = ROLE_LABEL[state.role] || '';

  $('accSync').textContent =
    state.role === 'guest'
      ? 'Sin sincronización: tus ajustes quedan solo en este dispositivo.'
      : state.offline
        ? 'Sin conexión: se usan los ajustes guardados en este dispositivo.'
        : 'Tus ajustes se guardan en la nube y los ves en cualquier dispositivo.';

  $('pwForm').hidden = state.role === 'guest';

  $('logoutBtn').textContent =
    state.role === 'guest' ? 'Iniciar sesión' : 'Cerrar sesión';
}

function openAccount() {

  setMsg('pwMsg', '');
  $('pwForm').reset();

  $('accountModal').classList.add('active');
}

function closeAccount() {
  $('accountModal').classList.remove('active');
}

async function logout() {

  const wasSync = state.sync;

  try {

    if (wasSync) {
      await flushPush();
    }

    await A.signOut(auth);

  } catch (error) {

    console.warn('ViCaRiA: error al cerrar sesión', error);
  }

  if (wasSync) {
    wipeLocalSettings();
  }

  location.reload();
}

// ---------- arranque de la app ----------

function loadScript(src) {

  return new Promise((resolve, reject) => {

    const script = document.createElement('script');

    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error('No se pudo cargar ' + src));

    document.body.appendChild(script);
  });
}

async function startApp() {

  if (appStarted) {
    return;
  }

  appStarted = true;

  window.vicariaUser = state;

  updateAccountUI();

  if (state.sync) {
    installSyncHooks();
  }

  for (const src of APP_SCRIPTS) {
    await loadScript(`${src}?v=${APP_VERSION}`);
  }

  setScreen('none');
}

// ---------- entrada de un usuario ----------

async function enter(user, knownPassword) {

  if (user.isAnonymous) {

    state.role = 'guest';
    state.username = 'Invitado';
    state.key = '';
    state.sync = false;

    return startApp();
  }

  const profile = await loadProfile(user);

  if (profile.disabled === true) {
    throw new UserError('Este usuario está deshabilitado. Avisá al administrador.');
  }

  if (profile.mustChangePassword === true) {
    await forceChangePassword(user, knownPassword);
  }

  state.role = profile.role === 'admin' ? 'admin' : 'user';
  state.username = profile.username || profile.usernameLower;
  state.key = profile.usernameLower;
  state.sync = true;

  if (!state.offline) {
    await pullSettings();
  }

  return startApp();
}

async function enterOrLogin(user, knownPassword) {

  try {

    await enter(user, knownPassword);

  } catch (error) {

    console.warn('ViCaRiA: no se pudo ingresar', error);

    try { await A.signOut(auth); } catch (e) {}

    setScreen('login');
    setMsg('loginMsg', errorText(error));
  }
}

// ---------- formularios ----------

function bindUI() {

  $('loginForm').addEventListener('submit', async event => {

    event.preventDefault();

    const button = $('loginBtn');
    const key = normalizeUser($('loginUser').value);
    const pass = $('loginPass').value;

    if (!key || !pass) {
      setMsg('loginMsg', 'Escribí tu usuario y tu contraseña.');
      return;
    }

    busy(button, true);
    setMsg('loginMsg', '');

    try {

      const cred = await A.signInWithEmailAndPassword(auth, `${key}@${EMAIL_DOMAIN}`, pass);

      setScreen('splash');

      await enterOrLogin(cred.user, pass);

      $('loginPass').value = '';

    } catch (error) {

      setMsg('loginMsg', errorText(error));

    } finally {

      busy(button, false);
    }
  });

  $('guestBtn').addEventListener('click', async () => {

    setMsg('loginMsg', '');

    try {

      const cred = await A.signInAnonymously(auth);

      setScreen('splash');

      await enterOrLogin(cred.user);

    } catch (error) {

      setScreen('login');
      setMsg('loginMsg', errorText(error));
    }
  });

  $('offlineBtn').addEventListener('click', () => {

    state.role = 'guest';
    state.username = 'Sin conexión';
    state.sync = false;

    startApp();
  });

  $('changeLogout').addEventListener('click', logout);

  document.querySelectorAll('.account-btn').forEach(
    btn => btn.addEventListener('click', openAccount)
  );

  $('closeAccount').addEventListener('click', closeAccount);

  $('accountModal').addEventListener('click', event => {
    if (event.target === $('accountModal')) {
      closeAccount();
    }
  });

  $('logoutBtn').addEventListener('click', logout);

  $('pwForm').addEventListener('submit', async event => {

    event.preventDefault();

    const button = $('pwBtn');

    busy(button, true);
    setMsg('pwMsg', '');

    try {

      await changePassword(
        auth.currentUser,
        $('pwCurrent').value,
        $('pwNew').value,
        $('pwNew2').value
      );

      $('pwForm').reset();
      setMsg('pwMsg', '✔ Contraseña actualizada.');

    } catch (error) {

      setMsg('pwMsg', errorText(error));

    } finally {

      busy(button, false);
    }
  });
}

// ---------- inicio ----------

async function init() {

  setScreen('splash');

  bindUI();

  try {

    await loadFirebase();

  } catch (error) {

    console.error('ViCaRiA: no se pudo cargar Firebase', error);

    setScreen('login');
    setMsg('loginMsg', 'No se pudo conectar con el servicio de ingreso.');

    $('offlineBtn').hidden = false;
    $('guestBtn').hidden = true;
    $('loginForm').hidden = true;

    return;
  }

  try {
    await auth.authStateReady();
  } catch (error) {}

  if (auth.currentUser) {

    await enterOrLogin(auth.currentUser);

  } else {

    setScreen('login');

    $('loginUser').focus();
  }
}

init();
