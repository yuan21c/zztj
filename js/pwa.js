/* 資治通鑑 PWA 前端装配
 * 职责：SW 注册、更新提示、全量离线缓存、进度/取消/续传/清除、iOS 指引、主题色同步
 * 不依赖 reader.js 的内部状态
 */
(function () {
  "use strict";

  var TARGET_JSON = 300;
  var TARGET_FONT = 8;

  var updateBar = null;
  var pendingWorker = null;
  var wantReload = false;
  var controllerReady = false;

  var cacheDialog = null;
  var cacheRunning = false;
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

    start.textContent = "開始緩存";
    start.disabled = true;
    if (clear) {
      clear.hidden = !(cacheCompleted || cacheHasPartial);
      clear.disabled = false;
    }
    if (close) close.disabled = false;
  }

  function openCacheDialog() {
    if (!cacheDialog) return;
    cacheDialog.hidden = false;
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

    var clear = $("pwaCacheClear");
    if (clear) clear.addEventListener("click", clearOfflineCache);

    var close = $("pwaCacheClose");
    if (close) close.addEventListener("click", closeCacheDialog);

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
      }
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
