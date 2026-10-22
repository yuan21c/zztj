/* 資治通鑑 PWA Service Worker
 *
 * 维护规则：
 *   - 改动 index.html / css / js / manifest / icons 后递增 BUILD
 *   - 改动 json/ 内容后递增 DATA_VERSION（否则 cache-first 会一直读旧卷）
 *   - 改动 fonts/ 或 img/ 后递增 ASSET_VERSION
 */
"use strict";

const BUILD = "pwa-4";
const DATA_VERSION = "v1";
const ASSET_VERSION = "v1";

const SHELL_CACHE = "zztj-shell-" + BUILD;
const DATA_CACHE = "zztj-data-" + DATA_VERSION;
const ASSET_CACHE = "zztj-asset-" + ASSET_VERSION;

const SHELL = [
  "./index.html",
  "./css/reader.css",
  "./css/pwa.css",
  "./js/reader.js",
  "./js/pwa.js",
  "./manifest.webmanifest",
  "./json/index.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon-180.png",
];

/* ---------------------------------------------------------------- 安装 */

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)),
  );
});

/* ---------------------------------------------------------- 激活与清理 */

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) => {
            if (key.startsWith("zztj-shell-") && key !== SHELL_CACHE) {
              return caches.delete(key);
            }
            if (key.startsWith("zztj-data-") && key !== DATA_CACHE) {
              return caches.delete(key);
            }
            if (key.startsWith("zztj-asset-") && key !== ASSET_CACHE) {
              return caches.delete(key);
            }
            return null;
          }),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/* ------------------------------------------------------------ 请求处理 */

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 页面导航：离线回退到缓存的 index.html
  if (req.mode === "navigate") {
    event.respondWith(navigationFallback(req));
    return;
  }

  // 卷目录（随外壳更新）
  if (url.pathname.endsWith("/json/index.json")) {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
    return;
  }

  // 卷分片
  if (/\/json\/part\d+\.json$/.test(url.pathname)) {
    event.respondWith(cacheFirst(req, DATA_CACHE));
    return;
  }

  // 字体
  if (/\/fonts\/[^/]+\.(ttf|otf|woff2?)$/i.test(url.pathname)) {
    event.respondWith(cacheFirst(req, ASSET_CACHE));
    return;
  }

  // 书内图片（当前 img/ 为空，预留给 imgSrc()）
  if (/\/img\/[^/]+\.(svg|png|jpe?g|webp|gif)$/i.test(url.pathname)) {
    event.respondWith(cacheFirst(req, ASSET_CACHE));
    return;
  }

  // 图标
  if (/\/icons\//.test(url.pathname)) {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
    return;
  }

  // 其余外壳静态资源
  if (/\.(css|js|webmanifest)$/.test(url.pathname)) {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
    return;
  }
});

/* ---------------------------------------------------------------- 消息 */

self.addEventListener("message", (event) => {
  const data = event.data || {};
  const port = event.ports && event.ports[0];

  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }

  if (data.type === "CACHE_STATUS") {
    event.waitUntil(reportCacheStatus(port));
    return;
  }

  if (data.type === "CLEAR_OFFLINE") {
    event.waitUntil(clearOffline(port));
  }
});

/* ---------------------------------------------------------------- 策略 */

async function navigationFallback(req) {
  const cache = await caches.open(SHELL_CACHE);
  const shellUrl = new URL("./index.html", self.registration.scope).href;
  const shell = await cache.match(shellUrl);
  if (shell) return shell;
  return fetch(req).catch(() => Response.error());
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;

  const resp = await fetch(req);
  // 只缓存完整 200 响应；206 分段响应不入缓存
  if (resp && resp.status === 200) {
    try {
      await cache.put(req, resp.clone());
    } catch (err) {
      // 配额不足：放弃缓存，本次仍返回网络响应
    }
  }
  return resp;
}

async function reportCacheStatus(port) {
  const dataCache = await caches.open(DATA_CACHE);
  const assetCache = await caches.open(ASSET_CACHE);
  const dataKeys = await dataCache.keys();
  const assetKeys = await assetCache.keys();

  const jsonCount = dataKeys.filter((req) =>
    /\/json\/part\d+\.json$/.test(new URL(req.url).pathname),
  ).length;

  const fontCount = assetKeys.filter((req) =>
    /\/fonts\/[^/]+\.woff2$/.test(new URL(req.url).pathname),
  ).length;

  if (port) {
    port.postMessage({ type: "CACHE_STATUS", jsonCount, fontCount });
  }
}

async function clearOffline(port) {
  await caches.delete(DATA_CACHE);
  await caches.delete(ASSET_CACHE);
  if (port) port.postMessage({ type: "CLEAR_OFFLINE", ok: true });
}
