// ----- INICIO vicaria.js -----
// ViCaRiA - Vigía de Caudales del Río Atuel
// Versión corregida - detección robusta de sensores AN1/AN2/AN3...
// Mantiene Sparklines, SVG, historial, CSV, alarmas y configuración.
// ------------------------------------------------------------


// ============================================================
// CONFIGURACIÓN GENERAL
// ============================================================

const URLS = [
  'https://serviciosweb.cloud.irrigacion.gov.ar/services/telemetria/api/public/dato-medicions/fullDto?distribucionCodigo.equals=4&redPrimaria.equals=false&redPrimaria.equalsActive=true',
  'https://serviciosweb.cloud.irrigacion.gov.ar/services/telemetria/api/public/dato-medicions/fullDto?distribucionCodigo.equals=4&redPrimaria.equals=true&redPrimaria.equalsActive=true'
];

const UPDATE_INTERVAL = 5 * 60 * 1000;
const ALARM_INTERVAL = 30 * 1000;
const ALARM_REPEATS = 10;
const OUTDATED_THRESHOLD = 30 * 60 * 1000;

// Historial reciente que se lee de la hoja para sparkline,
// tendencia y promedio (solo en memoria, no se guarda).
const RECENT_HISTORY_HOURS = 3;


// ============================================================
// ELEMENTOS DEL DOM
// ============================================================

const cardsGrid = document.getElementById('cardsGrid');
const initialLoading = document.getElementById('initialLoading');
const emptyState = document.getElementById('emptyState');
const sidePanel = document.getElementById('sidePanel');
const panelToggle = document.getElementById('panelToggle');
const manageBtn = document.getElementById('manageBtn');
const refreshBtn = document.getElementById('refreshBtn');
const selectorModal = document.getElementById('selectorModal');
const closeModal = document.getElementById('closeModal');
const modalSearch = document.getElementById('modalSearch');
const codeList = document.getElementById('codeList');
const saveSelection = document.getElementById('saveSelection');

// Historial
const historyModal = document.getElementById('historyModal');
const closeHistoryModal = document.getElementById('closeHistoryModal');
const closeHistoryModalFooter = document.getElementById('closeHistoryModalFooter');
const historyModalTitle = document.getElementById('historyModalTitle');
const historyChartCanvas = document.getElementById('historyChart');
const timeRangeSelect = document.getElementById('timeRangeSelect');
const updateChartBtn = document.getElementById('updateChartBtn');
const rangeStartInput = document.getElementById('rangeStart');
const rangeEndInput = document.getElementById('rangeEnd');
const applyRangeBtn = document.getElementById('applyRangeBtn');
const rangeMessage = document.getElementById('rangeMessage');
const hourChips = document.getElementById('hourChips');
const refreshBtnTop = document.getElementById('refreshBtnTop');
const lastUpdatedEl = document.getElementById('lastUpdated');
const historyTableContainer = document.getElementById('historyTableContainer');
const chartLoading = document.getElementById('chartLoading');

// Maximizar historial
const maximizeHistoryBtn = document.getElementById('maximizeHistoryBtn');


// ============================================================
// ESTADO DE LA APLICACIÓN
// ============================================================

let allCodes = [];

const DEFAULT_SELECTED_CODES = [
  "8068",
  "8008",
  "8018",
  "8007",
  "8017",
  "8016",
  "8019",
  "8062",
  "8022",
  "8063",
  "8084",
  "8005",
  "8006",
  "8000",
  "8021",
  "8032",
  "8057",
  "8058",
  "8059",
  "8059-1",
  "8060",
  "8061",
  "8064",
  "8086",
  "8092",
  "8098"
];


let selectedCodes =
  JSON.parse(
    localStorage.getItem(
      'vicaria_selected_codes'
    ) || 'null'
  );


if (
  !Array.isArray(
    selectedCodes
  )
) {

  selectedCodes =
    [
      ...DEFAULT_SELECTED_CODES
    ];

} else {

  // Agregar automáticamente códigos
  // nuevos que estén en la configuración
  // predeterminada.

  DEFAULT_SELECTED_CODES.forEach(
    code => {

      if (
        !selectedCodes.includes(
          code
        )
      ) {

        selectedCodes.push(
          code
        );
      }

    }
  );
}

let hiddenCodes = JSON.parse(
  localStorage.getItem('vicaria_hidden_codes') || '[]'
);

let favoriteCodes = JSON.parse(
  localStorage.getItem('vicaria_favorite_codes') ||
  '["8068","8022","8000","8021","8006","8019"]'
);

let codesData = {};

// Historial reciente (últimas RECENT_HISTORY_HOURS horas), leído de la hoja.
// Vive solo en memoria: no se guarda en el navegador.
let historyData = {};

// Datos de la hoja que se muestran en el modal de historial (solo memoria).
let currentHistoryRows = [];

// Limpieza: versiones anteriores guardaban el historial en el navegador.
try {
  localStorage.removeItem('vicaria_history_data');
} catch (error) {
  // Sin almacenamiento: se ignora.
}

let alarmStates = {};

// Última variación (valor - asignado) y unidad de cada tarjeta, para el mensaje de voz.
const alarmInfo = {};
let thresholdCounters = {};
let currentFilter = 'favorites';
let updateIntervalId = null;
let currentChart = null;
let currentHistoryCode = null;

// Vista del historial: 'chart' (gráfico) o 'table' (tabla)
let historyView = 'chart';

// Estado visual de las tarjetas: sobrevive a los refrescos automáticos.
// Mientras la configuración de una tarjeta está abierta no se redibujan las tarjetas
// (sino el botón "Cerrar" se reemplazaría justo al tocarlo y haría falta tocar dos veces).
let renderPending = false;

function requestRender() {

  if (cardsGrid.querySelector('.card.expanded')) {
    renderPending = true;
    return;
  }

  renderCards();
}

const cardUi = {
  flipped: new Set(),   // tarjetas dadas vuelta (móvil)
  actions: new Set()    // tarjetas con los iconos de gráfico/tabla visibles
};

// Control de audio
let isAlarmPlaying = false;


// ============================================================
// NORMALIZACIÓN
// ============================================================

/**
 * Normaliza cualquier código recibido por el API.
 */
function normalizeCode(code) {

  if (
    code === null ||
    code === undefined
  ) {
    return '';
  }

  return String(code).trim();
}


/**
 * Normaliza nombres de sensores.
 *
 * Ejemplos:
 *
 * Sensor - Caudal - AN2
 * Sensor-Caudal-AN2
 * Sensor_Caudal_AN2
 * sensor caudal an2
 *
 * terminan representados de forma comparable.
 */
function normalizeSensorName(sensor) {

  return String(sensor || '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}


/**
 * Obtiene el número AN del sensor.
 *
 * Ejemplos:
 *
 * Sensor-Caudal-AN1 -> 1
 * Sensor-Caudal-AN2 -> 2
 * Sensor-Caudal-AN3 -> 3
 *
 * Si no existe AN, devuelve 999.
 */
function getSensorAN(sensor) {

  const name =
    normalizeSensorName(
      sensor?.sensor
    );

  const match =
    name.match(/an(\d+)$/);

  if (!match) {
    return 999;
  }

  return parseInt(
    match[1],
    10
  );
}


/**
 * Convierte el valor de un sensor a número.
 */
function sensorValue(sensor) {

  if (!sensor) {
    return null;
  }

  const value =
    parseFloat(
      sensor.valor
    );

  return Number.isFinite(value)
    ? value
    : null;
}


/**
 * Comprueba si un sensor pertenece a un determinado tipo.
 *
 * No exige AN1, AN2 ni AN3.
 *
 * Por lo tanto reconoce:
 *
 * Sensor - Caudal - AN1
 * Sensor - Caudal - AN2
 * Sensor - Caudal - AN3
 * Sensor - Caudal - AN4
 *
 * y lo mismo para Altura.
 */
function sensorMatchesType(sensor, type) {

  if (!sensor) {
    return false;
  }

  const sensorName =
    normalizeSensorName(
      sensor.sensor
    );

  const normalizedType =
    String(type || '')
      .toLowerCase()
      .replace(/[\s_-]+/g, '');

  if (!normalizedType) {
    return false;
  }

  return sensorName.includes(
    normalizedType
  );
}


/**
 * Busca un sensor por tipo.
 *
 * IMPORTANTE:
 *
 * Ya no depende de AN1/AN2/AN3.
 *
 * Si existen varios sensores del mismo tipo:
 *
 * 1. Primero toma los que tengan valor numérico válido.
 * 2. Entre ellos prioriza AN1, AN2, AN3...
 * 3. Si no tienen AN, también puede utilizarlos.
 *
 * Esto evita que un sensor AN2 vacío bloquee un AN1
 * que sí tiene valor.
 */
function findPreferredSensor(
  sensors,
  type
) {

  if (!Array.isArray(sensors)) {
    return null;
  }


  const candidates =
    sensors.filter(
      sensor =>
        sensorMatchesType(
          sensor,
          type
        )
    );


  if (
    candidates.length === 0
  ) {
    return null;
  }


  // ----------------------------------------------------------
  // Primero sensores con valor numérico válido
  // ----------------------------------------------------------

  const validCandidates =
    candidates.filter(
      sensor =>
        sensorValue(sensor) !== null
    );


  const pool =
    validCandidates.length > 0
      ? validCandidates
      : candidates;


  // ----------------------------------------------------------
  // Ordenar por AN
  //
  // AN1 -> AN2 -> AN3 -> ...
  // Los que no tienen AN quedan al final.
  // ----------------------------------------------------------

  return [...pool].sort(
    (a, b) =>
      getSensorAN(a) -
      getSensorAN(b)
  )[0] || null;
}


/**
 * Busca EXCLUSIVAMENTE Altura AN1.
 *
 * Esta función se utiliza solamente para la excepción
 * especial del código 8098.
 */
function findHeightAN1(sensors) {

  if (!Array.isArray(sensors)) {
    return null;
  }

  return sensors.find(
    sensor => {

      const name =
        normalizeSensorName(
          sensor?.sensor
        );

      return (
        name.includes('altura') &&
        /an1$/.test(name)
      );

    }
  ) || null;
}


// ============================================================
// NOTIFICACIONES
// ============================================================

if (
  "Notification" in window &&
  Notification.permission === "default"
) {

  Notification.requestPermission()
    .then(permission => {

      if (
        permission === "granted"
      ) {

        console.log(
          "Permisos de notificación concedidos"
        );
      }

    });
}


// ============================================================
// LOCAL STORAGE
// ============================================================

function saveToStorage() {

  localStorage.setItem(
    'vicaria_selected_codes',
    JSON.stringify(
      selectedCodes
    )
  );

  localStorage.setItem(
    'vicaria_hidden_codes',
    JSON.stringify(
      hiddenCodes
    )
  );

  localStorage.setItem(
    'vicaria_favorite_codes',
    JSON.stringify(
      favoriteCodes
    )
  );
}


// ============================================================
// CONFIGURACIÓN DE CADA CÓDIGO
// ============================================================

function getCodeSettings(code) {

  code =
    normalizeCode(code);

  const key =
    "vicaria_settings_" + code;

  const defaultNames = {

    '8068': 'Nihuil IV',
    '8008': 'Arroyo',
    '8018': 'Correa',
    '8019': 'Malvinas',
    '8007': 'Escorial',

    '8017': 'Regueira',
    '8022': 'Obra de Toma',
    '8063': 'Izuel I',
    '8084': 'Unificado',

    '8005': 'Matríz Real',
    '8006': 'Bifanni',
    '8000': 'Salida Real',
    '8021': 'La Olla',

    '8032': 'Bosch 14 y A',
    '8057': 'Marz. Pueblo',
    '8058': 'Marz. Cementerio',

    '8059': 'Moss',
    '8059-1': 'Christophersen S1',
    '8060': 'C. Auxiliar',

    '8061': 'R. Norte',
    '8064': '4° Tramo',
    '8086': '7 y A',
    '8092': 'Christophersen',

    '8098': 'Reservorio'
  };

  const defaults = {

    customName:
      defaultNames[code] || '',

    assignedCaudal:
      300,

    assignedAltura:
      0,

    thresholdUpCaudal:
      300,

    thresholdDownCaudal:
      300,

    thresholdUpAltura:
      2,

    thresholdDownAltura:
      2,

    alarmEnabled:
      false,

    useHeight:
      false,

    alarmCycles:
      1,

    adjustmentEnabled:
      false,

    adjustmentValue:
      0,

    showSparkline:
      false
  };

  let currentSettings = {};

  try {

    currentSettings =
      JSON.parse(
        localStorage.getItem(key) ||
        '{}'
      );

  } catch (error) {

    console.warn(
      `No se pudo leer la configuración de ${code}:`,
      error
    );

    currentSettings = {};
  }


  const finalSettings = {
    ...defaults,
    ...currentSettings
  };


  let settingsChanged =
    false;


  // ----------------------------------------------------------
  // Migración de antiguos umbrales
  // ----------------------------------------------------------

  if (
    currentSettings.thresholdUp !==
      undefined ||
    currentSettings.thresholdDown !==
      undefined
  ) {

    if (
      currentSettings.thresholdUp !==
        undefined
    ) {

      finalSettings.thresholdUpCaudal =
        currentSettings.thresholdUp;
    }


    if (
      currentSettings.thresholdDown !==
        undefined
    ) {

      finalSettings.thresholdDownCaudal =
        currentSettings.thresholdDown;
    }


    delete finalSettings.thresholdUp;
    delete finalSettings.thresholdDown;

    settingsChanged =
      true;
  }


  // ----------------------------------------------------------
  // Migración de antiguo "assigned"
  // ----------------------------------------------------------

  if (
    currentSettings.assigned !==
      undefined
  ) {

    if (
      finalSettings.useHeight
    ) {

      finalSettings.assignedAltura =
        currentSettings.assigned;

    } else {

      finalSettings.assignedCaudal =
        currentSettings.assigned;
    }


    delete finalSettings.assigned;

    settingsChanged =
      true;
  }


  if (settingsChanged) {

    saveCodeSettings(
      code,
      finalSettings
    );
  }


  return finalSettings;
}


function saveCodeSettings(
  code,
  settings
) {

  code =
    normalizeCode(code);

  const key =
    "vicaria_settings_" + code;

  localStorage.setItem(
    key,
    JSON.stringify(settings)
  );
}


// ============================================================
// AUDIO
// ============================================================

function beep() {

  if (isAlarmPlaying) {
    return;
  }


  try {

    const audio =
      getAlarmAudio();

    audio.currentTime = 0;

    isAlarmPlaying =
      true;


    audio.play()
      .then(() => {

        setTimeout(
          () => {

            isAlarmPlaying =
              false;

          },
          2000
        );

      })
      .catch(error => {

        console.warn(
          'Error al reproducir alarma:',
          error
        );

        isAlarmPlaying =
          false;
      });

  } catch (error) {

    console.error(
      'Error al reproducir sonido:',
      error
    );

    isAlarmPlaying =
      false;
  }
}


// ============================================================
// TIPO DE ALARMA: Individual (voz) / General (sonido)
// ============================================================

const ALARM_MODE_KEY = 'vicaria_alarm_mode';

function getAlarmMode() {

  try {
    return localStorage.getItem(ALARM_MODE_KEY) === 'individual'
      ? 'individual'
      : 'general';
  } catch (error) {
    return 'general';
  }
}

function setAlarmMode(mode) {

  try {
    localStorage.setItem(ALARM_MODE_KEY, mode);
  } catch (error) {}
}

let alarmAudio = null;

function getAlarmAudio() {

  if (!alarmAudio) {
    alarmAudio = new Audio('alarma.mp3');
    alarmAudio.volume = 0.8;
  }

  return alarmAudio;
}

// Los navegadores móviles exigen un toque previo para permitir sonido y voz.
let mediaUnlocked = false;

function unlockMedia() {

  if (mediaUnlocked) {
    return;
  }

  mediaUnlocked = true;

  try {
    const a = getAlarmAudio();
    a.muted = true;
    const p = a.play();
    if (p && p.then) {
      p.then(() => {
        a.pause();
        a.currentTime = 0;
        a.muted = false;
      }).catch(() => {
        a.muted = false;
      });
    }
  } catch (error) {}

  try {
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    }
  } catch (error) {}
}

['pointerdown', 'touchend', 'click', 'keydown'].forEach(
  name => document.addEventListener(
    name,
    unlockMedia,
    { once: true, passive: true }
  )
);

function pickSpanishVoice() {

  if (!('speechSynthesis' in window)) {
    return null;
  }

  const voices = speechSynthesis.getVoices() || [];

  const lang = v => (v.lang || '').toLowerCase().replace('_', '-');

  return (
    voices.find(v => lang(v) === 'es-ar') ||
    voices.find(v => lang(v) === 'es-419') ||
    voices.find(v => lang(v) === 'es-mx') ||
    voices.find(v => lang(v) === 'es-us') ||
    voices.find(v => lang(v).startsWith('es')) ||
    null
  );
}

function spokenUnit(unit) {

  if (unit === 'l/s') return 'litros por segundo';
  if (unit === 'cm') return 'centímetros';
  if (unit === 'm³/s') return 'metros cúbicos por segundo';

  return unit || '';
}

function buildAlarmMessage(code, type) {

  const info = alarmInfo[code];

  const codeInfo =
    allCodes.find(c => normalizeCode(c.code) === code);

  const settings = getCodeSettings(code);

  const name = settings.customName || codeInfo?.name || code;

  const word = type === 'up' ? 'un aumento' : 'una merma';

  if (!info || !Number.isFinite(info.variation)) {
    return `Se ha detectado ${word} en ${name}`;
  }

  const amount = Math.round(Math.abs(info.variation));

  return `Se ha detectado ${word} de ${amount} ${spokenUnit(info.unit)} en ${name}`;
}

function speakAlarm(code, type, textOverride) {

  if (!('speechSynthesis' in window)) {
    beep();
    return false;
  }

  try {

    const u = new SpeechSynthesisUtterance(
      textOverride || buildAlarmMessage(code, type)
    );

    const voice = pickSpanishVoice();

    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    } else {
      u.lang = 'es-AR';
    }

    u.rate = 0.95;
    u.volume = 1;

    speechSynthesis.speak(u);

    return true;

  } catch (error) {

    beep();

    return false;
  }
}

// Alarma Individual = voz · Alarma General = sonido
function playAlarmSound(code, type) {

  if (getAlarmMode() === 'individual') {
    speakAlarm(code, type);
  } else {
    beep();
  }
}

function playBeepSequence() {
  beep();
}


// ============================================================
// NOTIFICACIONES DE ALARMA
// ============================================================

function sendNotification(
  code,
  type
) {

  code =
    normalizeCode(code);


  if (
    !("Notification" in window) ||
    Notification.permission !==
      "granted"
  ) {
    return;
  }


  const codeInfo =
    allCodes.find(
      c =>
        normalizeCode(c.code) ===
        code
    );


  const settings =
    getCodeSettings(code);


  const displayName =
    settings.customName ||
    codeInfo?.name ||
    code;


  const typeText =
    type === 'up'
      ? 'Aumento detectado'
      : 'Merma detectada';


  try {

    const notification =
      new Notification(
        '🔔 Alarma ViCaRiA',
        {
          body:
            `${displayName}: ${typeText}`,

          icon:
            'https://serviciosweb.cloud.irrigacion.gov.ar/favicon.ico',

          requireInteraction:
            true,

          tag:
            `alarm-${code}`,

          silent:
            false
        }
      );


    notification.onclick =
      function() {

        window.focus();

        notification.close();


        const card =
          document.querySelector(
            `[data-code="${CSS.escape(code)}"]`
          );


        if (card) {

          card.scrollIntoView({
            behavior:
              'smooth',

            block:
              'center'
          });


          card.classList.add(
            'expanded'
          );
        }
      };

  } catch (error) {

    console.warn(
      'No se pudo mostrar la notificación:',
      error
    );
  }
}


// ============================================================
// ALARMAS
// ============================================================

function startAlarm(
  code,
  type
) {

  code =
    normalizeCode(code);


  if (
    alarmStates[code]?.active
  ) {
    return;
  }


  alarmStates[code] = {

    active:
      true,

    count:
      0,

    intervalId:
      null,

    type
  };


  const card =
    document.querySelector(
      `[data-code="${CSS.escape(code)}"]`
    );


  const indicator =
    card?.querySelector(
      '.alarm-indicator'
    );


  if (indicator) {

    indicator.classList.add(
      'ringing'
    );
  }


  sendNotification(
    code,
    type
  );


  if (!document.hidden) {
    playAlarmSound(code, type);
  }


  alarmStates[code].count++;


  alarmStates[code].intervalId =
    setInterval(
      () => {

        if (
          !alarmStates[code]
        ) {
          return;
        }


        if (
          alarmStates[code].count >=
          ALARM_REPEATS
        ) {

          stopAlarm(code);

          return;
        }


        sendNotification(
          code,
          type
        );


        if (!document.hidden) {
          playAlarmSound(code, type);
        }


        alarmStates[code].count++;

      },
      ALARM_INTERVAL
    );
}


function stopAlarm(code) {

  code =
    normalizeCode(code);


  if (!alarmStates[code]) {
    return;
  }


  if (
    alarmStates[code].intervalId
  ) {

    clearInterval(
      alarmStates[code].intervalId
    );
  }


  const card =
    document.querySelector(
      `[data-code="${CSS.escape(code)}"]`
    );


  const indicator =
    card?.querySelector(
      '.alarm-indicator'
    );


  if (indicator) {

    indicator.classList.remove(
      'ringing'
    );
  }


  alarmStates[code] = {

    active:
      false,

    count:
      0,

    intervalId:
      null,

    type:
      null
  };
}


// ============================================================
// FECHA / DATOS DESACTUALIZADOS
// ============================================================

function isDataOutdated(fecha) {

  const now =
    new Date();


  const dataDate =
    new Date(fecha);


  if (
    isNaN(
      dataDate.getTime()
    )
  ) {

    return true;
  }


  const timeDiff =
    now.getTime() -
    dataDate.getTime();


  return (
    timeDiff >
    OUTDATED_THRESHOLD
  );
}


// ============================================================
// OBTENER DATOS DEL API
// ============================================================

async function fetchAllCodes() {

  try {

    let combined = [];


    for (
      const url of URLS
    ) {

      const res =
        await fetch(
          url,
          {
            cache:
              'no-store'
          }
        );


      if (!res.ok) {

        throw new Error(
          `${res.status} ${res.statusText}`
        );
      }


      const data =
        await res.json();


      if (
        Array.isArray(data)
      ) {

        combined =
          combined.concat(
            data
          );

      }

      else if (
        data?.content
      ) {

        combined =
          combined.concat(
            data.content
          );
      }
    }


    console.log(
      `ViCaRiA: ${combined.length} registros recibidos del API.`
    );


    return combined;

  } catch (error) {

    console.error(
      'Error al obtener datos:',
      error
    );

    throw error;
  }
}


// ============================================================
// EXTRAER INFORMACIÓN DEL CÓDIGO
// ============================================================

function extractCodeInfo(item) {

  if (!item) {

    return {
      code:
        '',

      name:
        '',

      data:
        item
    };
  }


  const rawCode =
    item.codigoMaestro ??
    item.codigo ??
    (
      item.maestroSensor
        ? item.maestroSensor.split(' ')[0]
        : ''
    );


  const code =
    normalizeCode(
      rawCode
    );


  const name =
    item.maestroSensor ||
    item.nombre ||
    code;


  return {

    code,

    name,

    data:
      item
  };
}


// ============================================================
// CARGAR TODOS LOS CÓDIGOS
// ============================================================

/**
 * Lee de la hoja las últimas RECENT_HISTORY_HOURS horas y recalcula
 * la tendencia de cada tarjeta. Los datos quedan solo en memoria.
 *
 * Si la hoja no responde, se conservan los últimos datos en memoria
 * y las tarjetas siguen funcionando con los datos de la API.
 */
async function refreshRecentHistory() {

  try {

    historyData =
      await fetchSheetHistory(
        RECENT_HISTORY_HOURS
      );

  } catch (error) {

    console.warn(
      'ViCaRiA: no se pudo leer el historial reciente de la hoja:',
      error
    );
  }


  allCodes.forEach(
    ({ code }) => {

      const normalizedCode =
        normalizeCode(
          code
        );

      if (
        !codesData[
          normalizedCode
        ]
      ) {
        return;
      }

      // Solo los códigos que están en la hoja tienen tendencia.
      codesData[
        normalizedCode
      ].trend =
        hasSheetHistory(
          normalizedCode
        )
          ? calculateTrend(
              normalizedCode
            )
          : 'none';
    }
  );
}


async function loadAllCodes() {

  try {

    const rawData =
      await fetchAllCodes();


    allCodes =
      rawData
        .map(
          extractCodeInfo
        )
        .filter(
          item =>
            item.code !== ''
        );


    // ----------------------------------------------------------
    // Normalizar selección, favoritos y ocultos
    // ----------------------------------------------------------

    selectedCodes =
      selectedCodes.map(
        normalizeCode
      );


    hiddenCodes =
      hiddenCodes.map(
        normalizeCode
      );


    favoriteCodes =
      favoriteCodes.map(
        normalizeCode
      );


    // ----------------------------------------------------------
    // Eliminar duplicados
    // ----------------------------------------------------------

    selectedCodes =
      [
        ...new Set(
          selectedCodes
        )
      ];


    hiddenCodes =
      [
        ...new Set(
          hiddenCodes
        )
      ];


    favoriteCodes =
      [
        ...new Set(
          favoriteCodes
        )
      ];


    // ----------------------------------------------------------
    // Comprobar específicamente 8006
    // ----------------------------------------------------------

    const records8006 =
      allCodes.filter(
        item =>
          normalizeCode(
            item.code
          ) === '8006'
      );


    if (
      records8006.length > 0
    ) {

      console.log(
        'ViCaRiA: código 8006 recibido correctamente:',
        records8006
      );

    } else {

      console.warn(
        'ViCaRiA: el código 8006 NO fue encontrado en la respuesta del API.'
      );
    }


    // ----------------------------------------------------------
    // Procesar cada código
    // ----------------------------------------------------------

    allCodes.forEach(
      ({ code, data }) => {

        const normalizedCode =
          normalizeCode(
            code
          );


        codesData[
          normalizedCode
        ] =
          data;


        // ------------------------------------------------------
        // SENSORES
        // ------------------------------------------------------

        const sensors =
          Array.isArray(
            data.datoMedicionList
          )
            ? data.datoMedicionList
            : [];


        /*
         * IMPORTANTE:
         *
         * La detección general NO depende de AN1/AN2/AN3.
         *
         * findPreferredSensor() busca cualquier sensor que
         * contenga "caudal" o "altura", y selecciona uno con
         * valor válido.
         */

        const caudalSensor =
          findPreferredSensor(
            sensors,
            'caudal'
          );


        const alturaSensor =
          findPreferredSensor(
            sensors,
            'altura'
          );


        /*
         * EXCEPCIÓN 8098:
         *
         * Este código sigue utilizando exclusivamente
         * Sensor-Altura-AN1.
         */

        const alturaSensorAN1 =
          findHeightAN1(
            sensors
          );


        // ------------------------------------------------------
        // DEBUG ESPECÍFICO PARA 8006
        // ------------------------------------------------------

        if (
          normalizedCode === '8006'
        ) {

          console.log(
            '========== DEBUG CÓDIGO 8006 =========='
          );


          console.log(
            'Código:',
            normalizedCode
          );


          console.log(
            'codigoMaestro original:',
            data.codigoMaestro,
            'tipo:',
            typeof data.codigoMaestro
          );


          console.log(
            'Nombre:',
            data.maestroSensor
          );


          console.log(
            'Sensores recibidos:',
            sensors
          );


          console.log(
            'Sensores de Caudal encontrados:',
            sensors.filter(
              sensor =>
                sensorMatchesType(
                  sensor,
                  'caudal'
                )
            )
          );


          console.log(
            'Sensores de Altura encontrados:',
            sensors.filter(
              sensor =>
                sensorMatchesType(
                  sensor,
                  'altura'
                )
            )
          );


          console.log(
            'Sensor Caudal seleccionado:',
            caudalSensor
          );


          console.log(
            'Sensor Altura seleccionado:',
            alturaSensor
          );


          console.log(
            'Sensor Altura AN1 seleccionado para 8098:',
            alturaSensorAN1
          );


          console.log(
            'Valor Caudal:',
            sensorValue(
              caudalSensor
            )
          );


          console.log(
            'Valor Altura:',
            sensorValue(
              alturaSensor
            )
          );


          console.log(
            '========================================'
          );
        }


      }
    );


    // ----------------------------------------------------------
    // HISTORIAL RECIENTE
    //
    // Se lee de Google Sheets y se guarda solo en memoria
    // (sparkline, tendencia y promedio de la última hora).
    // ----------------------------------------------------------

    await refreshRecentHistory();


    // ----------------------------------------------------------
    // GUARDAR (solo preferencias del usuario)
    // ----------------------------------------------------------

    saveToStorage();


    // ----------------------------------------------------------
    // INTERFAZ
    // ----------------------------------------------------------

    initialLoading.style.display =
      'none';


    renderCards();

    renderCodeList();

    updateCounters();

    setLastUpdated();

  } catch (error) {

    console.error(
      'Error al cargar datos:',
      error
    );


    initialLoading.innerHTML =
      `<span style="color:#ff5252;">
        ❌ Error al cargar datos: ${error.message}
      </span>`;
  }
}


// ============================================================
// TENDENCIA
// ============================================================

function calculateTrend(code) {

  code =
    normalizeCode(code);


  const codeHistory =
    historyData[code] || [];


  if (
    codeHistory.length < 5
  ) {

    return 'stable';
  }


  // La hoja se actualiza cada ~10 min, así que las ventanas se miden
  // desde la última muestra y no desde "ahora".
  const currentData =
    codeHistory[
      codeHistory.length - 1
    ];


  // Referencia: todo lo anterior a 30 min antes de la última muestra.
  const timeReference =
    currentData.timestamp -
    (
      30 *
      60 *
      1000
    );


  // Reciente: la última muestra y la anterior (~15 min).
  const timeRecentStart =
    currentData.timestamp -
    (
      15 *
      60 *
      1000
    );


  const settings =
    getCodeSettings(
      code
    );


  const is8098 =
    code === "8098";


  const useHeight =
    settings.useHeight ||
    is8098;


  const adjustment =
    settings.adjustmentEnabled
      ? parseFloat(
          settings.adjustmentValue
        ) || 0
      : 0;


  function getValue(item) {

    if (is8098) {

      return item.alturaAN1 !==
        null &&
        item.alturaAN1 !==
        undefined

        ? item.alturaAN1 +
          adjustment

        : null;
    }


    if (useHeight) {

      return item.altura !==
        null &&
        item.altura !==
        undefined

        ? item.altura +
          adjustment

        : null;
    }


    return item.caudal !==
      null &&
      item.caudal !==
      undefined

      ? item.caudal +
        adjustment

      : null;
  }


  const currentValue =
    getValue(
      currentData
    );


  if (
    currentValue === null
  ) {

    return 'stable';
  }


  const historicalValues =
    codeHistory
      .filter(
        item =>
          item.timestamp <
          timeReference
      )
      .map(
        getValue
      )
      .filter(
        value =>
          value !== null &&
          Number.isFinite(
            value
          )
      );


  const recentValues =
    codeHistory
      .filter(
        item =>
          item.timestamp >=
            timeRecentStart
      )
      .map(
        getValue
      )
      .filter(
        value =>
          value !== null &&
          Number.isFinite(
            value
          )
      );


  if (
    historicalValues.length === 0 ||
    recentValues.length === 0
  ) {

    return 'stable';
  }


  const historicalAverage =
    historicalValues.reduce(
      (a, b) =>
        a + b,
      0
    ) /
    historicalValues.length;


  const recentAverage =
    recentValues.reduce(
      (a, b) =>
        a + b,
      0
    ) /
    recentValues.length;


  const delta =
    recentAverage -
    historicalAverage;


  const TREND_THRESHOLD =
    useHeight
      ? 10
      : 200;


  if (
    delta >
    TREND_THRESHOLD
  ) {

    return 'up';
  }


  if (
    delta <
    -TREND_THRESHOLD
  ) {

    return 'down';
  }


  return 'stable';
}


// ============================================================
// PROMEDIO HORARIO
// ============================================================

function getHourlyAverage(
  code,
  isHeight,
  is8098,
  adjustment
) {

  code =
    normalizeCode(code);


  const history =
    historyData[code] || [];


  if (
    history.length === 0
  ) {

    return null;
  }


  const oneHourAgo =
    Date.now() -
    (
      60 *
      60 *
      1000
    );


  const recentData =
    history.filter(
      item =>
        item.timestamp >=
        oneHourAgo
    );


  if (
    recentData.length === 0
  ) {

    return null;
  }


  const values =
    recentData
      .map(
        item => {

          let value =
            null;


          if (is8098) {

            value =
              item.alturaAN1;

          }

          else if (isHeight) {

            value =
              item.altura;

          }

          else {

            value =
              item.caudal;
          }


          return value !== null &&
            Number.isFinite(
              value
            )

            ? value +
              adjustment

            : null;

        }
      )
      .filter(
        value =>
          value !== null
      );


  if (
    values.length === 0
  ) {

    return null;
  }


  const sum =
    values.reduce(
      (a, b) =>
        a + b,
      0
    );


  return (
    sum /
    values.length
  );
}


// ============================================================
// SPARKLINE SVG
// ============================================================

function generateSparklineSVG(
  code,
  useHeight,
  is8098,
  adjustment
) {

  code =
    normalizeCode(code);


  const history =
    historyData[code] || [];


  if (
    history.length < 2
  ) {

    return '';
  }


  const threeHoursAgo =
    Date.now() -
    (
      3 *
      60 *
      60 *
      1000
    );


  const recentData =
    history
      .filter(
        item =>
          item.timestamp >=
          threeHoursAgo
      )
      .sort(
        (a, b) =>
          a.timestamp -
          b.timestamp
      );


  if (
    recentData.length === 0
  ) {

    return '';
  }


  const values =
    recentData
      .map(
        item => {

          let val =
            null;


          if (is8098) {

            val =
              item.alturaAN1;

          }

          else {

            val =
              useHeight
                ? item.altura
                : item.caudal;
          }


          return val !== null &&
            Number.isFinite(
              val
            )

            ? val +
              adjustment

            : null;

        }
      )
      .filter(
        value =>
          value !== null
      );


  if (
    values.length < 2
  ) {

    return '';
  }


  const min =
    Math.min(
      ...values
    );


  const max =
    Math.max(
      ...values
    );


  const range =
    max -
    min;


  const width =
    100;


  const height =
    25;


  const padding =
    2;


  const availableHeight =
    height -
    (
      padding *
      2
    );


  const getY =
    value => {

      if (
        range === 0
      ) {

        return (
          height /
          2
        );
      }


      const normalized =
        (
          value -
          min
        ) /
        range;


      return (
        height -
        padding -
        (
          normalized *
          availableHeight
        )
      );
    };


  let pathD =
    '';


  const stepX =
    width /
    (
      values.length -
      1
    );


  values.forEach(
    (
      value,
      index
    ) => {

      const x =
        index *
        stepX;


      const y =
        getY(
          value
        );


      pathD +=
        `${
          index === 0
            ? 'M'
            : 'L'
        } ` +
        `${x.toFixed(1)} ` +
        `${y.toFixed(1)} `;
    }
  );


  const fillD =
    `${pathD} L 100 ${height} L 0 ${height} Z`;


  const lastX =
    100;


  const lastY =
    getY(
      values[
        values.length -
        1
      ]
    );


  const defs = `
    <defs>
      <linearGradient
        id="sparkline-gradient-${code.replace(/[^a-zA-Z0-9_-]/g, '')}"
        x1="0"
        x2="0"
        y1="0"
        y2="1">

        <stop
          offset="0%"
          stop-color="#ffffff"
          stop-opacity="0.5"/>

        <stop
          offset="100%"
          stop-color="#ffffff"
          stop-opacity="0"/>

      </linearGradient>
    </defs>
  `;


  return `
    <div class="sparkline-container">

      <svg
        class="sparkline-svg"
        viewBox="0 0 100 25"
        preserveAspectRatio="none">

        ${defs}

        <path
          class="sparkline-fill"
          d="${fillD}" />

        <path
          class="sparkline-path"
          d="${pathD}"
          vector-effect="non-scaling-stroke" />

        <circle
          class="sparkline-dot"
          cx="${lastX}"
          cy="${lastY}"
          r="2" />

      </svg>

    </div>
  `;
}


// ============================================================
// CREAR TARJETA
// ============================================================

function createCard(code) {

  code =
    normalizeCode(code);


  const codeInfo =
    allCodes.find(
      c =>
        normalizeCode(
          c.code
        ) ===
        code
    );


  if (!codeInfo) {

    console.warn(
      `ViCaRiA: el código ${code} está seleccionado pero no aparece en allCodes.`
    );

    return null;
  }


  const data =
    codesData[code];


  if (!data) {

    console.warn(
      `ViCaRiA: no existen datos para el código ${code}.`
    );

    return null;
  }


  const settings =
    getCodeSettings(
      code
    );


  const isFavorite =
    favoriteCodes
      .map(
        normalizeCode
      )
      .includes(
        code
      );


  const displayName =
    settings.customName ||
    codeInfo.name ||
    code;


  const sensors =
    Array.isArray(
      data.datoMedicionList
    )
      ? data.datoMedicionList
      : [];


  // ----------------------------------------------------------
  // DETECTAR SENSORES
  // ----------------------------------------------------------

  /*
   * DETECCIÓN GENERAL:
   *
   * No importa si el sensor es AN1, AN2, AN3, AN4...
   *
   * Se selecciona el sensor del tipo correspondiente que
   * tenga un valor válido.
   */

  const caudalSensor =
    findPreferredSensor(
      sensors,
      'caudal'
    );


  const alturaSensor =
    findPreferredSensor(
      sensors,
      'altura'
    );


  /*
   * EXCEPCIÓN:
   *
   * 8098 utiliza específicamente Altura AN1.
   */

  const alturaSensorAN1 =
    findHeightAN1(
      sensors
    );


  // ----------------------------------------------------------
  // DEBUG ESPECÍFICO PARA 8006
  // ----------------------------------------------------------

  if (
    code === '8006'
  ) {

    console.log(
      '========== CREATE CARD 8006 =========='
    );


    console.log(
      'Código:',
      code
    );


    console.log(
      'Nombre:',
      displayName
    );


    console.log(
      'Sensores:',
      sensors
    );


    console.log(
      'Caudal detectado:',
      caudalSensor
    );


    console.log(
      'Altura detectada:',
      alturaSensor
    );


    console.log(
      'Valor Caudal:',
      sensorValue(
        caudalSensor
      )
    );


    console.log(
      'Valor Altura:',
      sensorValue(
        alturaSensor
      )
    );


    console.log(
      '======================================'
    );
  }


  // ----------------------------------------------------------
  // SI NO HAY NINGUNO, INFORMAR
  // ----------------------------------------------------------

  if (
    !caudalSensor &&
    !alturaSensor
  ) {

    console.warn(
      `ViCaRiA: código ${code} recibido, pero no se encontró sensor de Caudal ni Altura.`
    );


    console.warn(
      `Sensores de ${code}:`,
      sensors
    );


    return null;
  }


  const useHeight =
    settings.useHeight;


  const caudal =
    sensorValue(
      caudalSensor
    );


  const altura =
    sensorValue(
      alturaSensor
    );


  let mainValue;
  let secondaryValue;
  let mainUnit;
  let secondaryUnit;

  let assignedValue;
  let thresholdUp;
  let thresholdDown;


  const fecha =
    data.fecha ||
    data.fechaMedicion ||
    new Date().toISOString();


  const isOutdated =
    isDataOutdated(
      fecha
    );


  // ----------------------------------------------------------
  // 8098
  // ----------------------------------------------------------

  const is8098 =
    code === "8098" &&
    !!alturaSensorAN1;


  if (is8098) {

    mainValue =
      sensorValue(
        alturaSensorAN1
      );


    mainUnit =
      "cm";


    secondaryValue =
      caudal;


    secondaryUnit =
      "l/s";


    assignedValue =
      settings.assignedAltura;


    thresholdUp =
      settings.thresholdUpAltura;


    thresholdDown =
      settings.thresholdDownAltura;

  }


  // ----------------------------------------------------------
  // RESTO DE CÓDIGOS
  // ----------------------------------------------------------

  else {

    mainValue =
      useHeight
        ? altura
        : caudal;


    secondaryValue =
      useHeight
        ? caudal
        : altura;


    mainUnit =
      useHeight
        ? 'cm'
        : 'l/s';


    secondaryUnit =
      useHeight
        ? 'l/s'
        : 'cm';


    if (useHeight) {

      assignedValue =
        settings.assignedAltura;


      thresholdUp =
        settings.thresholdUpAltura;


      thresholdDown =
        settings.thresholdDownAltura;

    }

    else {

      assignedValue =
        settings.assignedCaudal;


      thresholdUp =
        settings.thresholdUpCaudal;


      thresholdDown =
        settings.thresholdDownCaudal;
    }
  }


  // ----------------------------------------------------------
  // SIN VALOR PRINCIPAL
  // ----------------------------------------------------------

  if (
    mainValue === null ||
    !Number.isFinite(
      mainValue
    )
  ) {

    console.warn(
      `ViCaRiA: código ${code} no tiene valor principal válido.`,
      {
        useHeight,
        caudal,
        altura,
        sensors
      }
    );


    return null;
  }


  // ----------------------------------------------------------
  // AJUSTE
  // ----------------------------------------------------------

  const adjustmentEnabled =
    !!settings.adjustmentEnabled;


  const adjustmentValue =
    parseFloat(
      settings.adjustmentValue
    ) || 0;


  // ----------------------------------------------------------
  // SPARKLINE
  // ----------------------------------------------------------

  let sparklineHTML =
    '';


  if (
    settings.showSparkline
  ) {

    sparklineHTML =
      generateSparklineSVG(
        code,
        useHeight ||
          is8098,
        is8098,
        adjustmentEnabled
          ? adjustmentValue
          : 0
      );
  }


  // ----------------------------------------------------------
  // VALOR MOSTRADO
  // ----------------------------------------------------------

  const displayValue =
    mainValue +
    (
      adjustmentEnabled
        ? adjustmentValue
        : 0
    );


  const useHeightForAvg =
    settings.useHeight ||
    code === "8098";


  const hourlyAverage =
    getHourlyAverage(
      code,
      useHeightForAvg,
      code === "8098",
      adjustmentEnabled
        ? adjustmentValue
        : 0
    );


  const formattedAverage =
    hourlyAverage !== null

      ? Math.round(
          hourlyAverage
        ).toLocaleString(
          'es-AR'
        )

      : '-';


  const averageDisplay =
    `x̄ ${formattedAverage} ${mainUnit} | `;


  // ----------------------------------------------------------
  // VARIACIÓN
  // ----------------------------------------------------------

  const variation =
    displayValue -
    assignedValue;

  alarmInfo[code] = { variation, unit: mainUnit };


  let statusClass =
    'status-normal';


  // ----------------------------------------------------------
  // CONTADORES
  // ----------------------------------------------------------

  if (
    !thresholdCounters[code]
  ) {

    thresholdCounters[code] = {

      up:
        0,

      down:
        0,

      lastStatus:
        'normal'
    };
  }


  // ----------------------------------------------------------
  // ESTADO
  // ----------------------------------------------------------

  if (isOutdated) {

    statusClass =
      'status-outdated';


    thresholdCounters[code] = {

      up:
        0,

      down:
        0,

      lastStatus:
        'normal'
    };

  }

  else {

    let currentStatus =
      'normal';


    // --------------------------------------------------------
    // ALTO
    // --------------------------------------------------------

    if (
      variation >
      thresholdUp
    ) {

      currentStatus =
        'up';


      statusClass =
        'status-high';


      if (
        thresholdCounters[code]
          .lastStatus ===
        'up'
      ) {

        thresholdCounters[code]
          .up++;

      }

      else {

        thresholdCounters[code] = {

          up:
            1,

          down:
            0,

          lastStatus:
            'up'
        };
      }


      if (
        settings.alarmEnabled &&
        thresholdCounters[code]
          .up >=
          settings.alarmCycles &&
        !alarmStates[code]?.active
      ) {

        startAlarm(
          code,
          'up'
        );
      }

    }


    // --------------------------------------------------------
    // BAJO
    // --------------------------------------------------------

    else if (
      variation <
      -Math.abs(
        thresholdDown
      )
    ) {

      currentStatus =
        'down';


      statusClass =
        'status-low';


      if (
        thresholdCounters[code]
          .lastStatus ===
        'down'
      ) {

        thresholdCounters[code]
          .down++;

      }

      else {

        thresholdCounters[code] = {

          up:
            0,

          down:
            1,

          lastStatus:
            'down'
        };
      }


      if (
        settings.alarmEnabled &&
        thresholdCounters[code]
          .down >=
          settings.alarmCycles &&
        !alarmStates[code]?.active
      ) {

        startAlarm(
          code,
          'down'
        );
      }

    }


    // --------------------------------------------------------
    // NORMAL
    // --------------------------------------------------------

    else {

      thresholdCounters[code] = {

        up:
          0,

        down:
          0,

        lastStatus:
          'normal'
      };


      if (
        alarmStates[code]?.active
      ) {

        stopAlarm(
          code
        );
      }
    }
  }


  // ----------------------------------------------------------
  // TENDENCIA
  // ----------------------------------------------------------

  const trend =
    codesData[code]?.trend ||
    'stable';


  let trendEmoji;


  switch (trend) {

    case 'up':
      trendEmoji =
        '↗️';
      break;

    case 'down':
      trendEmoji =
        '↘️';
      break;

    // Sin datos de la hoja para este código: no se muestra tendencia.
    case 'none':
      trendEmoji =
        '';
      break;

    default:
      trendEmoji =
        '➡️';
      break;
  }


  // ----------------------------------------------------------
  // FECHA FORMATEADA
  // ----------------------------------------------------------

  const date =
    new Date(
      fecha
    );


  const formattedDate =
    date.toLocaleDateString(
      'es-AR',
      {
        day:
          '2-digit',

        month:
          '2-digit'
      }
    ) +
    ' ' +
    date.toLocaleTimeString(
      'es-AR',
      {
        hour:
          '2-digit',

        minute:
          '2-digit'
      }
    );


  // ----------------------------------------------------------
  // INDICADOR DE AJUSTE
  // ----------------------------------------------------------

  const adjustmentBadge =
    adjustmentEnabled

      ? `
        <div
          class="adjust-indicator"
          title="Valor ajustado">
          ±
        </div>
      `

      : '';


  // ----------------------------------------------------------
  // CREAR ELEMENTO
  // ----------------------------------------------------------

  const fmtInt = v => Math.round(v).toLocaleString('es-AR');

  const secondaryText =
    secondaryValue !== null
      ? `${fmtInt(secondaryValue)} ${secondaryUnit}`
      : '-';

  const assignedText = `${fmtInt(assignedValue)} ${mainUnit}`;

  const variationText =
    `${variation >= 0 ? '+' : ''}${fmtInt(variation)} ${mainUnit}`;

  const secondaryLabelText =
    secondaryUnit === 'cm' ? 'Altura' : 'Caudal';

  const statusText =
    { 'status-high': 'Alto', 'status-low': 'Bajo', 'status-outdated': 'Desactualizado' }[statusClass] || 'Normal';

  const card =
    document.createElement(
      'div'
    );


  card.className =
    'card';


  card.dataset.code =
    code;


  card.innerHTML = `

    <div
      class="card-main ${statusClass} ${cardUi.flipped.has(code) ? 'flipped' : ''} ${cardUi.actions.has(code) ? 'show-actions' : ''}"
      onclick="cardTap('${code}', event)">
      <div class="card-flip">
      <div class="card-face card-front">

      ${adjustmentBadge}

      <div
        class="alarm-indicator
          ${settings.alarmEnabled ? 'enabled' : ''}
          ${alarmStates[code]?.active ? 'ringing' : ''}">
        🔔
      </div>




      <div class="card-header">

        <div class="card-code">
          ${displayName}
        </div>

        <span class="status-badge badge-${statusClass.replace('status-', '')}">
          ${ { 'status-high': 'Alto', 'status-low': 'Bajo', 'status-outdated': 'Desactualizado' }[statusClass] || 'Normal' }
        </span>

      </div>


      <div class="caudal-display">

        <div class="main-value">

          <div class="caudal-value">

            ${
              displayValue !== null

                ? Math.round(
                    displayValue
                  ).toLocaleString(
                    'es-AR'
                  )

                : '-'
            }

          </div>


          <div class="caudal-unit">

            ${mainUnit}

            <span class="trend-emoji">
              ${trendEmoji}
            </span>

          </div>

        </div>


        <div class="secondary-info">

          ${
            secondaryValue !== null

              ? `${Math.round(
                  secondaryValue
                ).toLocaleString(
                  'es-AR'
                )} ${secondaryUnit}`

              : '-'
          }

          |

          ${
            Math.round(
              assignedValue
            ).toLocaleString(
              'es-AR'
            )
          }

          ${mainUnit}

          |

          ${
            variation >= 0
              ? '+'
              : ''
          }

          ${
            Math.round(
              variation
            ).toLocaleString(
              'es-AR'
            )
          }

          ${mainUnit}

        </div>

      </div>


      <div class="diff-info">${variationText}</div>
      <div class="last-update">

        ${averageDisplay}
        ${formattedDate}

      </div>


      <div class="card-footer">
      ${
        hasSheetHistory(code)

          ? `
            <div class="card-actions" role="dialog" aria-label="Ver historial">
              <button
                type="button"
                class="history-btn"
                title="Ver gráfico"
                aria-label="Ver gráfico"
                onclick="openHistoryModal('${code}', event, 'chart')">
                <span class="hb-emoji">📈</span>
                <svg class="hb-svg" width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 15c3-7 5-7 8 0s5 7 8 0"/><circle cx="18.4" cy="15" r="1.3" fill="currentColor" stroke="none"/></svg>
                <span class="hb-label">Gráfico</span>
              </button>
              <button
                type="button"
                class="history-btn"
                title="Ver tabla"
                aria-label="Ver tabla"
                onclick="openHistoryModal('${code}', event, 'table')">
                <span class="hb-emoji">📋</span>
                <svg class="hb-svg" width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/></svg>
                <span class="hb-label">Tabla</span>
              </button>
              <button type="button" class="card-actions-close" aria-label="Cerrar">✕</button>
            </div>
          `

          : ''
      }
        ${sparklineHTML}
      </div>
    </div>
    <div class="card-face card-back">
      <div class="card-header">
        <div class="card-code">
          ${displayName}
        </div>
        <span class="status-badge badge-${statusClass.replace('status-', '')}">
          ${statusText}
        </span>
      </div>
      <dl class="back-data">
        <div><dt>${secondaryLabelText}</dt><dd>${secondaryText}</dd></div>
        <div><dt>Asignado</dt><dd>${assignedText}</dd></div>
        <div><dt>Promedio horario</dt><dd>${formattedAverage} ${mainUnit}</dd></div>
        <div><dt>Actualizado</dt><dd>${formattedDate}</dd></div>
      </dl>
    </div>
    </div>

    </div>


    <div class="card-config" onclick="if (event.target === this) toggleExpand('${code}', 'close')">

      <div class="config-form">

        <div class="config-title">
          ⚙️ Configuración
        </div>


        <div class="form-group">

          <label>
            Nombre Personalizado
          </label>

          <input
            type="text"
            value="${settings.customName}"
            placeholder="${codeInfo.name}"
            onchange="updateSetting('${code}', 'customName', this.value)">

        </div>


        <div class="switch-container">

          <label>
            ⭐ Marcar como Favorito
          </label>

          <label class="switch">

            <input
              type="checkbox"
              ${isFavorite ? 'checked' : ''}
              onchange="toggleFavoriteFromCard('${code}', this.checked)">

            <span class="slider"></span>

          </label>

        </div>


        <div class="switch-container">

          <label>
            📉 Mostrar Sparkline (3h)
          </label>

          <label class="switch">

            <input
              type="checkbox"
              ${settings.showSparkline ? 'checked' : ''}
              onchange="updateSetting('${code}', 'showSparkline', this.checked)">

            <span class="slider"></span>

          </label>

        </div>


        <div class="form-row">

          <div class="form-group">

            <label>
              Caudal Asignado (l/s)
            </label>

            <input
              type="number"
              step="0.1"
              value="${settings.assignedCaudal}"
              ${useHeight ? 'disabled' : ''}
              onchange="updateSetting('${code}', 'assignedCaudal', this.value)">

          </div>


          <div class="form-group">

            <label>
              Altura Asignada (cm)
            </label>

            <input
              type="number"
              step="0.1"
              value="${settings.assignedAltura}"
              ${!useHeight ? 'disabled' : ''}
              onchange="updateSetting('${code}', 'assignedAltura', this.value)">

          </div>

        </div>


        <div class="radio-group">

          <label>

            <input
              type="radio"
              name="param_${code}"
              value="caudal"
              ${!useHeight ? 'checked' : ''}
              onchange="updateParameter('${code}', false)">

            <span>
              💧 Usar Caudal
            </span>

          </label>


          <label>

            <input
              type="radio"
              name="param_${code}"
              value="altura"
              ${useHeight ? 'checked' : ''}
              onchange="updateParameter('${code}', true)">

            <span>
              📏 Usar Altura
            </span>

          </label>

        </div>


        <div class="form-row">

          <div class="form-group">

            <label>
              Umbral ⬆ (${mainUnit})
            </label>

            <input
              type="number"
              step="0.1"
              value="${thresholdUp}"
              onchange="updateSetting('${code}', 'thresholdUp', this.value)">

          </div>


          <div class="form-group">

            <label>
              Umbral ⬇ (${mainUnit})
            </label>

            <input
              type="number"
              step="0.1"
              value="${thresholdDown}"
              onchange="updateSetting('${code}', 'thresholdDown', this.value)">

          </div>

        </div>


        <div class="switch-container alarm-toggle">

          <label>
            🔔 Alarma Sonora y Notificaciones
          </label>

          <label class="switch">

            <input
              type="checkbox"
              ${settings.alarmEnabled ? 'checked' : ''}
              onchange="updateSetting('${code}', 'alarmEnabled', this.checked)">

            <span class="slider"></span>

          </label>

        </div>


        <div class="radio-group cycles-group">

          <label>

            <input
              type="radio"
              name="cycles_${code}"
              value="1"
              ${settings.alarmCycles === 1 ? 'checked' : ''}
              onchange="updateSetting('${code}', 'alarmCycles', 1)">

            <span>
              ⚡ 1 Ciclo
            </span>

          </label>


          <label>

            <input
              type="radio"
              name="cycles_${code}"
              value="3"
              ${settings.alarmCycles === 3 ? 'checked' : ''}
              onchange="updateSetting('${code}', 'alarmCycles', 3)">

            <span>
              🔄 3 Ciclos
            </span>

          </label>

        </div>
        <div class="alarm-note">🔔 La alarma sonora solo se oirá con la pantalla de la app activa.</div>


        <div
          class="form-row"
          style="align-items:center;">

          <div class="form-group">

            <label>
              Orden
            </label>

            <input
              type="number"
              min="1"
              value="${selectedCodes.indexOf(code) + 1}"
              onchange="updateOrder('${code}', this.value)">

          </div>


          <div class="form-group">

            <label>
              Ajuste
            </label>


            <div
              style="display:flex; gap:8px; align-items:center;">

              <label
                style="display:flex; align-items:center; gap:8px; margin:0;">

                <input
                  type="checkbox"
                  ${settings.adjustmentEnabled ? 'checked' : ''}
                  onchange="updateSetting('${code}', 'adjustmentEnabled', this.checked)">

                Activar

              </label>


              <input
                type="number"
                step="0.1"
                value="${settings.adjustmentValue}"
                onchange="updateSetting('${code}', 'adjustmentValue', this.value)"
                placeholder="+0.0"
                style="flex:1; min-width:100px;">

            </div>

          </div>

        </div>


        ${
          hasSheetHistory(code)

            ? `
              <div class="config-history" style="display:flex; gap:10px;">
                <button
                  class="btn"
                  style="background:#3f51b5; flex:1;"
                  onclick="openHistoryModal('${code}', undefined, 'chart')">
                  📈 Gráfico
                </button>
                <button
                  class="btn"
                  style="background:#3f51b5; flex:1;"
                  onclick="openHistoryModal('${code}', undefined, 'table')">
                  📋 Tabla
                </button>
              </div>
            `

            : ''
        }


        ${
          alarmStates[code]?.active

            ? `
              <button
                class="btn"
                style="background:#f44336; width:100%;"
                onclick="stopAlarm('${code}')">

                🔕 Silenciar Alarma

              </button>
            `

            : ''
        }


        <button
          class="btn btn-close-config"
          onclick="toggleExpand('${code}', 'close')">

          ✕ Cerrar

        </button>

      </div>

    </div>
  `;


  return card;
}


// ============================================================
// RENDERIZAR TARJETAS
// ============================================================

function renderCards() {

  const expandedCodes =
    Array.from(
      cardsGrid.querySelectorAll(
        '.card.expanded'
      )
    ).map(
      card =>
        normalizeCode(
          card.dataset.code
        )
    );


  cardsGrid.innerHTML =
    '';


  const visibleCodes =
    selectedCodes
      .map(
        normalizeCode
      )
      .filter(
        code =>
          !hiddenCodes
            .map(
              normalizeCode
            )
            .includes(
              code
            )
      );


  if (
    visibleCodes.length === 0
  ) {

    emptyState.style.display =
      'block';


    cardsGrid.removeAttribute(
      'data-count'
    );


    updateCounters();

    return;
  }


  emptyState.style.display =
    'none';


  let filteredCodes =
    visibleCodes;


  // ----------------------------------------------------------
  // FAVORITOS
  // ----------------------------------------------------------

  if (
    currentFilter ===
    'favorites'
  ) {

    filteredCodes =
      visibleCodes.filter(
        code =>
          favoriteCodes
            .map(
              normalizeCode
            )
            .includes(
              code
            )
      );
  }


  // ----------------------------------------------------------
  // ALARMAS
  // ----------------------------------------------------------

  else if (
    currentFilter ===
    'alarm'
  ) {

    filteredCodes =
      visibleCodes.filter(
        code =>
          alarmStates[code]?.active
      );
  }


  // ----------------------------------------------------------
  // CANTIDAD
  // ----------------------------------------------------------

  if (
    filteredCodes.length <=
    20
  ) {

    cardsGrid.setAttribute(
      'data-count',
      filteredCodes.length
    );

  } else {

    cardsGrid.removeAttribute(
      'data-count'
    );
  }


  // ----------------------------------------------------------
  // CREAR
  // ----------------------------------------------------------
console.log(
  '========== RECORRIDO 8006 =========='
);

console.log(
  'selectedCodes:',
  selectedCodes.map(normalizeCode)
);

console.log(
  'hiddenCodes:',
  hiddenCodes.map(normalizeCode)
);

console.log(
  'visibleCodes:',
  visibleCodes
);

console.log(
  'filteredCodes:',
  filteredCodes
);

console.log(
  '8006 en selectedCodes:',
  selectedCodes
    .map(normalizeCode)
    .includes('8006')
);

console.log(
  '8006 en visibleCodes:',
  visibleCodes.includes('8006')
);

console.log(
  '8006 en filteredCodes:',
  filteredCodes.includes('8006')
);

console.log(
  '===================================='
);




  filteredCodes.forEach(
    code => {

      const card =
        createCard(
          code
        );


      if (card) {

        if (
          expandedCodes.includes(
            code
          )
        ) {

          card.classList.add(
            'expanded'
          );
        }


        cardsGrid.appendChild(
          card
        );
      }

    }
  );


  updateCounters();

  adjustLastRowStretch();
}


// ============================================================
// CONTADORES
// ============================================================

function updateCounters() {

  const visibleCodes =
    selectedCodes.filter(
      code =>
        !hiddenCodes.includes(
          code
        )
    );

  // La función queda preparada para
  // los contadores existentes en HTML.
  // No se fuerza ningún elemento que no exista.
}


// ============================================================
// EXPANDIR / CONTRAER TARJETA
// ============================================================

function closeCardActions(code) {

  code =
    normalizeCode(
      code
    );

  cardUi.actions.delete(code);

  const card =
    document.querySelector(
      `[data-code="${CSS.escape(code)}"]`
    );

  const main =
    card && card.querySelector('.card-main');

  if (main) {
    main.classList.remove('show-actions');
  }
}

window.cardTap =
function(
  code,
  event
) {

  code =
    normalizeCode(
      code
    );

  const card =
    document.querySelector(
      `[data-code="${CSS.escape(code)}"]`
    );

  if (!card || !event) {
    return;
  }

  const main = card.querySelector('.card-main');
  const target = event.target;

  // Ventana de gráfico/tabla: los botones tienen su manejador; tocar el fondo la cierra.
  if (target.closest('.card-actions')) {

    if (!target.closest('.history-btn')) {
      closeCardActions(code);
    }

    return;
  }

  // Valor principal: muestra / oculta los iconos de gráfico y tabla.
  if (target.closest('.main-value')) {

    const visible = main.classList.toggle('show-actions');

    cardUi.actions[visible ? 'add' : 'delete'](code);

    return;
  }

  // Móvil: tocar el lado izquierdo da vuelta la tarjeta.
  if (window.matchMedia('(max-width: 768px)').matches) {

    const rect = main.getBoundingClientRect();

    if (event.clientX - rect.left < rect.width / 2) {

      closeCardActions(code);

      const flipped = main.classList.toggle('flipped');

      cardUi.flipped[flipped ? 'add' : 'delete'](code);

      return;
    }
  }

  toggleExpand(code, 'main');
};

window.toggleExpand =
function(
  code,
  source
) {

  code =
    normalizeCode(
      code
    );


  const card =
    document.querySelector(
      `[data-code="${CSS.escape(code)}"]`
    );


  if (!card) {
    return;
  }


  const isExpanded =
    card.classList.contains(
      'expanded'
    );


  if (
    isExpanded &&
    source === 'main'
  ) {

    return;
  }


  card.classList.toggle(
    'expanded'
  );

  // Al cerrar: se aplican de una vez los cambios pendientes.
  if (!card.classList.contains('expanded') && renderPending) {
    renderPending = false;
    renderCards();
  }
};


// ============================================================
// CAMBIAR PARÁMETRO
// ============================================================

window.updateParameter =
function(
  code,
  useHeight
) {

  code =
    normalizeCode(
      code
    );


  const settings =
    getCodeSettings(
      code
    );


  settings.useHeight =
    useHeight;


  saveCodeSettings(
    code,
    settings
  );


  requestRender();
};


// ============================================================
// FAVORITO DESDE TARJETA
// ============================================================

window.toggleFavoriteFromCard =
function(
  code,
  isChecked
) {

  code =
    normalizeCode(
      code
    );


  const index =
    favoriteCodes
      .map(
        normalizeCode
      )
      .indexOf(
        code
      );


  if (
    isChecked &&
    index === -1
  ) {

    favoriteCodes.push(
      code
    );

  }

  else if (
    !isChecked &&
    index > -1
  ) {

    favoriteCodes.splice(
      index,
      1
    );
  }


  saveToStorage();

  renderCodeList();

  requestRender();
};


// ============================================================
// ACTUALIZAR CONFIGURACIÓN
// ============================================================

window.updateSetting =
function(
  code,
  field,
  value
) {

  code =
    normalizeCode(
      code
    );


  const settings =
    getCodeSettings(
      code
    );


  const floatValue =
    parseFloat(
      value
    );


  // ----------------------------------------------------------
  // ALARMA
  // ----------------------------------------------------------

  if (
    field ===
    'alarmEnabled'
  ) {

    settings[field] =
      !!value;


    if (!value) {

      stopAlarm(
        code
      );


      thresholdCounters[code] = {

        up:
          0,

        down:
          0,

        lastStatus:
          'normal'
      };
    }


    if (
      value &&
      "Notification" in window &&
      Notification.permission ===
        "default"
    ) {

      Notification.requestPermission();
    }
  }


  // ----------------------------------------------------------
  // NOMBRE
  // ----------------------------------------------------------

  else if (
    field ===
    'customName'
  ) {

    settings[field] =
      value;
  }


  // ----------------------------------------------------------
  // CICLOS
  // ----------------------------------------------------------

  else if (
    field ===
    'alarmCycles'
  ) {

    settings[field] =
      parseInt(
        value
      );


    thresholdCounters[code] = {

      up:
        0,

      down:
        0,

      lastStatus:
        'normal'
    };
  }


  // ----------------------------------------------------------
  // AJUSTE ACTIVADO
  // ----------------------------------------------------------

  else if (
    field ===
    'adjustmentEnabled'
  ) {

    settings[field] =
      !!value;
  }


  // ----------------------------------------------------------
  // VALOR DEL AJUSTE
  // ----------------------------------------------------------

  else if (
    field ===
    'adjustmentValue'
  ) {

    settings[field] =
      Number.isFinite(
        floatValue
      )

        ? floatValue

        : 0;
  }


  // ----------------------------------------------------------
  // SPARKLINE
  // ----------------------------------------------------------

  else if (
    field ===
    'showSparkline'
  ) {

    settings[field] =
      !!value;
  }


  // ----------------------------------------------------------
  // CAUDAL / ALTURA ASIGNADOS
  // ----------------------------------------------------------

  else if (
    field ===
      'assignedCaudal' ||
    field ===
      'assignedAltura'
  ) {

    settings[field] =
      Number.isFinite(
        floatValue
      )

        ? floatValue

        : 0;
  }


  // ----------------------------------------------------------
  // UMBRALES
  // ----------------------------------------------------------

  else if (
    field ===
      'thresholdUp' ||
    field ===
      'thresholdDown'
  ) {

    const isHeight =
      settings.useHeight ||
      code === "8098";


    const suffix =
      isHeight
        ? 'Altura'
        : 'Caudal';


    const prefix =
      field ===
        'thresholdUp'
        ? 'thresholdUp'
        : 'thresholdDown';


    settings[
      `${prefix}${suffix}`
    ] =
      Number.isFinite(
        floatValue
      )

        ? floatValue

        : 0;
  }


  saveCodeSettings(
    code,
    settings
  );


  requestRender();
};


// ============================================================
// CAMBIAR ORDEN
// ============================================================

window.updateOrder =
function(
  code,
  newPos
) {

  code =
    normalizeCode(
      code
    );


  newPos =
    parseInt(
      newPos
    ) -
    1;


  if (
    isNaN(
      newPos
    )
  ) {

    return;
  }


  const oldIndex =
    selectedCodes
      .map(
        normalizeCode
      )
      .indexOf(
        code
      );


  if (
    oldIndex === -1
  ) {

    return;
  }


  newPos =
    Math.max(
      0,
      Math.min(
        newPos,
        selectedCodes.length -
        1
      )
    );


  selectedCodes.splice(
    oldIndex,
    1
  );


  selectedCodes.splice(
    newPos,
    0,
    code
  );


  selectedCodes =
    selectedCodes.map(
      normalizeCode
    );


  localStorage.setItem(
    'vicaria_selected_codes',
    JSON.stringify(
      selectedCodes
    )
  );


  requestRender();
};


// ============================================================
// LISTA DE CÓDIGOS
// ============================================================

function renderCodeList() {

  if (!codeList) {
    return;
  }


  codeList.innerHTML =
    '';


  const sortedCodes =
    [...allCodes].sort(
      (a, b) => {

        const aCode =
          normalizeCode(
            a.code
          );


        const bCode =
          normalizeCode(
            b.code
          );


        const aFav =
          favoriteCodes
            .map(
              normalizeCode
            )
            .includes(
              aCode
            );


        const bFav =
          favoriteCodes
            .map(
              normalizeCode
            )
            .includes(
              bCode
            );


        if (
          aFav &&
          !bFav
        ) {

          return -1;
        }


        if (
          !aFav &&
          bFav
        ) {

          return 1;
        }


        return aCode.localeCompare(
          bCode,
          undefined,
          {
            numeric:
              true
          }
        );
      }
    );


  sortedCodes.forEach(
    ({
      code,
      name
    }) => {

      code =
        normalizeCode(
          code
        );


      const isSelected =
        selectedCodes
          .map(
            normalizeCode
          )
          .includes(
            code
          );


      const isFavorite =
        favoriteCodes
          .map(
            normalizeCode
          )
          .includes(
            code
          );


      const item =
        document.createElement(
          'div'
        );


      item.className =
        `code-item ${
          isSelected
            ? 'selected'
            : ''
        }`;


      item.dataset.code =
        code;


      item.dataset.name =
        String(
          name || ''
        )
          .toLowerCase();


      item.innerHTML = `

        <input
          type="checkbox"
          class="code-checkbox"
          ${isSelected ? 'checked' : ''}
          onchange="toggleCodeSelection('${code}')">


        <div class="code-info">

          <div class="code-number">
            ${code}
          </div>

          <div class="code-description">
            ${name}
          </div>

        </div>


        <button
          class="code-favorite"
          onclick="toggleFavoriteFromList('${code}', event)">

          ${
            isFavorite
              ? '⭐'
              : '☆'
          }

        </button>
      `;


      codeList.appendChild(
        item
      );
    }
  );
}


// ============================================================
// SELECCIÓN DE CÓDIGOS
// ============================================================

window.toggleCodeSelection =
function(
  code
) {

  code =
    normalizeCode(
      code
    );


  const index =
    selectedCodes
      .map(
        normalizeCode
      )
      .indexOf(
        code
      );


  if (
    index > -1
  ) {

    selectedCodes.splice(
      index,
      1
    );


    hiddenCodes =
      hiddenCodes.filter(
        c =>
          normalizeCode(c) !==
          code
      );


    stopAlarm(
      code
    );


    delete thresholdCounters[
      code
    ];

  }

  else {

    selectedCodes.push(
      code
    );
  }


  selectedCodes =
    [
      ...new Set(
        selectedCodes.map(
          normalizeCode
        )
      )
    ];


  saveToStorage();

  renderCodeList();

  renderCards();
};


// ============================================================
// FAVORITO DESDE LISTA
// ============================================================

window.toggleFavoriteFromList =
function(
  code,
  event
) {

  if (event) {
    event.stopPropagation();
  }


  code =
    normalizeCode(
      code
    );


  const index =
    favoriteCodes
      .map(
        normalizeCode
      )
      .indexOf(
        code
      );


  if (
    index > -1
  ) {

    favoriteCodes.splice(
      index,
      1
    );

  }

  else {

    favoriteCodes.push(
      code
    );
  }


  favoriteCodes =
    [
      ...new Set(
        favoriteCodes.map(
          normalizeCode
        )
      )
    ];


  saveToStorage();

  renderCodeList();

  renderCards();
};


// ============================================================
// HISTORIAL
// ============================================================

window.openHistoryModal =
function(
  code,
  event,
  view
) {

  if (event) {
    event.stopPropagation();
  }


  code =
    normalizeCode(
      code
    );


  currentHistoryCode =
    code;


  const settings =
    getCodeSettings(
      code
    );


  const codeInfo =
    allCodes.find(
      c =>
        normalizeCode(
          c.code
        ) ===
        code
    );


  const displayName =
    settings.customName ||
    codeInfo?.name ||
    code;


  closeCardActions(code);

  historyView =
    view === 'table'
      ? 'table'
      : 'chart';

  historyModal.classList.toggle('view-chart', historyView === 'chart');
  historyModal.classList.toggle('view-table', historyView === 'table');

  historyModalTitle.textContent =
    historyView === 'table'
      ? `📋 Tabla de ${displayName} (${code})`
      : `📈 Gráfico de ${displayName} (${code})`;


  historyModal.classList.add(
    'active'
  );


  timeRangeSelect.value =
    '4';

  resetCustomRange();


  renderHistoryChart(
    code
  );
};


// ============================================================
// GRÁFICO DE HISTORIAL
// ============================================================

// Evita que una respuesta lenta pise a una más reciente
// (por ejemplo, al cambiar el rango de horas rápidamente).
let historyRequestId = 0;


// Rango de fechas personalizado del historial (null = se usa el selector de horas).
let customHistoryRange = null;

const MAX_CUSTOM_RANGE_DAYS = 31;

function toLocalInputValue(ms) {

  const d = new Date(ms);

  const p = n => String(n).padStart(2, '0');

  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}`
  );
}

function setRangeMessage(text) {

  if (rangeMessage) {
    rangeMessage.textContent = text || '';
  }
}

function resetCustomRange() {

  customHistoryRange = null;

  if (rangeStartInput) rangeStartInput.value = '';
  if (rangeEndInput) rangeEndInput.value = '';

  setRangeMessage('');

  syncHourChips();
}

// Texto para el nombre del CSV: "4h" o "20261001-0800_a_20261003-2000".
function historyRangeTag() {

  if (customHistoryRange) {

    const f = ms =>
      toLocalInputValue(ms).replace(/[-:]/g, '').replace('T', '-');

    return `${f(customHistoryRange.start)}_a_${f(customHistoryRange.end)}`;
  }

  return `${timeRangeSelect.value}h`;
}

// Etiquetas del eje X: con fecha cuando el rango es largo.
function historyLabelOptions() {

  const withDate =
    !!customHistoryRange ||
    parseInt(timeRangeSelect.value) >= 24;

  return withDate
    ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit', day: '2-digit' };
}

function syncHourChips() {

  if (!hourChips) {
    return;
  }

  hourChips.querySelectorAll('button').forEach(
    b => b.classList.toggle(
      'on',
      !customHistoryRange && b.dataset.h === timeRangeSelect.value
    )
  );
}

function setLastUpdated() {

  if (!lastUpdatedEl) {
    return;
  }

  lastUpdatedEl.textContent =
    'Actualizado ' +
    new Date().toLocaleTimeString(
      'es-AR',
      { hour: '2-digit', minute: '2-digit' }
    );
}

function applyCustomRange() {

  if (!currentHistoryCode) {
    return;
  }

  if (!rangeStartInput.value) {
    setRangeMessage('Elegí la fecha y hora de inicio.');
    return;
  }

  const startMs = new Date(rangeStartInput.value).getTime();

  // Sin fecha final: hasta ahora. Con fecha final: incluye ese minuto completo.
  const endMs = rangeEndInput.value
    ? new Date(rangeEndInput.value).getTime() + 59999
    : Date.now();

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    setRangeMessage('Fechas inválidas.');
    return;
  }

  if (endMs <= startMs) {
    setRangeMessage('La fecha final debe ser posterior a la inicial.');
    return;
  }

  if (endMs - startMs > MAX_CUSTOM_RANGE_DAYS * 24 * 60 * 60 * 1000) {
    setRangeMessage(`El rango máximo es de ${MAX_CUSTOM_RANGE_DAYS} días.`);
    return;
  }

  if (!rangeEndInput.value) {
    rangeEndInput.value = toLocalInputValue(endMs);
  }

  customHistoryRange = { start: startMs, end: endMs };

  syncHourChips();

  setRangeMessage('');

  renderHistoryChart(currentHistoryCode);
}


window.renderHistoryChart =
async function(
  code
) {

  code =
    normalizeCode(
      code
    );


  chartLoading.style.display =
    'block';


  const rangeHours =
    parseInt(
      timeRangeSelect.value
    );


  const requestId =
    ++historyRequestId;


  // ----------------------------------------------------------
  // LEER HISTORIAL DE GOOGLE SHEETS (no se guarda en el navegador)
  // ----------------------------------------------------------

  let filteredData =
    [];


  try {

    const sheetData =
      (
        customHistoryRange
          ? await fetchSheetHistoryRange(
              customHistoryRange.start,
              customHistoryRange.end
            )
          : await fetchSheetHistory(rangeHours)
      );


    if (
      requestId !==
      historyRequestId
    ) {
      return;
    }


    filteredData =
      sheetData[code] ||
      [];

  } catch (error) {

    if (
      requestId !==
      historyRequestId
    ) {
      return;
    }


    console.error(
      'Error al leer el historial de la hoja:',
      error
    );


    currentHistoryRows =
      [];


    if (currentChart) {

      currentChart.destroy();

      currentChart =
        null;
    }


    historyTableContainer.innerHTML =
      `<p class="history-error">
        ❌ No se pudo leer el historial de la hoja:
        ${error.message}
      </p>`;


    chartLoading.style.display =
      'none';

    return;
  }


  currentHistoryRows =
    filteredData;


  const settings =
    getCodeSettings(
      code
    );


  const useHeight =
    settings.useHeight;


  const is8098 =
    code === "8098";


  const labels =
    filteredData.map(
      item =>
        new Date(
          item.timestamp
        ).toLocaleTimeString('es-AR', historyLabelOptions())
    );


  let mainLabel =
    settings.useHeight
      ? 'Altura (cm)'
      : 'Caudal (l/s)';


  const adjustment =
    settings.adjustmentEnabled

      ? parseFloat(
          settings.adjustmentValue
        ) || 0

      : 0;


  const mainData =
    filteredData.map(
      item => {

        if (is8098) {

          return item.alturaAN1 !==
            null

            ? item.alturaAN1 +
              adjustment

            : null;
        }


        if (useHeight) {

          return item.altura !==
            null

            ? item.altura +
              adjustment

            : null;
        }


        return item.caudal !==
          null

          ? item.caudal +
            adjustment

          : null;
      }
    );


  let secondaryLabel =
    settings.useHeight
      ? 'Caudal (l/s)'
      : 'Altura (cm)';


  const secondaryData =
    filteredData.map(
      item => {

        if (is8098) {

          return item.caudal !==
            null

            ? item.caudal

            : null;
        }


        if (useHeight) {

          return item.caudal !==
            null

            ? item.caudal

            : null;
        }


        return item.altura !==
          null

          ? item.altura

          : null;
      }
    );


  const assignedValue =
    is8098

      ? settings.assignedAltura

      : (
          settings.useHeight
            ? settings.assignedAltura
            : settings.assignedCaudal
        );


  if (currentChart) {

    currentChart.destroy();

    currentChart =
      null;
  }


  currentChart =
    new Chart(
      historyChartCanvas,
      {

        type:
          'line',


        data: {

          labels,


          datasets: [

            {

              label:
                mainLabel +
                (
                  settings.adjustmentEnabled
                    ? ' (Ajustado)'
                    : ''
                ),

              data:
                mainData,

              borderColor:
                '#667eea',

              backgroundColor:
                'rgba(102, 126, 234, 0.1)',

              fill:
                true,

              yAxisID:
                'y'
            },


            {

              label:
                secondaryLabel,

              data:
                secondaryData,

              borderColor:
                '#4caf50',

              backgroundColor:
                'rgba(76, 175, 80, 0.1)',

              fill:
                false,

              borderDash:
                [5, 5],

              hidden:
                true,

              yAxisID:
                'y2'
            },


            {

              label:
                'Asignado',

              data:
                mainData.map(
                  () =>
                    assignedValue
                ),

              borderColor:
                '#ff9800',

              backgroundColor:
                'transparent',

              pointRadius:
                0,

              borderWidth:
                2,

              borderDash:
                [10, 5],

              yAxisID:
                'y'
            }

          ]
        },


        options: {

          responsive:
            true,

          maintainAspectRatio:
            false,


          scales: {

            y: {

              type:
                'linear',

              display:
                'auto',

              position:
                'left',

              title: {

                display:
                  true,

                text:
                  mainLabel +
                  (
                    settings.adjustmentEnabled
                      ? ' (Ajustado)'
                      : ''
                  )
              }
            },


            y2: {

              type:
                'linear',

              display:
                'auto',

              position:
                'right',

              title: {

                display:
                  true,

                text:
                  secondaryLabel
              },


              grid: {

                drawOnChartArea:
                  false
              }
            }
          },


          plugins: {

            legend: {
              position:
                'top',
              labels: {
                usePointStyle:
                  true,
                pointStyle:
                  'line',
                boxWidth:
                  36,
                boxHeight:
                  2
              }
            },


            title: {

              display:
                false
            }
          },


          elements: {

            point: {

              radius:
                2
            }
          }
        }
      }
    );


  renderHistoryTable(
    filteredData,
    settings
  );


  chartLoading.style.display =
    'none';
};


// ============================================================
// TABLA HISTORIAL
// ============================================================

function renderHistoryTable(
  data,
  settings
) {

  historyTableContainer.innerHTML =
    '';


  if (
    data.length === 0
  ) {

    historyTableContainer.innerHTML =
      `
        <p
          style="
            text-align:center;
            padding:20px;
            color:#f5f5f5;">

          No hay datos disponibles
          para el rango de tiempo seleccionado.

        </p>
      `;

    return;
  }


  const useHeight =
    settings.useHeight;


  const is8098 =
    currentHistoryCode ===
    "8098";


  const mainUnit =
    is8098 || useHeight
      ? 'cm'
      : 'l/s';


  const secondaryUnit =
    is8098 || useHeight
      ? 'l/s'
      : 'cm';


  const mainLabel =
    is8098

      ? 'Altura AN1'

      : (
          useHeight
            ? 'Altura'
            : 'Caudal'
        );


  const secondaryLabel =
    is8098

      ? 'Caudal'

      : (
          useHeight
            ? 'Caudal'
            : 'Altura'
        );


  let tableHTML =
    `
      <table class="history-table">

        <thead>

          <tr>

            <th>
              Fecha/Hora
            </th>

            <th>
              ${mainLabel} (${mainUnit})
            </th>

            <th>
              ${secondaryLabel} (${secondaryUnit})
            </th>

          </tr>

        </thead>

        <tbody>
    `;
  // Más actuales primero
  data.slice().reverse().forEach(
    item => {

      const date =
        new Date(
          item.timestamp
        );


      const formattedDate =
        date.toLocaleString(
          'es-AR',
          {
            day:
              '2-digit',

            month:
              '2-digit',

            hour:
              '2-digit',

            minute:
              '2-digit'
          }
        );


      let mainValue;
      let secondaryValue;


      if (is8098) {

        mainValue =
          item.alturaAN1;


        secondaryValue =
          item.caudal;

      }

      else {

        mainValue =
          useHeight
            ? item.altura
            : item.caudal;


        secondaryValue =
          useHeight
            ? item.caudal
            : item.altura;
      }


      const mainDisplay =
        mainValue !== null &&
        Number.isFinite(
          mainValue
        )

          ? Math.round(
              mainValue
            ).toLocaleString(
              'es-AR'
            )

          : '-';


      const secondaryDisplay =
        secondaryValue !== null &&
        Number.isFinite(
          secondaryValue
        )

          ? Math.round(
              secondaryValue
            ).toLocaleString(
              'es-AR'
            )

          : '-';


      tableHTML +=
        `
          <tr>

            <td>
              ${formattedDate}
            </td>

            <td>
              ${mainDisplay}
            </td>

            <td>
              ${secondaryDisplay}
            </td>

          </tr>
        `;
    }
  );


  tableHTML +=
    `
        </tbody>

      </table>
    `;


  historyTableContainer.innerHTML =
    tableHTML;
}


// ============================================================
// DESCARGAR CSV
// ============================================================

window.downloadHistoryCSV =
function(
  code
) {

  code =
    normalizeCode(
      code
    );


  // Se descargan los datos del rango que se está viendo en el gráfico
  // (leídos de la hoja, solo en memoria).
  const codeHistory =
    code === currentHistoryCode
      ? currentHistoryRows
      : [];


  if (
    codeHistory.length ===
    0
  ) {

    alert(
      'No hay datos de historial para descargar.'
    );

    return;
  }


  const headers = [

    'Timestamp (ms)',

    'Fecha_Hora (GMT-3)',

    'Caudal (l/s)',

    'Altura (cm)'

  ];


  let csvContent =
    headers.join(',') +
    '\n';


  codeHistory.forEach(
    item => {

      const date =
        new Date(
          item.timestamp
        );


      const formattedDate =
        date.toLocaleString(
          'es-AR',
          {
            day:
              '2-digit',

            month:
              '2-digit',

            year:
              'numeric',

            hour:
              '2-digit',

            minute:
              '2-digit',

            second:
              '2-digit'
          }
        );


      const row = [

        item.timestamp,

        `"${formattedDate}"`,

        item.caudal !== null
          ? item.caudal.toFixed(2)
          : '',

        item.altura !== null
          ? item.altura.toFixed(2)
          : ''

      ].join(',');


      csvContent +=
        row +
        '\n';
    }
  );


  const blob =
    new Blob(
      [csvContent],
      {
        type:
          'text/csv;charset=utf-8;'
      }
    );


  const fileName =
    `historial_${code}_${historyRangeTag()}_${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;


  if (
    navigator.msSaveBlob
  ) {

    navigator.msSaveBlob(
      blob,
      fileName
    );

  }

  else {

    const link =
      document.createElement(
        "a"
      );


    if (
      link.download !==
      undefined
    ) {

      const url =
        URL.createObjectURL(
          blob
        );


      link.setAttribute(
        "href",
        url
      );


      link.setAttribute(
        "download",
        fileName
      );


      link.style.visibility =
        'hidden';


      document.body.appendChild(
        link
      );


      link.click();


      document.body.removeChild(
        link
      );


      setTimeout(
        () =>
          URL.revokeObjectURL(
            url
          ),
        1000
      );
    }
  }
};


// ============================================================
// EVENTOS DEL HISTORIAL
// ============================================================

if (
  timeRangeSelect
) {

  timeRangeSelect.addEventListener(
    'change',
    () => {

      // Elegir horas descarta el rango de fechas personalizado.
      resetCustomRange();

      renderHistoryChart(currentHistoryCode);
    }
  );
}


if (
  updateChartBtn
) {

  updateChartBtn.addEventListener(
    'click',
    () =>
      renderHistoryChart(
        currentHistoryCode
      )
  );
}


// ------------------------------------------------------------
// GRÁFICO EN PANTALLA COMPLETA
// ------------------------------------------------------------
// Al tocar el gráfico se abre en pantalla completa. Donde el navegador lo
// permite (Android/Chrome) se bloquea además la orientación en horizontal.
// En iPhone no existe ese bloqueo: se muestra un aviso para girar el teléfono
// y el gráfico se adapta solo al hacerlo.

const chartBox = document.getElementById('chartBox');
const chartFsClose = document.getElementById('chartFsClose');
let chartFsActive = false;

function resizeChartSoon() {

  setTimeout(() => {
    if (currentChart) {
      currentChart.resize();
    }
  }, 200);
}

function updateRotateHint() {

  if (!chartBox) {
    return;
  }

  const portrait = window.matchMedia('(orientation: portrait)').matches;

  chartBox.classList.toggle(
    'needs-rotate',
    chartFsActive && portrait && chartBox.dataset.lockFailed === '1'
  );
}

async function openChartFullscreen() {

  if (chartFsActive || !chartBox || !currentChart) {
    return;
  }

  chartFsActive = true;

  chartBox.classList.add('fs');
  chartBox.dataset.lockFailed = '1';

  try {
    if (chartBox.requestFullscreen) {
      await chartBox.requestFullscreen({ navigationUI: 'hide' });
    } else if (chartBox.webkitRequestFullscreen) {
      chartBox.webkitRequestFullscreen();
    }
  } catch (error) {
    // Sin pantalla completa nativa: queda el modo "overlay" por CSS.
  }

  try {
    if (screen.orientation && screen.orientation.lock) {
      await screen.orientation.lock('landscape');
      chartBox.dataset.lockFailed = '0';
    }
  } catch (error) {
    // Bloqueo no disponible (iPhone, escritorio): se pide girar a mano.
  }

  updateRotateHint();
  resizeChartSoon();
}

function closeChartFullscreen() {

  if (!chartFsActive) {
    return;
  }

  chartFsActive = false;

  chartBox.classList.remove('fs', 'needs-rotate');

  try {
    if (screen.orientation && screen.orientation.unlock) {
      screen.orientation.unlock();
    }
  } catch (error) {}

  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;

  if (fsEl) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    try {
      const result = exit.call(document);
      if (result && result.catch) {
        result.catch(() => {});
      }
    } catch (error) {}
  }

  resizeChartSoon();
}

if (historyChartCanvas) {
  historyChartCanvas.addEventListener('click', openChartFullscreen);
}

if (chartFsClose) {
  chartFsClose.addEventListener('click', closeChartFullscreen);
}

// Salir con el gesto "atrás" / Esc del sistema.
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && chartFsActive) {
    closeChartFullscreen();
  }
});

document.addEventListener('webkitfullscreenchange', () => {
  if (!document.webkitFullscreenElement && chartFsActive) {
    closeChartFullscreen();
  }
});

window.addEventListener('resize', () => {
  updateRotateHint();
  resizeChartSoon();
});

// Tipo de alarma (dentro de "Gestionar Códigos")
document.querySelectorAll('input[name="alarmMode"]').forEach(radio => {

  radio.checked = radio.value === getAlarmMode();

  radio.addEventListener('change', () => {
    if (radio.checked) {
      setAlarmMode(radio.value);
    }
  });
});

const testAlarmBtn = document.getElementById('testAlarmBtn');

if (testAlarmBtn) {
  testAlarmBtn.addEventListener('click', () => {

    unlockMedia();

    if (getAlarmMode() === 'individual') {
      speakAlarm(
        '',
        'up',
        'Se ha detectado un aumento de 1500 litros por segundo en Obra de Toma'
      );
    } else {
      beep();
    }
  });
}

// Algunos navegadores cargan las voces de forma diferida.
if ('speechSynthesis' in window) {
  speechSynthesis.onvoiceschanged = () => {};
}

if (hourChips) {
  hourChips.addEventListener('click', event => {

    const btn = event.target.closest('button[data-h]');

    if (!btn) {
      return;
    }

    timeRangeSelect.value = btn.dataset.h;

    timeRangeSelect.dispatchEvent(new Event('change'));
  });
}

if (refreshBtnTop) {
  refreshBtnTop.addEventListener('click', () => {
    if (refreshBtn) {
      refreshBtn.click();
    }
  });
}

if (applyRangeBtn) {
  applyRangeBtn.addEventListener('click', applyCustomRange);
}

// ============================================================
// MAXIMIZAR HISTORIAL
// ============================================================

if (
  maximizeHistoryBtn
) {

  maximizeHistoryBtn.addEventListener(
    'click',
    () => {

      historyModal.classList.toggle(
        'maximized'
      );


      if (
        historyModal.classList.contains(
          'maximized'
        )
      ) {

        maximizeHistoryBtn.innerHTML =
          '&#9744;';


        maximizeHistoryBtn.title =
          "Restaurar tamaño";

      }

      else {

        maximizeHistoryBtn.innerHTML =
          '&#9974;';


        maximizeHistoryBtn.title =
          "Maximizar";
      }


      if (currentChart) {
        currentChart.resize();
      }
    }
  );
}


// ============================================================
// CERRAR HISTORIAL
// ============================================================

function closeHistory() {

  closeChartFullscreen();

  // Descarta respuestas pendientes y los datos leídos de la hoja.
  historyRequestId++;

  currentHistoryRows =
    [];


  historyModal.classList.remove(
    'active'
  );


  historyModal.classList.remove(
    'maximized'
  );


  if (
    maximizeHistoryBtn
  ) {

    maximizeHistoryBtn.innerHTML =
      '&#9974;';
  }


  if (currentChart) {

    currentChart.destroy();

    currentChart =
      null;
  }
}


if (
  closeHistoryModal
) {

  closeHistoryModal.addEventListener(
    'click',
    closeHistory
  );
}


if (
  closeHistoryModalFooter
) {

  closeHistoryModalFooter.addEventListener(
    'click',
    closeHistory
  );
}


// ============================================================
// VISIBILITY CHANGE
// ============================================================

document.addEventListener(
  'visibilitychange',
  async () => {

    if (!document.hidden) {

      console.log(
        'Pestaña activa - actualizando datos...'
      );


      try {

        await loadAllCodes();


        Object.keys(
          alarmStates
        ).forEach(
          code => {

            if (
              alarmStates[code]?.active
            ) {

              playBeepSequence();
            }
          }
        );

      }

      catch (error) {

        console.error(
          'Error al actualizar datos:',
          error
        );
      }
    }
  }
);


// ============================================================
// PANEL LATERAL COLAPSABLE
// ============================================================

function setPanelCollapsed(collapsed) {

  if (!sidePanel || !panelToggle) {
    return;
  }

  sidePanel.classList.toggle(
    'collapsed',
    collapsed
  );

  document.body.classList.toggle(
    'panel-open',
    !collapsed
  );

  // Abierto: ▶ (ocultar hacia la derecha)
  // Colapsado: ◀ (mostrar)
  panelToggle.textContent =
    collapsed
      ? '◀'
      : '▶';

  panelToggle.setAttribute(
    'aria-expanded',
    String(!collapsed)
  );

  try {

    localStorage.setItem(
      'vicaria_panel_collapsed',
      collapsed
        ? '1'
        : '0'
    );

  } catch (error) {
    // Sin almacenamiento: se ignora.
  }
}


(function initSidePanel() {

  if (!sidePanel || !panelToggle) {
    return;
  }

  let stored = null;

  try {

    stored =
      localStorage.getItem(
        'vicaria_panel_collapsed'
      );

  } catch (error) {
    stored = null;
  }

  // Sin preferencia guardada: abierto en escritorio,
  // colapsado en pantallas chicas.
  const collapsed =
    stored === null
      ? window.matchMedia(
          '(max-width: 768px)'
        ).matches
      : stored === '1';

  setPanelCollapsed(collapsed);

  panelToggle.addEventListener(
    'click',
    () =>
      setPanelCollapsed(
        !sidePanel.classList.contains(
          'collapsed'
        )
      )
  );

})();


// ============================================================
// BUSCADOR DEL MODAL
// ============================================================

if (
  modalSearch
) {

  modalSearch.addEventListener(
    'input',
    () => {

      const searchTerm =
        modalSearch.value
          .toLowerCase()
          .trim();


      document
        .querySelectorAll(
          '.code-item'
        )
        .forEach(
          item => {

            const code =
              String(
                item.dataset.code ||
                ''
              ).toLowerCase();


            const name =
              String(
                item.dataset.name ||
                ''
              );


            if (
              code.includes(
                searchTerm
              ) ||
              name.includes(
                searchTerm
              )
            ) {

              item.classList.remove(
                'hidden'
              );

            }

            else {

              item.classList.add(
                'hidden'
              );
            }
          }
        );
    }
  );
}


// ============================================================
// FILTROS
// ============================================================

document
  .querySelectorAll(
    '.filter-btn'
  )
  .forEach(
    btn => {

      btn.addEventListener(
        'click',
        () => {

          document
            .querySelectorAll(
              '.filter-btn'
            )
            .forEach(
              b =>
                b.classList.remove(
                  'active'
                )
            );


          btn.classList.add(
            'active'
          );


          currentFilter =
            btn.dataset.filter;


          renderCards();
        }
      );
    }
  );


// ============================================================
// GESTIONAR CÓDIGOS
// ============================================================

if (
  manageBtn
) {

  manageBtn.addEventListener(
    'click',
    () => {

      selectorModal.classList.add(
        'active'
      );


      modalSearch.value =
        '';


      renderCodeList();
    }
  );
}


// ============================================================
// CERRAR MODAL DE SELECCIÓN
// ============================================================

if (
  closeModal
) {

  closeModal.addEventListener(
    'click',
    () =>
      selectorModal.classList.remove(
        'active'
      )
  );
}


if (
  saveSelection
) {

  saveSelection.addEventListener(
    'click',
    () => {

      selectorModal.classList.remove(
        'active'
      );


      renderCards();
    }
  );
}


if (
  selectorModal
) {

  selectorModal.addEventListener(
    'click',
    event => {

      if (
        event.target ===
        selectorModal
      ) {

        selectorModal.classList.remove(
          'active'
        );
      }
    }
  );
}


// ============================================================
// BOTÓN ACTUALIZAR
// ============================================================

if (
  refreshBtn
) {

  refreshBtn.addEventListener(
    'click',
    async () => {

      refreshBtn.textContent =
        '⏳';


      refreshBtn.disabled =
        true;


      try {

        await loadAllCodes();


        refreshBtn.textContent =
          '✔';


        setTimeout(
          () => {

            refreshBtn.textContent =
              '🔄';

          },
          2000
        );

      }

      catch (error) {

        console.error(
          error
        );


        refreshBtn.textContent =
          '❌';


        setTimeout(
          () => {

            refreshBtn.textContent =
              '🔄';

          },
          2000
        );
      }


      refreshBtn.disabled =
        false;
    }
  );
}


// ============================================================
// AJUSTE DE ÚLTIMA FILA
// ============================================================

function adjustLastRowStretch() {

  const grid =
    document.querySelector(
      '.cards-grid'
    );


  if (!grid) {
    return;
  }


  const computed =
    getComputedStyle(
      grid
    ).gridTemplateColumns;


  if (!computed) {
    return;
  }


  const cols =
    computed
      .split(' ')
      .filter(Boolean)
      .length;


  if (
    !cols ||
    cols <= 1
  ) {

    grid
      .querySelectorAll(
        '.card'
      )
      .forEach(
        card =>
          card.style.gridColumn =
            ''
      );


    return;
  }


  const cards =
    Array.from(
      grid.querySelectorAll(
        ':scope > .card'
      )
    );


  cards.forEach(
    card =>
      card.style.gridColumn =
        ''
  );
}


// ============================================================
// INICIALIZACIÓN
// ============================================================

(async () => {

  await loadAllCodes();


  updateIntervalId =
    setInterval(
      async () => {

        try {

          await loadAllCodes();

        }

        catch (error) {

          console.error(
            'Error en actualización automática:',
            error
          );
        }

      },
      UPDATE_INTERVAL
    );

})();


// ----- FIN vicaria.js -----