// Service Worker: macht 3D Studio offline-fähig (App-Shell wird zwischengespeichert).
// Bei jeder Änderung an App-Dateien VERSION erhöhen.
const VERSION = 'v1.4.0';
const CACHE = `3d-studio-${VERSION}`;
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/models.js',
  './js/spider.js',
  './js/animator.js',
  './js/rig-registry.js',
  './js/rigkit.js',
  './js/characters.js',
  './js/ghost.js',
  './js/storage.js',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './vendor/three/build/three.module.min.js',
  './vendor/three/build/three.core.min.js',
  './vendor/three/examples/jsm/controls/OrbitControls.js',
  './vendor/three/examples/jsm/environments/RoomEnvironment.js',
  './vendor/three/examples/jsm/loaders/GLTFLoader.js',
  './vendor/three/examples/jsm/loaders/OBJLoader.js',
  './vendor/three/examples/jsm/loaders/STLLoader.js',
  './vendor/three/examples/jsm/utils/BufferGeometryUtils.js',
  './vendor/three/examples/jsm/exporters/GLTFExporter.js',
  './vendor/three/examples/jsm/exporters/STLExporter.js',
  './vendor/three/examples/jsm/exporters/OBJExporter.js',
  './vendor/three/examples/jsm/exporters/USDZExporter.js',
  './vendor/three/examples/jsm/libs/fflate.module.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('3d-studio-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // externe Modelle nicht cachen

  // Seite: zuerst Netzwerk (Updates), offline aus dem Cache
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put('./index.html', copy));
        return res;
      }).catch(() => caches.match('./index.html', { ignoreSearch: true })),
    );
    return;
  }

  // Dateien: Cache zuerst, sonst Netzwerk (und für später speichern)
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    })),
  );
});
