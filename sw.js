const CACHE_NAME = 'lere-shell-v32';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png'
];

function openLibraryDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('pulsedeck-library', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getStoredTrack(id) {
  const db = await openLibraryDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('tracks').objectStore('tracks').get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function serveLocalAudio(request, id) {
  const record = await getStoredTrack(id);
  const file = record?.file;
  if (!file) return new Response('Track not found', { status: 404 });

  const type = file.type || 'audio/mpeg';
  const commonHeaders = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Type': type
  };
  const range = request.headers.get('Range');
  if (!range) {
    return new Response(file, { status: 200, headers: { ...commonHeaders, 'Content-Length': String(file.size) } });
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${file.size}` } });
  let start;
  let end;
  if (match[1] === '') {
    const suffixLength = Number(match[2]);
    if (!suffixLength) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${file.size}` } });
    start = Math.max(0, file.size - suffixLength);
    end = file.size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? file.size - 1 : Math.min(Number(match[2]), file.size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= file.size) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${file.size}` } });
  }
  const chunk = file.slice(start, end + 1, type);
  return new Response(chunk, {
    status: 206,
    headers: {
      ...commonHeaders,
      'Content-Length': String(chunk.size),
      'Content-Range': `bytes ${start}-${end}/${file.size}`
    }
  });
}

async function cacheValidResponse(cache, request, response) {
  if (response && response.ok && response.type !== 'opaque') await cache.put(request, response.clone());
  return response;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(APP_SHELL.map(path => cache.add(new Request(path, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)));
    if ('navigationPreload' in self.registration) await self.registration.navigationPreload.enable();
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  const audioMarker = '/__lere_audio__/';
  const markerIndex = url.pathname.lastIndexOf(audioMarker);
  if (request.method === 'GET' && url.origin === self.location.origin && markerIndex >= 0) {
    const id = decodeURIComponent(url.pathname.slice(markerIndex + audioMarker.length));
    event.respondWith(serveLocalAudio(request, id).catch(() => new Response('Audio unavailable', { status: 503 })));
    return;
  }
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = (await event.preloadResponse) || await fetch(request);
        if (!response.ok) throw new Error('Navigation failed');
        await cacheValidResponse(cache, './index.html', response);
        return response;
      } catch (_) {
        return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) {
      event.waitUntil(fetch(request).then(response => cacheValidResponse(cache, request, response)).catch(() => {}));
      return cached;
    }
    try {
      const response = await fetch(request);
      if (!response.ok) throw new Error('Asset failed');
      return await cacheValidResponse(cache, request, response);
    } catch (_) {
      return Response.error();
    }
  })());
});
