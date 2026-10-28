// ----- INICIO vicaria-sheet.js -----
// ViCaRiA - Lectura del historial desde Google Sheets
//
// La hoja es PRIVADA. Se lee a través de un Apps Script publicado como
// aplicación web ("Ejecutar como: Yo" / "Acceso: Cualquier usuario"), que
// corre con los permisos del dueño de la hoja y devuelve JSON:
//
//   { encabezados: [...], filas: [[fechaISO, caudal1, altura1, ...], ...] }
//
// Nada de lo que se lee se guarda en el navegador: los datos viven solo
// en memoria.
//
// Funciones globales que usa vicaria.js:
//
//   hasSheetHistory(code)          -> true si el código tiene columnas en la hoja
//   fetchSheetHistory(hours)       -> Promise<{ [code]: [{timestamp, caudal, altura}] }>
//   fetchSheetHistoryRange(ini,fin)-> igual, para un rango de fechas (ms epoch)
//
// ------------------------------------------------------------


// ============================================================
// CONFIGURACIÓN
// ============================================================

// URL de la implementación del Apps Script (termina en /exec).
const SHEET_SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbwe6uoYu5invwK2q0mVmoZ3ErQSbem1C15-Q2vkmK2aYxmjkT25HMElil8heoj-dz_s/exec';

const SHEET_TIMEOUT_MS = 20 * 1000;

/*
 * Código de la app -> nombre de la ubicación tal como aparece en los
 * encabezados de la hoja (deben coincidir con ESTACIONES del Apps Script).
 *
 * Encabezados esperados:
 *   "<Ubicación> - Caudal (l/s)"
 *   "<Ubicación> - Altura (cm)"
 */
const SHEET_SOURCES = {
  '8007': 'Escorial',
  '8019': 'Malvinas',
  '8022': 'Obra de toma',
  '8063': 'Izuel 1',
  '8084': 'Unificado',
  '8005': 'Real del Padre (Matriz)',
  '8006': 'Real del Padre (Bifanni)',
  '8000': '8000',
  '8021': 'La olla',

  '8068': 'Nihuil IV',
  '8008': 'Arroyo',
  '8018': 'Correa',
  '8017': 'Regueira',
  '8016': 'Babacci',
  '8062': 'Perrone',
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


// ============================================================
// UTILIDADES
// ============================================================

function hasSheetHistory(code) {

  return Object.prototype.hasOwnProperty.call(
    SHEET_SOURCES,
    String(code).trim()
  );
}


/**
 * Normaliza un encabezado para compararlo:
 * minúsculas, sin acentos y sin espacios.
 */
function sheetNormalize(text) {

  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '');
}


/**
 * Convierte el valor de una celda numérica.
 *
 * Acepta números y textos con coma decimal ("135,56").
 * Vacío u otro texto (por ejemplo "1900-5") = dato faltante.
 */
function sheetNumber(v) {

  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : null;
  }

  if (typeof v === 'string') {

    const text = v.trim();

    if (/^-?\d+([.,]\d+)?$/.test(text)) {

      const n = parseFloat(text.replace(',', '.'));

      return Number.isFinite(n) ? n : null;
    }
  }

  return null;
}


/**
 * Convierte la fecha de la primera columna a timestamp (ms, UTC).
 * El Apps Script la envía como ISO 8601 con "Z" (toISOString),
 * por lo que no hace falta ningún ajuste de zona horaria.
 */
function sheetTimestamp(v) {

  if (v === null || v === undefined || v === '') {
    return null;
  }

  const t = new Date(v).getTime();

  return Number.isFinite(t) ? t : null;
}


// ============================================================
// CONSULTA AL APPS SCRIPT
// ============================================================

/**
 * Pide al Apps Script las filas de las últimas `hours` horas.
 * Devuelve { encabezados, filas }.
 *
 * Se usa un fetch simple (sin cabeceras personalizadas) para evitar
 * preflight CORS, que los Apps Script no soportan.
 */
async function sheetRequest(params) {

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    SHEET_TIMEOUT_MS
  );

  try {

    const query = Object.entries(params || {})
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');

    const url = `${SHEET_SCRIPT_URL}?${query}&_=${Date.now()}`;

    const res = await fetch(
      url,
      { signal: controller.signal, cache: 'no-store' }
    );

    if (!res.ok) {
      throw new Error(`Apps Script respondió ${res.status}`);
    }

    let json;

    try {
      json = await res.json();
    } catch (error) {
      throw new Error(
        'el Apps Script no devolvió JSON (revisá que la implementación sea "Cualquier usuario")'
      );
    }

    if (json && json.error) {
      throw new Error(`Apps Script: ${json.error}`);
    }

    if (
      !json ||
      !Array.isArray(json.encabezados) ||
      !Array.isArray(json.filas)
    ) {
      throw new Error('respuesta del Apps Script con formato inesperado');
    }

    return json;

  } catch (error) {

    if (error.name === 'AbortError') {
      throw new Error('el Apps Script tardó demasiado en responder');
    }

    throw error;

  } finally {

    clearTimeout(timer);
  }
}


/**
 * Obtiene las filas de las últimas `hours` horas.
 *
 * Devuelve:
 *   { [code]: [{ timestamp, caudal, altura }, ...] }   (orden cronológico)
 *
 * Los datos NO se guardan: cada llamada vuelve a consultar la hoja.
 */
async function fetchSheetHistory(hours) {

  const since = Date.now() - hours * 60 * 60 * 1000;

  const json = await sheetRequest({ horas: hours });

  return sheetBuildHistory(json, since, Infinity);
}


/**
 * Igual que fetchSheetHistory pero para un rango de fechas.
 * startMs / endMs: milisegundos epoch (hora local del navegador ya resuelta).
 */
async function fetchSheetHistoryRange(startMs, endMs) {

  const json = await sheetRequest({
    desde: new Date(startMs).toISOString(),
    hasta: new Date(endMs).toISOString()
  });

  // Un Apps Script viejo ignora desde/hasta y devolvería las últimas 3 h.
  if (!json.rango) {
    throw new Error(
      'el Apps Script instalado no soporta rangos de fechas: pegá la versión nueva y publicá una nueva versión de la implementación'
    );
  }

  return sheetBuildHistory(json, startMs, endMs);
}


function sheetBuildHistory(json, since, until) {

  const { encabezados, filas } = json;

  // Índices de columnas por código
  const indexes = {};

  Object.entries(SHEET_SOURCES).forEach(
    ([code, place]) => {

      const prefix = sheetNormalize(place);

      const caudalIdx = encabezados.findIndex(
        h => sheetNormalize(h).startsWith(`${prefix}-caudal`)
      );

      const alturaIdx = encabezados.findIndex(
        h => sheetNormalize(h).startsWith(`${prefix}-altura`)
      );

      if (caudalIdx === -1 && alturaIdx === -1) {

        console.warn(
          `ViCaRiA: no se encontraron columnas para "${place}" (código ${code}) en la hoja.`
        );

        return;
      }

      indexes[code] = { caudalIdx, alturaIdx };
    }
  );

  const result = {};

  Object.keys(indexes).forEach(
    code => {
      result[code] = [];
    }
  );

  filas.forEach(
    row => {

      const timestamp = sheetTimestamp(row[0]);

      if (timestamp === null || timestamp < since || timestamp > until) {
        return;
      }

      Object.entries(indexes).forEach(
        ([code, { caudalIdx, alturaIdx }]) => {

          result[code].push({

            timestamp,

            caudal:
              caudalIdx === -1
                ? null
                : sheetNumber(row[caudalIdx]),

            altura:
              alturaIdx === -1
                ? null
                : sheetNumber(row[alturaIdx]),

            // vicaria.js usa alturaAN1 para el código 8098 (la hoja ya
            // guarda ahí la Altura AN1 de esa estación).
            alturaAN1:
              alturaIdx === -1
                ? null
                : sheetNumber(row[alturaIdx])
          });
        }
      );
    }
  );

  Object.values(result).forEach(
    list => list.sort(
      (a, b) => a.timestamp - b.timestamp
    )
  );

  return result;
}

// ----- FIN vicaria-sheet.js -----
