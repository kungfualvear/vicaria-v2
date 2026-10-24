// service-worker.js - Optimized for ViCaRiA PWA
const CACHE_VERSION = 'v8.5.1'; // Increment this on each deploy (or use a build hash)
const PRECACHE = `vicaria-precache-${CACHE_VERSION}`;
const RUNTIME = `vicaria-runtime-${CACHE_VERSION}`;

const PRECACHE_ASSETS = [
  '/', // start_url
  '/index.html',
  '/vicaria.css',
  '/vicaria.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
  "/manual.html",

];

// Time (ms) after which network requests fallback to cache if slow (optional)
const NETWORK_TIMEOUT = 6000;

// Helpers
async function cleanOldCaches() {
  const keys = await caches.keys();
  return Promise.all(
    keys
      .filter(key => key !== PRECACHE && key !== RUNTIME)
      .map(key => caches.delete(key))
  );
}

self.addEventListener('install', (event) => {
  // Immediately take control of the page after activation
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE);
      try {
        await cache.addAll(PRECACHE_ASSETS);
      } catch (err) {
        // fallback: try to add one-by-one to avoid failing the whole install
        for (const asset of PRECACHE_ASSETS) {
          try { await cache.add(asset); } catch (e) { console.warn('Precahce fail', asset, e); }
        }
      }
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Enable navigation preload if available
      if ('navigationPreload' in self.registration) {
        try { await self.registration.navigationPreload.enable(); } catch (e) { /* ignore */ }
      }

      // Clean old caches
      await cleanOldCaches();

      // Claim clients so the SW starts controlling pages ASAP
      await self.clients.claim();

      // Force open clients to navigate to their url so they load the newest content
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        try {
          // Some browsers may throw on navigate for external origins - guard with try/catch
          client.navigate(client.url);
        } catch (e) {
          // ignore
        }
      }
    })()
  );
});

// Strategy functions
async function networkFirst(request) {
  const cache = await caches.open(RUNTIME);
  try {
    // Use navigationPreloadResponse if available (faster)
    const preloadResp = await eventPreloadResponse();
    if (preloadResp) {
      cache.put(request, preloadResp.clone()).catch(() => {});
      return preloadResp;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), NETWORK_TIMEOUT);

    const response = await fetch(request, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (response && response.ok) {
      cache.put(request, response.clone()).catch(() => {});
      return response;
    }
    throw new Error('Network response not ok');
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    // fallback to precache (useful for navigation)
    const pre = await caches.open(PRECACHE);
    const fallback = await pre.match('/index.html');
    return fallback || Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(RUNTIME);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone()).catch(() => {});
      return response;
    }
    throw new Error('Network fail');
  } catch (e) {
    // fallback to precache
    const pre = await caches.open(PRECACHE);
    return await pre.match('/index.html') || Response.error();
  }
}

// Utility to access event.preloadResponse inside strategy
async function eventPreloadResponse() {
  // This function will be replaced per-fetch with the event-specific preload call.
  return null;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Bypass non-GET requests
  if (request.method !== 'GET') return;

  // Attach event-specific preloadResponse accessor
  eventPreloadResponse = async () => {
    try {
      return await event.preloadResponse;
    } catch (e) {
      return null;
    }
  };

  const dest = request.destination || (request.mode === 'navigate' ? 'document' : '');

  // Navigation requests (HTML) -> network-first
  if (request.mode === 'navigate' || dest === 'document') {
    event.respondWith(networkFirst(request));
    return;
  }

  // JS / CSS -> network-first (to keep code fresh)
  if (dest === 'script' || dest === 'style') {
    event.respondWith(networkFirst(request));
    return;
  }

  // Images & icons -> cache-first (fast)
  if (dest === 'image' || request.url.includes('/icons/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Fonts -> cache-first
  if (dest === 'font') {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Default -> stale-while-revalidate: return cache if present and update in background
  event.respondWith((async () => {
    const cache = await caches.open(RUNTIME);
    const cached = await cache.match(request);
    const fetchPromise = fetch(request).then((resp) => {
      if (resp && resp.ok) cache.put(request, resp.clone()).catch(() => {});
      return resp;
    }).catch(() => null);

    return cached || (await fetchPromise) || (await caches.open(PRECACHE).then(c => c.match('/index.html')));
  })());
});

// Listen for skipWaiting message from client (manual trigger)
self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Optional: provide a simple health check endpoint (for debugging)
self.addEventListener('sync', (event) => {
  // placeholder for background sync tasks if needed
});

// End of service-worker.js
