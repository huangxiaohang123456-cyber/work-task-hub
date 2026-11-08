/* 工作任务台 · Service Worker
 * 导航与静态资源均「网络优先」，离线才回退缓存 —— 保证每次部署后
 * 手机端（PWA）都能拿到最新代码，不再被旧缓存卡成白屏。
 * 缓存版本号随大改递增；即便不改版本，网络优先策略也会自动刷新。
 */
const CACHE = 'wtb-v7';
const SHELL = ['./', './index.html', './assets/styles.css', './assets/app.js', './assets/config.js', './assets/icon.svg', './manifest.webmanifest'];

self.addEventListener('install', (e) => {
  // 容错安装：逐个缓存，单个资源失败不连累整段
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.allSettled(SHELL.map((u) =>
      fetch(u).then((r) => { if (r.ok) return c.put(u, r); }).catch(() => {})
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  // 清掉所有旧缓存（含上一版本），避免旧 app.js 残留导致新旧不匹配
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => { if (k !== CACHE) return caches.delete(k); })))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const cp = res.clone();
      caches.open(CACHE).then((c) => c.put(req, cp)).catch(() => {});
      return res;
    }
  } catch (e) { /* 离线或网络失败，回退缓存 */ }
  return caches.match(req).then((h) => h || (req.mode === 'navigate' ? caches.match('./index.html') : null));
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  e.respondWith(networkFirst(e.request));
});
