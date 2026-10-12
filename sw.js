/* ============================================================
   待会吃什么 · Service Worker
   改代码后请把下面的 CACHE 版本号 +1，已安装用户才会拿到新版
   ============================================================ */
const CACHE = 'chishenme-v9';

// 这些是"代码/数据"，必须优先走网络：
// 用 stale-while-revalidate 的话，改完代码第一次打开还是旧的（要让用户刷两次），
// 看起来就像"修复没生效"。网络失败时再退回缓存，离线照样能用。
const FRESH_FIRST = /\.(?:js|css|json)$/i;

const ASSETS = [
  './',
  './index.html',
  './style.css',
  './core.js',
  './sync.js',
  './app.js',
  './manifest.json',
  './data/ingredients.json',
  './data/recipes.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
      .catch((err) => console.warn('[sw] 预缓存部分失败', err))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // 只处理同源请求；GitHub API 等跨域请求直接放行
  if (url.origin !== self.location.origin) return;

  // 代码/数据：网络优先，拿不到再用缓存（离线兜底）
  if (FRESH_FIRST.test(url.pathname)) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || new Response(
        '离线中', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
      )))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) {
        // 命中缓存：后台顺便更新一次（stale-while-revalidate）
        fetch(req).then((res) => {
          if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        }).catch(() => {});
        return hit;
      }
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => {
        // 离线兜底：导航请求回 index.html
        if (req.mode === 'navigate') return caches.match('./index.html');
        return new Response('离线中', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      });
    })
  );
});

// 允许页面主动触发更新
self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
