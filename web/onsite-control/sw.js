const cacheName = 'escape-room-offline-v2';
const files = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest'];
self.addEventListener('install', event => event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(files))));
self.addEventListener('fetch', event => event.respondWith(caches.match(event.request).then(found => found || fetch(event.request))));
