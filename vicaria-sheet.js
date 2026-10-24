// ----- INICIO vicaria-sheet.js -----
// ViCaRiA - Lectura del historial desde Google Sheets
//
// La hoja es pública ("cualquier persona con el enlace puede ver") y se lee
// con el endpoint de consulta de Google (gviz) en formato JSONP, por lo que
// funciona también abriendo la app como archivo local (file://).
// Nada de lo que se lee se guarda en el navegador: los datos viven solo
// en memoria.
//
// Funciones globales que usa vicaria.js:
//
//   hasSheetHistory(code)          -> true si el código tiene columnas en la hoja
//   fetchSheetHistory(hours)       -> Promise<{ [code]: [{timestamp, caudal, altura}] }>
//
// ------------------------------------------------------------


// ============================================================
// CONFIGURACIÓN
// ============================================================

const SHEET_ID  = '1dE_sSqswXISVZrbjOb9Vcp059m3PsV3DTMVNLe3beUo';
const SHEET_GID = '2053163096';

// La hoja guarda las fechas en hora de Argentina (GMT-3, sin horario de verano).
const SHEET_UTC_OFFSET_MS = -3 * 60 * 60 * 1000;

/*
 * Código de la app -> nombre de la ubicación tal como aparece en los
 * encabezados de la hoja.
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
  '8021': 'La olla'
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
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '');
}


/**
 * Convierte el valor de una celda numérica.
 *
 * Acepta números y textos con coma decimal ("135,56").
 * Cualquier otra cosa (por ejemplo "1900-5") se considera dato faltante.
 */
function sheetNumber(cell) {

  if (!cell) {
    return null;
  }

  const v = cell.v;

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
 * Convierte la celda de fecha a timestamp (ms, UTC).
 *
 * Soporta:
 *   - "Date(2026,8,15,9,39,39)"  (gviz; el mes empieza en 0)
 *   - "15/09/2026 9:39:39"       (texto)
 */
function sheetTimestamp(cell) {

  if (!cell || cell.v === null || cell.v === undefined) {
    return null;
  }

  let y, mo, d, h = 0, mi = 0, s = 0;

  const v = cell.v;

  if (typeof v === 'string') {

    let m = v.match(
      /^Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?/
    );

    if (m) {

      y  = +m[1];
      mo = +m[2];
      d  = +m[3];
      h  = +(m[4] || 0);
      mi = +(m[5] || 0);
      s  = +(m[6] || 0);

    } else {

      m = v.trim().match(
        /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
      );

      if (!m) {
        return null;
      }

      d  = +m[1];
      mo = +m[2] - 1;
      y  = +m[3];
      h  = +(m[4] || 0);
      mi = +(m[5] || 0);
      s  = +(m[6] || 0);
    }

  } else {

    return null;
  }

  // Hora de la hoja (GMT-3) -> UTC
  return Date.UTC(y, mo, d, h, mi, s) - SHEET_UTC_OFFSET_MS;
}


/**
 * Texto 'yyyy-MM-dd HH:mm:ss' en hora de la hoja (GMT-3)
 * para usar en el filtro de la consulta.
 */
function sheetWallClock(timestamp) {

  const d = new Date(timestamp + SHEET_UTC_OFFSET_MS);

  const p = n => String(n).padStart(2, '0');

  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}


// ============================================================
// CONSULTA A LA HOJA
// ============================================================

const SHEET_TIMEOUT_MS = 20 * 1000;

/**
 * Pide la hoja a gviz y devuelve la tabla ya decodificada.
 * Si se pasa `query`, el filtrado se hace en el servidor.
 *
 * Se usa el formato JSONP de gviz (la respuesta se carga como <script>
 * y llama a una función nuestra) en lugar de fetch(): Google no envía
 * cabeceras CORS en este endpoint, y fetch() fallaría al abrir la app
 * como archivo local (file://) o desde otro dominio.
 */
function sheetRequest(query) {

  return new Promise(
    (resolve, reject) => {

      const callbackName =
        `vicariaSheetCallback_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

      const script =
        document.createElement('script');

      let finished = false;

      let timer = null;


      const cleanup = () => {

        finished = true;

        clearTimeout(timer);

        try {
          delete window[callbackName];
        } catch (error) {
          window[callbackName] = undefined;
        }

        if (script.parentNode) {
          script.parentNode.removeChild(script);
        }
      };


      window[callbackName] = json => {

        if (finished) {
          return;
        }

        cleanup();

        if (
          !json ||
          json.status !== 'ok' ||
          !json.table
        ) {

          const detail =
            json?.errors?.[0]?.detailed_message ||
            json?.errors?.[0]?.message ||
            'consulta rechazada';

          reject(
            new Error(`Google Sheets: ${detail}`)
          );

          return;
        }

        resolve(json.table);
      };


      script.onerror = () => {

        if (finished) {
          return;
        }

        cleanup();

        reject(
          new Error(
            'no se pudo leer la hoja (revisá la conexión y que esté compartida como "cualquier persona con el enlace puede ver")'
          )
        );
      };


      timer = setTimeout(
        () => {

          if (finished) {
            return;
          }

          cleanup();

          reject(
            new Error('Google Sheets tardó demasiado en responder')
          );
        },
        SHEET_TIMEOUT_MS
      );


      let url =
        `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq` +
        `?gid=${SHEET_GID}&headers=1` +
        `&tqx=out:json;responseHandler:${callbackName}`;

      if (query) {
        url += `&tq=${encodeURIComponent(query)}`;
      }

      // Evita respuestas en caché
      url += `&_=${Date.now()}`;


      script.src = url;

      document.head.appendChild(script);
    }
  );
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

  let table;

  try {

    // Filtro en el servidor (lo normal: la columna A es fecha/hora).
    table = await sheetRequest(
      `select * where A >= datetime '${sheetWallClock(since)}' order by A`
    );

  } catch (error) {

    // Respaldo: bajar todo y filtrar acá (por si la columna A es texto).
    console.warn(
      'ViCaRiA: consulta filtrada falló, se descarga la hoja completa.',
      error
    );

    table = await sheetRequest(null);
  }

  const cols = table.cols || [];

  // Índices de columnas por código
  const indexes = {};

  Object.entries(SHEET_SOURCES).forEach(
    ([code, place]) => {

      const prefix = sheetNormalize(place);

      const caudalIdx = cols.findIndex(
        c => sheetNormalize(c.label).startsWith(`${prefix}-caudal`)
      );

      const alturaIdx = cols.findIndex(
        c => sheetNormalize(c.label).startsWith(`${prefix}-altura`)
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

  (table.rows || []).forEach(
    row => {

      const cells = row.c || [];

      const timestamp = sheetTimestamp(cells[0]);

      if (timestamp === null || timestamp < since) {
        return;
      }

      Object.entries(indexes).forEach(
        ([code, { caudalIdx, alturaIdx }]) => {

          result[code].push({

            timestamp,

            caudal:
              caudalIdx === -1
                ? null
                : sheetNumber(cells[caudalIdx]),

            altura:
              alturaIdx === -1
                ? null
                : sheetNumber(cells[alturaIdx])
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
