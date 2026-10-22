/* 資治通鑑 PWA 前端装配
 * 职责：SW 注册、更新提示、全量离线缓存、进度/取消/续传/清除、iOS 指引、主题色同步
 * 不依赖 reader.js 的内部状态
 */
(function () {
  "use strict";

  var updateBar = null;
  var pendingWorker = null;
  var wantReload = false;
  var controllerReady = false;

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
            if (next.state === "installed" && navigator.serviceWorker.controller) {
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
    requestPersistentStorage();
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
    new MutationObserver(syncThemeColor).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"]
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
