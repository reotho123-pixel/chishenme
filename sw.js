/* ============================================================
   待会吃什么 · Service Worker
   改代码后请把下面的 CACHE 版本号 +1，已安装用户才会拿到新版
   ============================================================ */
const CACHE = 'chishenme-v14';

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

// 版本变化时重新预缓存。这里必须用 cache:'reload' 绕开浏览器自己的 HTTP 缓存 ——
// GitHub Pages 给静态资源发了 max-age=600，不绕开的话装上的还是旧文件，
// 表现就是"改完代码上线了，用户打开还是老样子"。
//
// 串行抓取：并发十几个请求在弱网下容易整批失败，而这里总共也就十几KB。
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => {
      return ASSETS.reduce((chain, url) => {
        return chain.then(() =>
          fetch(url, { cache: 'reload' }).then((res) => {
            if (res && res.ok) return c.put(url, res);
          }).catch(() => { /* 单个失败不影响整体，运行时还能走网络 */ })
        );
      }, Promise.resolve());
    }).then(() => self.skipWaiting())
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

  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;   // 预缓存已是当次版本的内容，直接用
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
