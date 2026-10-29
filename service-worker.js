// service-worker.js - ViCaRiA PWA
//
// Qué se guarda en caché y qué NO:
//  - SÍ: la "carcasa" de la web (HTML, CSS, JS, iconos, fuentes, librerías) para que abra rápido
//    y funcione la interfaz sin conexión.
//  - NO: los datos en vivo (API de Irrigación y Apps Script). Esas peticiones se dejan pasar
//    directo a la red, para no mostrar nunca caudales viejos.
//
// Todas las rutas son relativas: funciona igual en la raíz del dominio o en una subcarpeta.

const CACHE_VERSION = 'v9.0.4'; // Cambiar en cada publicación
const PRECACHE = `vicaria-precache-${CACHE_VERSION}`;
const RUNTIME = `vicaria-runtime-${CACHE_VERSION}`;

const PRECACHE_ASSETS = [
  './',
  './index.html',
  './vicaria.css',
  './vicaria.js',
  './vicaria-sheet.js',
  './manual.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// Si la red tarda más que esto, se usa lo guardado (ms)
const NETWORK_TIMEOUT = 6000;

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(PRECACHE);
    try {
      await cache.addAll(PRECACHE_ASSETS);
    } catch (err) {
      // Si falta algún archivo, no se cae toda la instalación
      for (const asset of PRECACHE_ASSETS) {
        try { await cache.add(asset); } catch (e) { console.warn('Precache falló:', asset); }
      }
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k !== PRECACHE && k !== RUNTIME).map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

function isCacheable(response) {
  return response && (response.ok || response.type === 'opaque');
}

// HTML, JS y CSS: primero la red (código siempre fresco); si falla o tarda, lo guardado.
async function networkFirst(request) {
  const cache = await caches.open(RUNTIME);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT);

  try {
    const response = await fetch(request, { signal: controller.signal });
    clearTimeout(timer);
    if (isCacheable(response)) {
      cache.put(request, response.clone()).catch(() => {});
      return response;
    }
    throw new Error('Respuesta no válida');
  } catch (err) {
    clearTimeout(timer);
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const fallback = await caches.match('./index.html');
      if (fallback) return fallback;
    }
    return Response.error();
  }
}

// Iconos y fuentes: primero lo guardado.
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (isCacheable(response)) {
      const cache = await caches.open(RUNTIME);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (err) {
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') return;

  const dest = request.destination;
  const isNavigation = request.mode === 'navigate';

  // fetch()/XHR (datos en vivo) tienen destination vacío: no se interceptan.
  if (!isNavigation && !['script', 'style', 'font', 'image'].includes(dest)) return;

  if (isNavigation || dest === 'script' || dest === 'style') {
    event.respondWith(networkFirst(request));
  } else {
    event.respondWith(cacheFirst(request));
  }
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
