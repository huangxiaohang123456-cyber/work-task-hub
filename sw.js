/* 工作任务台 · 极简 Service Worker（应用壳缓存，便于“添加到主屏幕”离线打开） */
const CACHE = 'wtb-v1';
const SHELL = ['./', './index.html', './assets/styles.css', './assets/app.js', './assets/config.js', './assets/icon.svg', './manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // 仅缓存同源静态资源；Supabase / CDN / PushPlus 走网络
  if (url.origin === location.origin && e.request.method === 'GET') {
    e.respondWith(
      caches.match(e.request).then((hit) => hit ||
        fetch(e.request).then((res) => {
          const cp = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, cp));
          return res;
        }).catch(() => hit)
      )
    );
  }
});
