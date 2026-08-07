// sw.js — TENKO！ 用の最小限のサービスワーカー
// アプリの「見た目（HTML/CSS/JS/アイコン）」だけをオフラインキャッシュします。
// 出欠データそのものはFirestore（オンライン専用）から取得するため、
// このキャッシュ対象には含めていません。

const CACHE_NAME = 'tenko-shell-v1';
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './firebase-config.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// アプリの殻（HTML/CSS/JS/アイコン）はキャッシュ優先。
// Firestore通信やCDN（xlsxライブラリ等）はネットワークにそのまま任せる。
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isSameOrigin = url.origin === self.location.origin;
  if (!isSameOrigin) return; // Firestore/CDNはSWを介さない

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
        return res;
      }).catch(() => cached);
    })
  );
});
