/* 工作任务台 · Service Worker（导航走网络优先，避免部署后被旧缓存卡住） */
const CACHE = 'wtb-v2';
const SHELL = ['./', './index.html', './assets/styles.css', './assets/app.js', './assets/config.js', './assets/icon.svg', './manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  // 删除所有旧缓存（含上一版本的），保证部署后旧资源不残留
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;

  // 导航请求（HTML 页面）：网络优先，离线才回退缓存 → 部署后立刻生效，不被旧缓存卡住
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const cp = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, cp));
          return res;
        })
        .catch(() => caches.match(e.request).then((h) => h || caches.match('./index.html')))
    );
    return;
  }

  // 其他静态资源：缓存优先
  e.respondWith(
    caches.match(e.request).then((hit) => hit ||
      fetch(e.request).then((res) => {
        const cp = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, cp));
        return res;
      }).catch(() => hit)
    )
  );
});
