/* 資治通鑑 PWA 前端装配
 * 职责：SW 注册、更新提示、全量离线缓存、进度/取消/续传/清除、iOS 指引、主题色同步
 * 不依赖 reader.js 的内部状态
 */
(function () {
  "use strict";

  var TARGET_JSON = 300;
  var TARGET_FONT = 8;
  var CACHE_CONCURRENCY = 3;
  var OFFLINE_EXTRA = []; // 未来 img/ 静态图可列在此

  var updateBar = null;
  var pendingWorker = null;
  var wantReload = false;
  var controllerReady = false;

  var cacheDialog = null;
  var cacheRunning = false;
  var cacheAbort = null;
  var cacheDone = 0;
  var cacheTotal = 0;
  var cacheCompleted = false;
  var cacheHasPartial = false;

  function $(id) {
    return document.getElementById(id);
  }

  function isStandalone() {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true
    );
  }

  function isIOSSafari() {
    var ua = navigator.userAgent;
    var iOS =
      /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    var safari =
      /Safari/.test(ua) && !/Chrome|CriOS|Edg|OPR|Firefox|FxiOS/.test(ua);
    return iOS && safari;
  }

  /* ------------------------------------------------------------ SW 注册 */

  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    if (!window.isSecureContext) {
      console.info("[PWA] 非安全上下文（需 HTTPS 或 localhost），跳过注册");
      return;
    }

    navigator.serviceWorker
      .register("./sw.js", { scope: "./", updateViaCache: "none" })
      .then(function (reg) {
        if (reg.waiting && navigator.serviceWorker.controller) {
          showUpdate(reg.waiting);
        }

        reg.addEventListener("updatefound", function () {
          var next = reg.installing;
          if (!next) return;
          next.addEventListener("statechange", function () {
            if (
              next.state === "installed" &&
              navigator.serviceWorker.controller
            ) {
              showUpdate(next);
            }
          });
        });

        document.addEventListener("visibilitychange", function () {
          if (document.visibilityState === "visible" && navigator.onLine) {
            reg.update().catch(function () {});
          }
        });
      })
      .catch(function (err) {
        console.warn("[PWA] Service Worker 注册失败", err);
      });

    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (wantReload) {
        wantReload = false;
        window.location.reload();
        return;
      }
      // 首次安装时 clients.claim() 后 controller 才出现
      onControllerReady();
    });

    navigator.serviceWorker.ready
      .then(function () {
        if (navigator.serviceWorker.controller) onControllerReady();
      })
      .catch(function () {});
  }

  function onControllerReady() {
    if (controllerReady) return;
    controllerReady = true;
    var btn = $("btnCache");
    if (btn) btn.hidden = false;
    requestPersistentStorage();
    refreshCacheStatus();
    warmUpCurrentVolume();
  }

  /* --------------------------------------------------------- 更新提示条 */

  function showUpdate(worker) {
    pendingWorker = worker;

    if (!updateBar) {
      updateBar = document.createElement("div");
      updateBar.className = "pwa-update";
      updateBar.setAttribute("role", "status");
      updateBar.innerHTML =
        "<span>新版本已就緒</span>" +
        '<button type="button" id="pwaUpdateBtn">重新載入</button>' +
        '<button type="button" class="pwa-close" id="pwaUpdateClose" aria-label="稍後">×</button>';
      document.body.appendChild(updateBar);

      $("pwaUpdateBtn").addEventListener("click", function () {
        if (!pendingWorker) return;
        wantReload = true;
        pendingWorker.postMessage({ type: "SKIP_WAITING" });
      });
      $("pwaUpdateClose").addEventListener("click", function () {
        if (updateBar) updateBar.remove();
        updateBar = null;
      });
    }
  }

  /* ------------------------------------------------- 缓存状态与弹层 */

  function askSW(type) {
    return new Promise(function (resolve, reject) {
      var controller = navigator.serviceWorker.controller;
      if (!controller) {
        reject(new Error("Service Worker 尚未接管"));
        return;
      }
      var channel = new MessageChannel();
      var timer = setTimeout(function () {
        channel.port1.close();
        reject(new Error("Service Worker 响应超时"));
      }, 3000);

      channel.port1.onmessage = function (event) {
        clearTimeout(timer);
        channel.port1.close();
        resolve(event.data);
      };
      controller.postMessage({ type: type }, [channel.port2]);
    });
  }

  async function refreshCacheStatus() {
    if (!cacheDialog) return;
    try {
      var status = await askSW("CACHE_STATUS");
      var jsonCount = status.jsonCount || 0;
      var fontCount = status.fontCount || 0;

      cacheCompleted = jsonCount >= TARGET_JSON && fontCount >= TARGET_FONT;
      cacheHasPartial = !cacheCompleted && (jsonCount > 0 || fontCount > 0);

      if (!cacheRunning) {
        setBtnLabel(cacheCompleted ? "已緩存" : "緩存");
        setCacheStatusText(
          cacheCompleted
            ? "已完整緩存：300 卷 + 8 個字體，可離線閱讀全部內容。"
            : cacheHasPartial
              ? "已緩存 " +
                jsonCount +
                " 卷、" +
                fontCount +
                " 個字體；再次點擊可續傳。"
              : "尚未緩存。開始後請保持頁面開啟。",
        );
        var progress = $("pwaProgress");
        if (progress) progress.hidden = true;
      }
      syncCacheButtons();
    } catch (err) {
      setCacheStatusText("Service Worker 尚未就緒，請稍後重試。");
    }
  }

  function setBtnLabel(text) {
    var btn = $("btnCache");
    if (btn) btn.textContent = text;
  }

  function setCacheStatusText(text) {
    var status = $("pwaCacheStatus");
    if (status) status.textContent = text;
  }

  function syncCacheButtons() {
    var start = $("pwaCacheStart");
    var clear = $("pwaCacheClear");
    var close = $("pwaCacheClose");
    if (!start) return;

    if (cacheRunning) {
      start.textContent = "取消緩存";
      start.disabled = false;
      if (clear) clear.hidden = true;
      if (close) close.disabled = true;
    } else {
      start.textContent = cacheCompleted
        ? "重新緩存"
        : cacheHasPartial
          ? "繼續緩存"
          : "開始緩存";
      start.disabled = false;
      if (clear) {
        clear.hidden = !(cacheCompleted || cacheHasPartial);
        clear.disabled = false;
      }
      if (close) close.disabled = false;
    }
  }

  function openCacheDialog() {
    if (!cacheDialog) return;
    cacheDialog.hidden = false;
    var ios = $("pwaCacheIos");
    if (ios) ios.hidden = !(isIOSSafari() && !isStandalone());
    syncCacheButtons();
    refreshCacheStatus();
  }

  function closeCacheDialog() {
    if (cacheRunning || !cacheDialog) return;
    cacheDialog.hidden = true;
  }

  async function clearOfflineCache() {
    if (cacheRunning) return;
    if (
      !window.confirm(
        "清除已下載的離線內容？字體也會移除，之後需要重新緩存才能完整離線閱讀。",
      )
    ) {
      return;
    }

    try {
      await askSW("CLEAR_OFFLINE");
      cacheCompleted = false;
      cacheHasPartial = false;
      setBtnLabel("緩存");
      setCacheStatusText("已清除離線緩存。");
      syncCacheButtons();
    } catch (err) {
      setCacheStatusText("清除失敗：" + (err.message || "未知錯誤"));
    }
  }

  /* ------------------------------------------------------ 全量缓存流程 */

  function onCacheStart() {
    if (cacheRunning) {
      if (cacheAbort) cacheAbort.abort();
      return;
    }
    startFullCache();
  }

  async function startFullCache() {
    if (!navigator.onLine) {
      setCacheStatusText("目前離線，請連線後再試。");
      return;
    }
    if (!navigator.serviceWorker.controller) {
      setCacheStatusText("Service Worker 尚未接管，請重新載入頁面。");
      return;
    }

    cacheRunning = true;
    cacheAbort = new AbortController();
    cacheDone = 0;
    cacheTotal = 0;
    syncCacheButtons();

    var progress = $("pwaProgress");
    var bar = $("pwaProgressBar");
    if (progress) progress.hidden = false;
    if (bar) bar.style.width = "0%";
    setCacheStatusText("正在整理緩存清單…");

    try {
      var urls = await buildCacheList();
      cacheTotal = urls.length;
      setCacheStatusText("正在緩存 0 / " + cacheTotal + " 項…");

      await runPool(urls, CACHE_CONCURRENCY, cacheAbort.signal);

      if (cacheAbort.signal.aborted) {
        setCacheStatusText(
          "已暫停：已完成 " +
            cacheDone +
            " / " +
            cacheTotal +
            " 項，再次點擊可續傳。",
        );
      } else {
        cacheCompleted = true;
        setCacheStatusText("已完成：300 卷 + 8 個字體，可離線閱讀全部內容。");
      }
    } catch (err) {
      if (cacheAbort) cacheAbort.abort();
      if (err && err.name === "AbortError") {
        setCacheStatusText(
          "已取消：已完成 " + cacheDone + " / " + cacheTotal + " 項。",
        );
      } else {
        setCacheStatusText(
          "緩存中斷（" +
            (err && err.message ? err.message : "網路錯誤") +
            "）：已完成 " +
            cacheDone +
            " / " +
            cacheTotal +
            " 項，可再次點擊續傳。",
        );
      }
    } finally {
      cacheRunning = false;
      cacheAbort = null;
      syncCacheButtons();
      await refreshCacheStatus();
    }
  }

  async function buildCacheList() {
    var indexResp = await fetch("json/index.json", { cache: "no-cache" });
    if (!indexResp.ok) throw new Error("無法讀取目錄 index.json");
    var index = await indexResp.json();
    if (!index || !Array.isArray(index.entries)) {
      throw new Error("目錄格式錯誤");
    }

    var list = index.entries.map(function (entry) {
      return new URL("json/" + entry.file + ".json", document.baseURI).href;
    });

    var cssUrl = new URL("css/reader.css", document.baseURI).href;
    var cssResp = await fetch(cssUrl, { cache: "no-cache" });
    if (!cssResp.ok) throw new Error("無法讀取 reader.css");
    var cssText = await cssResp.text();

    var seen = new Set(list);
    var re = /url\(\s*['"]?([^'")]+\.woff2)['"]?\s*\)/gi;
    var match;
    while ((match = re.exec(cssText))) {
      var fontUrl = new URL(match[1], cssUrl).href;
      if (!seen.has(fontUrl)) {
        seen.add(fontUrl);
        list.push(fontUrl);
      }
    }

    OFFLINE_EXTRA.forEach(function (path) {
      var url = new URL(path, document.baseURI).href;
      if (!seen.has(url)) {
        seen.add(url);
        list.push(url);
      }
    });

    return list;
  }

  async function runPool(urls, limit, signal) {
    var next = 0;
    var failure = null;

    async function worker() {
      while (true) {
        if (signal.aborted || failure) return;
        var index = next++;
        if (index >= urls.length) return;
        try {
          await cacheOne(urls[index], signal);
        } catch (err) {
          failure = err;
          return;
        }
      }
    }

    var workers = [];
    for (var i = 0; i < limit; i++) workers.push(worker());
    await Promise.all(workers);
    if (failure) throw failure;
  }

  async function cacheOne(url, signal) {
    var resp = await fetch(url, { cache: "no-cache", signal: signal });
    if (!resp.ok) throw new Error("HTTP " + resp.status + "：" + url);

    // 读空 body，确保连接释放、SW 的 cache.put 完成
    if (resp.body) {
      var reader = resp.body.getReader();
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
      }
    }

    cacheDone += 1;
    updateProgress();
  }

  function updateProgress() {
    var bar = $("pwaProgressBar");
    var percent = cacheTotal ? Math.floor((cacheDone / cacheTotal) * 100) : 0;
    if (bar) bar.style.width = percent + "%";
    setCacheStatusText(
      "正在緩存 " + cacheDone + " / " + cacheTotal + " 項（" + percent + "%）…",
    );
  }

  /* --------------------------------------------------------- iOS 指引 */

  function showIOSGuide() {
    var guide = $("pwaIosGuide");
    if (!guide) {
      guide = document.createElement("div");
      guide.id = "pwaIosGuide";
      guide.className = "pwa-modal";
      guide.hidden = true;
      guide.setAttribute("role", "dialog");
      guide.setAttribute("aria-modal", "true");
      guide.setAttribute("aria-labelledby", "pwaIosTitle");
      guide.innerHTML =
        '<div class="pwa-modal-box">' +
        '<h2 id="pwaIosTitle">加入主畫面</h2>' +
        "<ol>" +
        "<li>用 Safari 開啟 <code>https://yuan21c.github.io/zztj/</code>。</li>" +
        "<li>點底部工具欄的「分享」圖示（iPad 在頂部）。</li>" +
        "<li>在分享選單中選「加入主畫面」。</li>" +
        "<li>名稱建議「資治通鑑」，點「加入」。</li>" +
        "<li>回主畫面啟動，即為獨立視窗；再點「緩存」下載全書。</li>" +
        "</ol>" +
        '<p class="pwa-hint">iOS 不會自動彈出安裝提示；若找不到「加入主畫面」，請確認不是私密瀏覽，且頁面已載入完成。</p>' +
        '<button type="button" id="pwaIosClose">知道了</button>' +
        "</div>";
      document.body.appendChild(guide);

      $("pwaIosClose").addEventListener("click", function () {
        guide.hidden = true;
      });
      guide.addEventListener("click", function (event) {
        if (event.target === guide) guide.hidden = true;
      });
    }
    guide.hidden = false;
    var close = $("pwaIosClose");
    if (close) close.focus();
  }

  /* ------------------------------------------------- 首次访问后的预热 */

  function warmUpCurrentVolume() {
    var part = "part0003";
    try {
      var pos = JSON.parse(localStorage.getItem("zztj:pos") || "null");
      if (pos && /^part\d{4}$/.test(pos.partId)) part = pos.partId;
    } catch (err) {}
    var hash = (location.hash || "").slice(1);
    if (/^part\d{4}$/.test(hash)) part = hash;

    fetch("json/" + part + ".json", { cache: "default" }).catch(function () {});
  }

  function requestPersistentStorage() {
    if (!navigator.storage || !navigator.storage.persist) return;
    navigator.storage
      .persisted()
      .then(function (already) {
        if (!already) return navigator.storage.persist();
      })
      .catch(function () {});
  }

  /* ------------------------------------------------------- 主题色同步 */

  function syncThemeColor() {
    var night = document.documentElement.dataset.theme === "night";
    var color = night ? "#070C09" : "#EDE4CF";
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) {
      metas[i].setAttribute("content", color);
    }
  }

  /* ------------------------------------------------------------ 启动 */

  function init() {
    cacheDialog = $("pwaCacheDialog");

    var btnCache = $("btnCache");
    if (btnCache) btnCache.addEventListener("click", openCacheDialog);

    var start = $("pwaCacheStart");
    if (start) start.addEventListener("click", onCacheStart);

    var clear = $("pwaCacheClear");
    if (clear) clear.addEventListener("click", clearOfflineCache);

    var close = $("pwaCacheClose");
    if (close) close.addEventListener("click", closeCacheDialog);

    var iosLink = $("pwaIosLink");
    if (iosLink) iosLink.addEventListener("click", showIOSGuide);

    if (cacheDialog) {
      cacheDialog.addEventListener("click", function (event) {
        if (event.target === cacheDialog) closeCacheDialog();
      });
    }

    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return;
      if (cacheRunning) return;
      if (cacheDialog && !cacheDialog.hidden) {
        cacheDialog.hidden = true;
        return;
      }
      var guide = $("pwaIosGuide");
      if (guide && !guide.hidden) guide.hidden = true;
    });

    new MutationObserver(syncThemeColor).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    syncThemeColor();
    requestAnimationFrame(syncThemeColor);

    registerSW();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
