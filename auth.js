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

const APP_VERSION = '9.2.0';
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
let AppMod = null;
let secAuth = null;   // segunda instancia de Auth, solo para crear usuarios

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
  'auth/email-already-in-use': 'Ese usuario ya existe en Authentication. Si fue eliminado del panel, borralo también desde la consola de Firebase.',
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

  AppMod = appMod;
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

  const firstName = String(state.username).split(/\s+/)[0].slice(0, 9);

  document.querySelectorAll('.account-btn').forEach(btn => {
    btn.title = 'Mi cuenta · ' + state.username;
    const label = btn.querySelector('.fl');
    if (label) {
      label.textContent = firstName || 'Cuenta';
    }
  });

  $('adminBtn').hidden = state.role !== 'admin';

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

    await endSession();

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

  if (auth) {
    startSession();
  }

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

  // Esta escucha se registra antes que la de los filtros de la app: se corta acá
  // para que abrir "Mi cuenta" no cambie el filtro de tarjetas.
  document.querySelectorAll('.account-btn').forEach(
    btn => btn.addEventListener('click', event => {
      event.stopImmediatePropagation();
      openAccount();
    })
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


// ============================================================
// SESIONES (para el panel del administrador)
// ============================================================
// Cada ingreso crea un registro en "sessions" y lo renueva cada 2 minutos.
// Conectado = sin cierre y con actividad en los últimos 3,5 minutos.

const HEARTBEAT_MS = 2 * 60 * 1000;
const ONLINE_WINDOW_MS = 3.5 * 60 * 1000;
const SID_KEY = 'vicaria_sid';

let sessionRef = null;

function beat() {

  if (!sessionRef) {
    return;
  }

  F.updateDoc(sessionRef, { lastSeen: F.serverTimestamp() }).catch(() => {});
}

async function startSession() {

  if (state.offline || !auth.currentUser) {
    return;
  }

  try {

    const sid = sessionStorage.getItem(SID_KEY) || crypto.randomUUID();

    sessionStorage.setItem(SID_KEY, sid);

    sessionRef = F.doc(db, 'sessions', sid);

    let resumed = false;

    try {
      await F.updateDoc(sessionRef, { lastSeen: F.serverTimestamp(), end: null });
      resumed = true;
    } catch (error) {
      // La sesión no existe todavía: se crea.
    }

    if (!resumed) {
      await F.setDoc(sessionRef, {
        uid: auth.currentUser.uid,
        username: state.username,
        role: state.role,
        device: deviceLabel(),
        start: F.serverTimestamp(),
        lastSeen: F.serverTimestamp(),
        end: null
      });
    }

    setInterval(beat, HEARTBEAT_MS);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        beat();
      }
    });

  } catch (error) {

    sessionRef = null;

    console.warn('ViCaRiA: no se pudo registrar la sesión', error);
  }
}

async function endSession() {

  const ref = sessionRef;

  sessionStorage.removeItem(SID_KEY);
  sessionRef = null;

  if (!ref) {
    return;
  }

  await Promise.race([
    F.updateDoc(ref, { end: F.serverTimestamp(), lastSeen: F.serverTimestamp() }).catch(() => {}),
    new Promise(resolve => setTimeout(resolve, 2500))
  ]);
}

// ============================================================
// PANEL DE ADMINISTRACIÓN
// ============================================================

const esc = value => String(value ?? '').replace(
  /[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
);

const tsMs = value =>
  value && typeof value.toMillis === 'function' ? value.toMillis() : null;

function fmtDate(ms) {

  if (ms == null) {
    return '—';
  }

  return new Date(ms).toLocaleString(
    'es-AR',
    { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }
  );
}

function fmtDur(ms) {

  if (ms == null || ms < 0) {
    return '—';
  }

  const minutes = Math.round(ms / 60000);

  if (minutes < 1) {
    return 'menos de 1 min';
  }

  const h = Math.floor(minutes / 60);

  return h ? `${h} h ${minutes % 60} min` : `${minutes} min`;
}

function ago(ms) {

  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));

  if (s < 60) return `hace ${s} s`;

  const m = Math.round(s / 60);

  if (m < 60) return `hace ${m} min`;

  return `hace ${Math.round(m / 60)} h`;
}

let adminTab = 'connected';
let adminTimer = null;
let historyCache = [];

function stopAdminTimer() {
  clearInterval(adminTimer);
  adminTimer = null;
}

function setAdminTab(tab) {

  adminTab = tab;

  stopAdminTimer();

  document.querySelectorAll('.adm-tab').forEach(
    btn => btn.classList.toggle('on', btn.dataset.tab === tab)
  );

  const loader = { connected: loadConnected, history: loadHistory, users: loadUsers }[tab];

  loader();

  if (tab === 'connected') {
    adminTimer = setInterval(loadConnected, 30000);
  }
}

function openAdmin() {

  closeAccount();

  $('adminModal').classList.add('active');

  setAdminTab('connected');
}

function closeAdmin() {

  stopAdminTimer();

  $('adminModal').classList.remove('active');
}

function adminError(error) {

  $('admPane').innerHTML =
    `<p class="adm-note adm-bad">${esc(errorText(error))}</p>`;
}

const roleChip = role =>
  `<span class="adm-chip adm-${esc(role)}">${esc(ROLE_LABEL[role] || role)}</span>`;

// ---------- Conectados ----------

async function loadConnected() {

  try {

    const since = F.Timestamp.fromMillis(Date.now() - ONLINE_WINDOW_MS);

    const snap = await F.getDocs(F.query(
      F.collection(db, 'sessions'),
      F.where('lastSeen', '>=', since),
      F.orderBy('lastSeen', 'desc')
    ));

    const rows = snap.docs
      .map(d => d.data())
      .filter(r => !r.end);

    if (adminTab !== 'connected') {
      return;
    }

    $('admPane').innerHTML =
      `<div class="adm-bar"><b>${rows.length}</b> conectado${rows.length === 1 ? '' : 's'} ahora
         <button type="button" class="btn adm-small" data-act="refresh">↻ Actualizar</button></div>` +
      (rows.length
        ? rows.map(r => {
            const start = tsMs(r.start);
            const last = tsMs(r.lastSeen);
            return `<div class="adm-row">
              <div class="adm-main"><b>${esc(r.username)}</b> ${roleChip(r.role)}
                <small>${esc(r.device)}</small></div>
              <div><small>Ingresó</small>${esc(fmtDate(start))}</div>
              <div><small>Conectado hace</small>${esc(fmtDur(last - start))}</div>
              <div><small>Última actividad</small>${esc(last ? ago(last) : '—')}</div>
            </div>`;
          }).join('')
        : '<p class="adm-note">Nadie conectado en este momento.</p>') +
      '<p class="adm-note">Se actualiza solo cada 30 segundos.</p>';

  } catch (error) {

    adminError(error);
  }
}

// ---------- Historial ----------

function renderHistory(filter) {

  const rows = historyCache.filter(r => !filter || r.username === filter);

  const names = [...new Set(historyCache.map(r => r.username))].sort();

  $('admPane').innerHTML =
    `<div class="adm-bar">
       <select id="admFilter" class="adm-select">
         <option value="">Todos los usuarios</option>
         ${names.map(n => `<option value="${esc(n)}" ${n === filter ? 'selected' : ''}>${esc(n)}</option>`).join('')}
       </select>
       <button type="button" class="btn adm-small" data-act="refresh">↻ Actualizar</button>
       <button type="button" class="btn adm-small adm-danger" data-act="purge">Borrar más de 30 días</button>
     </div>` +
    (rows.length
      ? rows.map(r => {
          const start = tsMs(r.start);
          const end = tsMs(r.end);
          const last = tsMs(r.lastSeen);
          const stop = end || last;
          return `<div class="adm-row">
            <div class="adm-main"><b>${esc(r.username)}</b> ${roleChip(r.role)}
              <small>${esc(r.device)}</small></div>
            <div><small>Inicio</small>${esc(fmtDate(start))}</div>
            <div><small>${end ? 'Fin' : 'Última actividad'}</small>${esc(fmtDate(stop))}</div>
            <div><small>Duración</small>${esc(fmtDur(stop - start))}</div>
          </div>`;
        }).join('')
      : '<p class="adm-note">No hay sesiones registradas.</p>') +
    '<p class="adm-note">Se muestran las últimas 100 sesiones. Si una sesión no tiene "Fin", se cerró la pestaña sin salir: la duración llega hasta la última actividad.</p>';

  $('admFilter').onchange = event => renderHistory(event.target.value);
}

async function loadHistory() {

  try {

    const snap = await F.getDocs(F.query(
      F.collection(db, 'sessions'),
      F.orderBy('start', 'desc'),
      F.limit(100)
    ));

    historyCache = snap.docs.map(d => d.data());

    if (adminTab === 'history') {
      renderHistory('');
    }

  } catch (error) {

    adminError(error);
  }
}

async function purgeHistory() {

  if (!confirm('¿Borrar las sesiones con más de 30 días de antigüedad?')) {
    return;
  }

  try {

    const cutoff = F.Timestamp.fromMillis(Date.now() - 30 * 24 * 60 * 60 * 1000);

    let removed = 0;

    for (let round = 0; round < 10; round++) {

      const snap = await F.getDocs(F.query(
        F.collection(db, 'sessions'),
        F.where('lastSeen', '<', cutoff),
        F.orderBy('lastSeen', 'asc'),
        F.limit(400)
      ));

      if (snap.empty) {
        break;
      }

      const batch = F.writeBatch(db);

      snap.docs.forEach(d => batch.delete(d.ref));

      await batch.commit();

      removed += snap.docs.length;
    }

    await loadHistory();

    showToast(`Se borraron ${removed} sesiones antiguas.`);

    setTimeout(() => showToast(''), 4000);

  } catch (error) {

    adminError(error);
  }
}

// ---------- Usuarios ----------

function randomPassword() {

  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  const bytes = new Uint32Array(10);

  crypto.getRandomValues(bytes);

  return Array.from(bytes, n => alphabet[n % alphabet.length]).join('');
}

async function createUserAccount(displayName, tempPass, role) {

  const username = displayName.trim().replace(/\s+/g, ' ');
  const key = normalizeUser(username);

  if (!key) {
    throw new UserError('Escribí un nombre válido.');
  }

  if (tempPass.length < 8) {
    throw new UserError('La contraseña provisoria debe tener al menos 8 caracteres.');
  }

  const dup = await F.getDocs(F.query(
    F.collection(db, 'users'),
    F.where('usernameLower', '==', key)
  ));

  if (!dup.empty) {
    throw new UserError(`Ya existe un usuario "${key}".`);
  }

  // La cuenta se crea con una segunda instancia de Firebase para no cerrar
  // la sesión del administrador.
  if (!secAuth) {
    const secApp =
      AppMod.getApps().find(a => a.name === 'secondary') ||
      AppMod.initializeApp(firebaseConfig, 'secondary');

    secAuth = A.initializeAuth(secApp, { persistence: A.inMemoryPersistence });
  }

  const cred = await A.createUserWithEmailAndPassword(
    secAuth,
    `${key}@${EMAIL_DOMAIN}`,
    tempPass
  );

  try {

    await F.setDoc(F.doc(db, 'users', cred.user.uid), {
      username,
      usernameLower: key,
      role: role === 'admin' ? 'admin' : 'user',
      mustChangePassword: true,
      disabled: false,
      createdAt: F.serverTimestamp(),
      createdBy: auth.currentUser.uid
    });

  } catch (error) {

    throw new UserError('La cuenta se creó pero no se pudo guardar el perfil. Reintentá desde la consola de Firebase.');

  } finally {

    try { await A.signOut(secAuth); } catch (e) {}
  }

  return { username, key };
}

async function loadUsers(notice) {

  try {

    const snap = await F.getDocs(F.collection(db, 'users'));

    const users = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(a.username).localeCompare(String(b.username), 'es'));

    if (adminTab !== 'users') {
      return;
    }

    const me = auth.currentUser.uid;

    $('admPane').innerHTML =
      `<form id="newUserForm" class="adm-new" autocomplete="off">
         <div class="adm-new-title">Nuevo usuario</div>
         <input id="nuName" type="text" placeholder="Nombre y apellido" autocapitalize="words">
         <div class="adm-pw-row">
           <input id="nuPass" type="text" placeholder="Contraseña provisoria (mín. 8)" autocapitalize="off" spellcheck="false">
           <button type="button" class="btn adm-small" data-act="genpass">Generar</button>
         </div>
         <select id="nuRole" class="adm-select"><option value="user">Usuario</option><option value="admin">Administrador</option></select>
         <div id="nuMsg" class="auth-msg" role="alert"></div>
         <button type="submit" class="btn" id="nuBtn">Crear usuario</button>
       </form>
       ${notice || ''}
       <div class="adm-bar"><b>${users.length}</b> usuario${users.length === 1 ? '' : 's'}</div>` +
      users.map(u => `<div class="adm-row adm-user">
         <div class="adm-main"><b>${esc(u.username)}</b> ${roleChip(u.role)}
           <small>Ingresa con: <code>${esc(u.usernameLower)}</code></small></div>
         <div><small>Estado</small>${u.disabled ? '<span class="adm-bad">Deshabilitado</span>' : u.mustChangePassword ? 'Debe cambiar la clave' : 'Activo'}</div>
         <div class="adm-actions">${u.id === me ? '<small>(vos)</small>' : `
           <button type="button" class="btn adm-small" data-act="toggle" data-id="${esc(u.id)}" data-disabled="${u.disabled ? '1' : '0'}">${u.disabled ? 'Habilitar' : 'Deshabilitar'}</button>
           <button type="button" class="btn adm-small adm-danger" data-act="delete" data-id="${esc(u.id)}" data-name="${esc(u.username)}">Eliminar</button>`}
         </div>
       </div>`).join('');

    $('newUserForm').onsubmit = async event => {

      event.preventDefault();

      const button = $('nuBtn');
      const name = $('nuName').value;
      const pass = $('nuPass').value;

      busy(button, true);
      setMsg('nuMsg', '');

      try {

        const created = await createUserAccount(name, pass, $('nuRole').value);

        const text =
          `ViCaRiA — https://kungfualvear.github.io/vicaria-v2/\nUsuario: ${created.key}\nContraseña provisoria: ${pass}\n(Se te pedirá cambiarla en el primer ingreso.)`;

        await loadUsers(
          `<div class="adm-ok">✔ Usuario creado.<pre>${esc(text)}</pre>
             <button type="button" class="btn adm-small" data-act="copy" data-text="${esc(text)}">Copiar datos</button></div>`
        );

      } catch (error) {

        setMsg('nuMsg', errorText(error));

      } finally {

        busy(button, false);
      }
    };

  } catch (error) {

    adminError(error);
  }
}

// ---------- acciones del panel ----------

async function adminAction(button) {

  const act = button.dataset.act;

  try {

    if (act === 'refresh') {
      return adminTab === 'history' ? loadHistory() : loadConnected();
    }

    if (act === 'purge') {
      return purgeHistory();
    }

    if (act === 'genpass') {
      $('nuPass').value = randomPassword();
      return;
    }

    if (act === 'copy') {
      await navigator.clipboard.writeText(button.dataset.text);
      button.textContent = '✔ Copiado';
      return;
    }

    if (act === 'toggle') {
      await F.updateDoc(F.doc(db, 'users', button.dataset.id), {
        disabled: button.dataset.disabled !== '1'
      });
      return loadUsers();
    }

    if (act === 'delete') {

      if (!confirm(`¿Eliminar el perfil de ${button.dataset.name}? Va a perder el acceso. Para volver a crearlo con el mismo usuario, borrá también su cuenta en Authentication (consola de Firebase).`)) {
        return;
      }

      await F.deleteDoc(F.doc(db, 'users', button.dataset.id));

      return loadUsers();
    }

  } catch (error) {

    adminError(error);
  }
}

function bindAdmin() {

  $('adminBtn').addEventListener('click', openAdmin);
  $('closeAdmin').addEventListener('click', closeAdmin);

  $('adminModal').addEventListener('click', event => {
    if (event.target === $('adminModal')) {
      closeAdmin();
    }
  });

  document.querySelectorAll('.adm-tab').forEach(
    btn => btn.addEventListener('click', () => setAdminTab(btn.dataset.tab))
  );

  $('admPane').addEventListener('click', event => {

    const button = event.target.closest('button[data-act]');

    if (button) {
      adminAction(button);
    }
  });
}

// ---------- inicio ----------

async function init() {

  setScreen('splash');

  bindUI();

  bindAdmin();

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
