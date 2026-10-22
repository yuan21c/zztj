/* 《資治通鑑》竖排 Web 阅读器 —— reader.js
   单个 IIFE：先纯函数层（可无 DOM 单测），后 DOM 段；无 document 时提前返回。
   规格：output/HTML/技术规范.md */
(function () {
  "use strict";

  // 顶层块 key → 字符 class（paragraph 与正文同 class；preface 走 note 分支）
  var KEY_CLASS = {
    "volume-title": "volume-title",
    "section-heading": "section-heading",
    "subsection-heading": "subsection-heading",
    chronicle: "chronicle",
    commentary: "commentary",
    ruler: "ruler",
    "reign-year": "reign-year",
    paragraph: "chronicle",
    "role-line": "role-line",
    "name-line": "name-line",
  };

  // 五家校勘记（顺序即分色顺序）
  var COLLATION_KEYS = [
    "collation-zhang",
    "collation-zou",
    "collation-yan",
    "collation-zhang-ren",
    "collation-tui",
  ];

  // 双行夹注 key；仅 NOTE_MARK 中的 key 显示注释标识
  var NOTE_KEYS = [
    "annotation",
    "annotation-era",
    "annotation-span",
    "annotation-bio",
    "annotation-note",
    "annotation-title",
    "preface",
  ].concat(COLLATION_KEYS);

  var NOTE_MARK = {
    annotation: "胡",
    "collation-zhang": "章",
    "collation-zou": "鄒",
    "collation-yan": "嚴",
    "collation-zhang-ren": "張",
    "collation-tui": "退",
  };

  // 行内 key → 附加 class
  var INNER_CLASS_MAP = { "book-title": "book-title", bold: "bold" };

  // 媒体标记 key → class；随后贪心消费的键 → 字段名
  var MEDIA_MARK = { gaiji: "gaiji", seal: "seal" };
  var MEDIA_FIELD = { "data-char": "dataChar", src: "src", alt: "alt" };

  var PROV_CLASS = "prov-char";

  function firstKey(obj) {
    for (var k in obj) return k;
    return null;
  }

  /* 按 Unicode 码点逐字切分：BMP 外字符（如「𡰥」）是代理对，必须整体算 1 字，
     否则会拆成孤立代理、渲染成 U+FFFD。 */
  function pushString(chars, text, cls) {
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      var code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        var low = text.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          ch += text.charAt(i + 1);
          i++;
        }
      }
      chars.push({ char: ch, cls: cls, puncts: [] });
    }
  }

  /* 块数组 → chars 数组：字符串逐字；punct 挂到前一字；book-title/bold 加 class；
     gaiji/seal 合成单个媒体 char，并贪心消费紧随的 data-char/src/alt。 */
  function expandBlock(arr, baseCls) {
    var chars = [];
    if (!arr || !arr.length) return chars;

    for (var i = 0; i < arr.length; i++) {
      var item = arr[i];
      if (typeof item === "string") {
        pushString(chars, item, baseCls || null);
        continue;
      }
      if (item === null || typeof item !== "object") continue;

      var key = firstKey(item);
      var val = item[key];

      if (key === "punct") {
        if (chars.length > 0) chars[chars.length - 1].puncts.push(val);
        continue;
      }

      if (MEDIA_MARK[key]) {
        var media = {
          char: "",
          cls: MEDIA_MARK[key],
          src: null,
          dataChar: null,
          alt: null,
          puncts: [],
        };
        var j = i + 1;
        while (j < arr.length) {
          var next = arr[j];
          if (next === null || typeof next !== "object" || Array.isArray(next))
            break;
          var nk = firstKey(next);
          if (!MEDIA_FIELD[nk]) break; // 第一种不在字段集合的对象即停止
          media[MEDIA_FIELD[nk]] = next[nk];
          j++;
        }
        i = j - 1;
        chars.push(media);
        continue;
      }

      var extra = INNER_CLASS_MAP[key] || null;
      var cls = combine(baseCls, extra);
      if (typeof val === "string") pushString(chars, val, cls);
      else if (Array.isArray(val)) pushString(chars, collectStrings(val), cls);
    }
    return chars;
  }

  function combine(baseCls, extra) {
    if (baseCls && extra) return baseCls + " " + extra;
    return baseCls || extra || null;
  }

  /* 夹注逐字 class：annotation* 沿用默认（不着色），其余保留标签用于分色/分字体。 */
  function noteCharClass(key) {
    if (key === "annotation" || key.indexOf("annotation-") === 0) return null;
    return key;
  }

  /* 五校首字剥离：首字恰为家名时剥掉；「據章校增」类首字不是家名，原样保留。 */
  function stripCollationLabel(key, chars) {
    var label = NOTE_MARK[key];
    if (!label || !chars.length) return;
    if (chars[0].cls !== key || chars[0].char !== label) return;
    chars.shift();
  }

  function collectStrings(arr) {
    var out = "";
    for (var i = 0; i < arr.length; i++) {
      var item = arr[i];
      if (typeof item === "string") out += item;
      else if (item !== null && typeof item === "object") {
        var k = firstKey(item);
        if (typeof item[k] === "string") out += item[k];
      }
    }
    return out;
  }

  function toTokens(data) {
    var tokens = [];
    if (!data || !data.length) return tokens;

    for (var i = 0; i < data.length; i++) {
      var item = data[i];

      // 兼容 demo 遗留的裸字符串 "break"
      if (typeof item === "string") {
        if (item === "break") tokens.push({ type: "break" });
        continue;
      }
      if (item === null || typeof item !== "object") continue;

      var key = firstKey(item);
      var val = item[key];

      // 类型标记：仅标记，不排字
      if (key === "kind") continue;

      if (key === "break") {
        tokens.push({ type: "break" });
        continue;
      }

      // 条目编号：整串占 1 字位
      if (key === "entry-number") {
        tokens.push({ type: "entry", text: collectStrings(val) });
        continue;
      }

      // 双行夹注：胡注/公元注/起讫注/小传/注中注/标题注/五校/总论
      if (NOTE_KEYS.indexOf(key) >= 0) {
        var noteChars = expandBlock(val, noteCharClass(key));
        if (COLLATION_KEYS.indexOf(key) >= 0)
          stripCollationLabel(key, noteChars);

        var prevTok = tokens.length ? tokens[tokens.length - 1] : null;
        // 连续夹注（不论标签）并入同一个双行区块；标识占 2 字位，
        // 仅当该 key 有标识且与当前标识不同时插入。
        if (prevTok && prevTok.type === "note") {
          if (NOTE_MARK[key] && key !== prevTok.markKey) {
            prevTok.chars.push({ type: "mark", key: key });
            prevTok.markKey = key;
          }
          for (var z = 0; z < noteChars.length; z++)
            prevTok.chars.push(noteChars[z]);
        } else {
          var noteItems = [];
          var markKey = null;
          if (NOTE_MARK[key]) {
            noteItems.push({ type: "mark", key: key });
            markKey = key;
          }
          for (var z2 = 0; z2 < noteChars.length; z2++)
            noteItems.push(noteChars[z2]);
          tokens.push({
            type: "note",
            key: key,
            chars: noteItems,
            markKey: markKey,
          });
        }
        continue;
      }

      // 署名：字符串逐字 + 固定双行（dual）
      if (key === "provenance") {
        for (var p = 0; p < val.length; p++) {
          var pv = val[p];
          if (typeof pv === "string") {
            var pchars = [];
            pushString(pchars, pv, PROV_CLASS);
            for (var q = 0; q < pchars.length; q++)
              tokens.push({
                type: "char",
                char: pchars[q].char,
                cls: PROV_CLASS,
                puncts: [],
              });
            continue;
          }
          if (pv !== null && typeof pv === "object") {
            var pk = firstKey(pv);
            if (pk === "dual") {
              var parts = pv[pk];
              tokens.push({
                type: "prov-dual",
                right: expandBlock([parts[0]], PROV_CLASS),
                left: expandBlock([parts[1]], PROV_CLASS),
              });
              continue;
            }
            var objChars = expandBlock([pv], PROV_CLASS);
            for (var r = 0; r < objChars.length; r++) {
              tokens.push({
                type: "char",
                char: objChars[r].char,
                cls: objChars[r].cls,
                puncts: objChars[r].puncts,
              });
            }
          }
        }
        continue;
      }

      if (KEY_CLASS[key]) {
        var chars = expandBlock(val, KEY_CLASS[key]);
        for (var c = 0; c < chars.length; c++) {
          tokens.push({
            type: "char",
            char: chars[c].char,
            cls: chars[c].cls,
            puncts: chars[c].puncts,
          });
        }
        continue;
      }

      // 未知 key：跳过（前向兼容）
    }
    return tokens;
  }

  /* 'Images/x.svg' / 'http://a/b/x.svg' / 'img/x.svg' → 'img/x.svg'；空 → '' */
  function imgSrc(raw) {
    if (typeof raw !== "string" || raw === "") return "";
    var cut = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
    var base = cut >= 0 ? raw.slice(cut + 1) : raw;
    if (base === "") return "";
    return "img/" + base;
  }

  /* 同卷复用，换卷重建 */
  function resolveTokens(cache, partId, data) {
    if (cache && cache.partId === partId && cache.tokens) {
      return { tokens: cache.tokens, cache: cache };
    }
    var tokens = toTokens(data);
    return { tokens: tokens, cache: { partId: partId, tokens: tokens } };
  }

  function findColForAnchor(cols, idx) {
    if (!cols || cols.length === 0) return 0;
    var target = idx > 0 ? idx : 0;
    var found = 0;
    for (var i = 0; i < cols.length; i++) {
      if (cols[i].startIndex <= target) found = i;
      else break;
    }
    return found;
  }

  /* 注文流中一项占几个字位：标识固定占 2 位，其余 1 位。 */
  function noteItemSlots(item) {
    return item && item.type === "mark" ? 2 : 1;
  }

  function noteSlots(items, start, end) {
    var sum = 0;
    for (var i = start; i < end; i++) sum += noteItemSlots(items[i]);
    return sum;
  }

  /* 在 items[start, start+n) 内找切点 k：两段字位都不超 limit、|R−L| 最小，
     平手取 R ≥ L；无解返回 −1。 */
  function balancedCut(items, start, n, limit) {
    var total = noteSlots(items, start, start + n);
    var best = -1;
    var bestDiff = Infinity;
    var bestR = -1;
    var bestL = -1;
    var acc = 0;
    for (var k = 0; k <= n; k++) {
      if (k > 0) acc += noteItemSlots(items[start + k - 1]);
      var R = acc;
      var L = total - acc;
      if (R > limit || L > limit) continue;
      var diff = Math.abs(R - L);
      var better =
        diff < bestDiff || (diff === bestDiff && R >= L && bestR < bestL);
      if (better) {
        best = k;
        bestDiff = diff;
        bestR = R;
        bestL = L;
      }
    }
    return best;
  }

  /* 按高度分列：
     - 每列记 startIndex（首 token 的全局序号），供锚点定位；
     - char/entry/media 按 F 累加（署名单行按 provH），超列高则拉伸换列；
     - note 按 perCol×2 切分、余量续列；prov-dual 占 max(right,left)×provH；
     - break 只换列不拉伸；收尾三态由 stretch/tailAlign 交给渲染层。
     provH 缺省取 F/2（夹注字号），兼容既有调用与单测。 */
  function layout(tokens, colHeight, F, provH) {
    var cols = [];
    if (!(provH > 0)) provH = F / 2;
    var half = F / 2;
    var cur = newCol();
    var used = 0;

    function newCol() {
      return {
        startIndex: 0,
        used: 0,
        tokens: [],
        tokenIndexes: [],
        stretch: false,
        tailAlign: false,
      };
    }

    function push(tok, tokenIndex) {
      if (cur.tokens.length === 0) cur.startIndex = tokenIndex;
      cur.tokens.push(tok);
      cur.tokenIndexes.push(tokenIndex); // 与 tokens 平行，供二次测量回写 startIndex
    }

    function flush(stretch) {
      if (cur.tokens.length === 0) return; // 空列不入结果（尾随 break 不留空白列）
      cur.used = used;
      cur.stretch = !!stretch;
      cols.push(cur);
      cur = newCol();
      used = 0;
    }

    if (!tokens || !tokens.length) return cols;

    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];

      if (t.type === "break") {
        flush(false);
        continue;
      }

      if (t.type === "note") {
        var seg = t.chars || [];
        var pos = 0;
        var guard = 0;
        while (pos < seg.length && guard++ < 100000) {
          var perCol = Math.floor((colHeight - used) / half);
          if (perCol <= 0) {
            if (cur.tokens.length > 0) {
              flush(true); // 列非空 → 换列重试
              continue;
            }
            // 列已空仍放不下：剩余全部入本列（宁可超高，绝不丢字）
            var rest = seg.slice(pos);
            var kRest = balancedCut(rest, 0, rest.length, Infinity);
            push(
              {
                type: "note-dual",
                key: t.key,
                rightTokens: rest.slice(0, kRest),
                leftTokens: rest.slice(kRest),
              },
              i,
            );
            var rRest = noteSlots(rest, 0, kRest);
            var lRest = noteSlots(rest, kRest, rest.length);
            used += Math.max(rRest, lRest) * half;
            pos = seg.length;
            break;
          }

          // 本段最多能完整容纳的项数（mark 占 2 位）
          var n = 0;
          var slots = 0;
          while (pos + n < seg.length) {
            var s = noteItemSlots(seg[pos + n]);
            if (slots + s > perCol * 2) break;
            slots += s;
            n++;
          }

          // 在 n 项内找合法切点；整枚 mark 放不进任何一侧时退一项再试
          var k = -1;
          while (n > 0) {
            k = balancedCut(seg, pos, n, perCol);
            if (k >= 0) break;
            n--; // 整枚 mark 放不进任何一侧：退一项再试
          }
          if (n === 0) {
            if (cur.tokens.length > 0) {
              flush(true);
              continue;
            }
            // 空列且 perCol<2：允许超高，放第一项，其余换列
            push(
              {
                type: "note-dual",
                key: t.key,
                rightTokens: seg.slice(pos, pos + 1),
                leftTokens: [],
              },
              i,
            );
            used += noteItemSlots(seg[pos]) * half;
            pos += 1;
            continue;
          }

          var rSlots = noteSlots(seg, pos, pos + k);
          var lSlots = noteSlots(seg, pos + k, pos + n);
          push(
            {
              type: "note-dual",
              key: t.key,
              rightTokens: seg.slice(pos, pos + k),
              leftTokens: seg.slice(pos + k, pos + n),
            },
            i,
          );
          used += Math.max(rSlots, lSlots) * half;
          pos += n;
          if (pos < seg.length) flush(true);
        }
        continue;
      }

      if (t.type === "prov-dual") {
        var hPD = Math.max(t.right.length, t.left.length) * provH;
        if (used + hPD > colHeight + 0.1 && cur.tokens.length > 0) flush(true);
        cur.tailAlign = true;
        push(t, i);
        used += hPD;
        continue;
      }

      var h = t.type === "char" && t.cls === PROV_CLASS ? provH : F;
      if (used + h > colHeight + 0.1 && cur.tokens.length > 0) flush(true);
      if (t.type === "char" && t.cls === PROV_CLASS) cur.tailAlign = true;
      push(t, i);
      used += h;
    }

    flush(false);
    return cols;
  }

  /* 署名块高度（以署名字号为单位）：署名单行占 1 单位，prov-dual 占
     max(right,left) 单位；返回各署名块最大值，用于封顶 --prov-size，
     保证每个署名块能在单列内显示完整。 */
  function provUnits(tokens) {
    var maxUnits = 0;
    var curUnits = 0;
    var inBlock = false;
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (t.type === "char" && t.cls === PROV_CLASS) {
        curUnits += 1;
        inBlock = true;
        continue;
      }
      if (t.type === "prov-dual") {
        curUnits += Math.max(t.right.length, t.left.length);
        inBlock = true;
        continue;
      }
      if (inBlock) {
        if (curUnits > maxUnits) maxUnits = curUnits;
        curUnits = 0;
        inBlock = false;
      }
    }
    if (inBlock && curUnits > maxUnits) maxUnits = curUnits;
    return maxUnits;
  }

  var ZZTJ = {
    KEY_CLASS: KEY_CLASS,
    COLLATION_KEYS: COLLATION_KEYS,
    NOTE_KEYS: NOTE_KEYS,
    NOTE_MARK: NOTE_MARK,
    toTokens: toTokens,
    layout: layout,
    imgSrc: imgSrc,
    resolveTokens: resolveTokens,
    findColForAnchor: findColForAnchor,
    provUnits: provUnits,
  };

  if (typeof window === "object" && window) window.ZZTJ = ZZTJ;
  else globalThis.ZZTJ = ZZTJ;

  if (typeof document === "undefined" || !document.getElementById) return; // 无 DOM → 不自启动

  var wrapper = document.getElementById("readerWrapper");
  var reader = document.getElementById("reader");
  var loadingOverlay = document.getElementById("loadingOverlay");

  var _rawData = null; // 当前卷原始 JSON
  var _currentPartId = null; // 当前卷 id（与 manifest file、hash 同形）
  var _cache = null; // {partId, tokens}
  var _entries = null; // manifest 条目数组
  var _entryMap = null; // Map<file, entry>
  var _prefetch = null; // Map<partId, {tokens,data}>，LRU 上限 3（规格 §4.6）
  var _prefetching = null; // 在途预取的 partId（同刻至多 1 个后台请求）

  var MAX_PREFETCH = 3;

  var currentFontSize = 42;
  var currentLineSpacing = 1.6;
  var hideTimer = null;
  var _userChangedFont = false; // 用户是否手动改过字号（跨 640px 断点时决定是否跟随默认值）

  /* 字号/行距 150/400ms 合并窗口：窗口内只累积同一按钮；异类按钮丢弃其请求并立即提交。 */
  var STYLE_DEBOUNCE_TOUCH = 150;
  var STYLE_DEBOUNCE_MOUSE = 400;
  var STYLE_DEBOUNCE_KEYBOARD = 150;
  var LOADING_HIDE_DELAY = 120; // 遮罩淡出延时（按钮在执行结束时即恢复）
  var STYLE_BUTTON_IDS = [
    "btnFontDec",
    "btnFontInc",
    "btnLineNarrow",
    "btnLineWide",
    "btnReset",
  ];
  var ALL_CONTROL_IDS = STYLE_BUTTON_IDS.concat([
    "btnPrevVol",
    "btnNextVol",
    "btnTheme",
    "btnToc",
  ]);
  var pendingFontSize = null;
  var pendingLineSpacing = null;
  var styleTimer = null;
  var _stylePhase = "idle"; // idle | pending | running
  var _pendingAction = null; // font-dec | font-inc | line-dec | line-inc
  var _styleExecStart = 0; // 本次执行开始时刻（用于丢弃排队到执行结束后的点击）
  var _styleExecEnd = 0; // 本次执行结束时刻
  var _pulseAnims = []; // 当前点击反馈动画，下一次点击前取消
  var _volumeLoading = 0; // 正在加载的卷数：>0 时样式点击弃置
  var _lastPointerType = ""; // 最近一次 pointerdown 的输入类型（click 事件的兜底）

  function applyPuncts(el, t) {
    if (!t.puncts) return;
    if (t.puncts[0]) el.dataset.punct = t.puncts[0];
    if (t.puncts[1]) el.dataset.punct2 = t.puncts[1];
  }

  /* gaiji / seal → <img>；src 缺失或加载失败 → data-char/alt/□ 文本降级 */
  function mediaEl(t, tag, baseCls) {
    var el = document.createElement(tag);
    var cls = baseCls + " " + t.cls;
    var src = imgSrc(t.src);
    el.className = cls;
    if (t.dataChar) el.dataset.char = t.dataChar;

    if (!src) {
      el.classList.add("media-missing");
      el.textContent = t.dataChar || t.alt || "□";
      return el;
    }
    var img = document.createElement("img");
    img.src = src;
    img.alt = t.alt || t.dataChar || "";
    img.onerror = function () {
      el.classList.remove("has-img");
      el.classList.add("media-missing");
      el.textContent = t.dataChar || t.alt || "□";
    };
    el.classList.add("has-img");
    el.appendChild(img);
    return el;
  }

  /* 单字元素：tag 取 div（正文）/ span（注文） */
  function charEl(t, tag, baseCls) {
    if (t.cls === "gaiji" || t.cls === "seal") return mediaEl(t, tag, baseCls);
    var el = document.createElement(tag);
    el.className = baseCls + (t.cls ? " " + t.cls : "");
    applyPuncts(el, t);
    el.textContent = t.char;
    return el;
  }

  /* 竖排双格注释标识：1em×2em 原子槽，字符与颜色交给 CSS */
  function renderNoteMark(key) {
    var slot = document.createElement("span");
    slot.className = "note-mark-slot";

    var mark = document.createElement("span");
    mark.className = "note-mark " + key;
    mark.setAttribute("role", "img");
    mark.setAttribute("aria-label", NOTE_MARK[key] + "注");

    var top = document.createElement("span");
    top.className = "cell cell-top";
    var topChar = document.createElement("span");
    topChar.className = "g";
    topChar.textContent = NOTE_MARK[key];
    top.appendChild(topChar);

    var bottom = document.createElement("span");
    bottom.className = "cell cell-bottom";
    var bottomChar = document.createElement("span");
    bottomChar.className = "g";
    bottomChar.textContent = "注";
    bottom.appendChild(bottomChar);

    mark.appendChild(top);
    mark.appendChild(bottom);
    slot.appendChild(mark);
    return slot;
  }

  function makeNoteCol(chars, cls) {
    var box = document.createElement("div");
    box.className = cls;
    for (var i = 0; i < chars.length; i++) {
      if (chars[i] && chars[i].type === "mark")
        box.appendChild(renderNoteMark(chars[i].key));
      else box.appendChild(charEl(chars[i], "span", "note-char"));
    }
    return box;
  }

  function renderNoteDual(t) {
    var dual = document.createElement("div");
    dual.className = "note-dual" + (t.key === "annotation" ? "" : " " + t.key);
    dual.appendChild(makeNoteCol(t.rightTokens, "note-r"));
    dual.appendChild(makeNoteCol(t.leftTokens, "note-l"));
    return dual;
  }

  function renderProvDual(t) {
    var box = document.createElement("span");
    box.className = "prov-dual";
    box.appendChild(makeNoteCol(t.right, "note-r"));
    box.appendChild(makeNoteCol(t.left, "note-l"));
    return box;
  }

  /* token → 列内元素；tokenIndex 用于二次测量回写 */
  function renderToken(t, tokenIndex) {
    var el;
    if (t.type === "char") el = charEl(t, "div", "char");
    else if (t.type === "entry") {
      el = document.createElement("div");
      el.className = "char entry-num";
      el.textContent = t.text;
    } else if (t.type === "note-dual") el = renderNoteDual(t);
    else if (t.type === "prov-dual") el = renderProvDual(t);
    else if (t.type === "media") el = mediaEl(t, "div", "char");
    else return null;
    el.dataset.tokenIndex = String(tokenIndex);
    return el;
  }

  function renderCol(col) {
    var div = document.createElement("div");
    div.className =
      "col " +
      (col.tailAlign ? "tail-align" : col.stretch ? "stretch" : "no-stretch");
    div.dataset.startIndex = String(col.startIndex);

    for (var i = 0; i < col.tokens.length; i++) {
      var el = renderToken(
        col.tokens[i],
        col.tokenIndexes ? col.tokenIndexes[i] : col.startIndex,
      );
      if (el) div.appendChild(el);
    }
    return div;
  }

  function renderAll(cols) {
    reader.innerHTML = "";
    for (var i = 0; i < cols.length; i++)
      reader.appendChild(renderCol(cols[i]));
  }

  /* 按列宽（= 竖线间距）铺满容器内容区（含空白处）；container 为 .rules 的定位容器 */
  function renderRules(container, colEls) {
    var old = container.querySelector(".rules");
    if (old) old.remove();

    var rules = document.createElement("div");
    rules.className = "rules";

    var cs = getComputedStyle(container);
    var padTop = parseFloat(cs.paddingTop) || 0;
    var padBot = parseFloat(cs.paddingBottom) || 0;
    var padLeft = parseFloat(cs.paddingLeft) || 0;
    var padRight = parseFloat(cs.paddingRight) || 0;

    var lineTop = padTop;
    var lineHeight = container.clientHeight - padTop - padBot;

    // 列自右向左排列（row-reverse），故自内容区右缘向左铺满
    var rightEdge = container.clientWidth - padRight + container.scrollLeft;
    var leftEdge = padLeft;

    // 列宽即竖线间距；量不到列时按 字号 × 行距 兜底
    var pitch = colEls.length ? colEls[0].getBoundingClientRect().width : 0;
    if (!(pitch > 1)) pitch = currentFontSize * currentLineSpacing;
    if (!(pitch > 1)) return;

    for (var k = 1; ; k++) {
      var x = rightEdge - k * pitch;
      if (x <= leftEdge + 1) break;
      var line = document.createElement("div");
      line.className = "rule";
      line.style.left = Math.round(x - 1) + "px";
      line.style.top = lineTop + "px";
      line.style.height = lineHeight + "px";
      rules.appendChild(line);
      if (k > 5000) break; // 防御：异常宽的页面
    }
    container.appendChild(rules);
  }

  function renderReaderRules() {
    renderRules(reader, reader.querySelectorAll(".col"));
  }

  function computeColHeight() {
    var cs = getComputedStyle(reader);
    var padTop = parseFloat(cs.paddingTop) || 0;
    var padBot = parseFloat(cs.paddingBottom) || 0;
    var rootCS = getComputedStyle(document.documentElement);
    var colPadV = parseFloat(rootCS.getPropertyValue("--col-pad-v")) || 0;
    return reader.clientHeight - padTop - padBot - colPadV * 2;
  }

  /* 估算高度与真实像素有偏差：逐列量 scrollHeight，超出则把列尾元素弹到下一列（最多 8 轮）。 */
  function fixOverflow(cols, colHeight) {
    var colEls = Array.prototype.slice.call(reader.querySelectorAll(".col"));
    if (!colEls.length) return;

    var rootCS = getComputedStyle(document.documentElement);
    var colPadV = parseFloat(rootCS.getPropertyValue("--col-pad-v")) || 0;
    var limit = colHeight + colPadV * 2 + 1;

    for (var round = 0; round < 8; round++) {
      var moved = false;
      for (var i = 0; i < colEls.length; i++) {
        var col = cols[i];
        var el = colEls[i];
        if (!col || !el || col.tailAlign) continue;
        if (el.children.length <= 1) continue; // 单 token 无从弹起
        if (el.scrollHeight <= limit) continue;

        var target = colEls[i + 1];
        if (!target) {
          target = document.createElement("div");
          target.className = "col no-stretch";
          reader.appendChild(target);
          colEls.push(target);
          cols.push({
            startIndex: 0,
            used: 0,
            tokens: [],
            tokenIndexes: [],
            stretch: false,
            tailAlign: false,
          });
        }
        if (target.classList.contains("tail-align")) continue; // 署名（贴底）列不接收挪字
        var last = el.lastElementChild;

        // 目标列须真放得下才搬（先试插再量）；不能用 scrollHeight 估余量。
        target.insertBefore(last, target.firstChild);
        if (target.scrollHeight > limit) {
          el.appendChild(last); // 放不下 → 还原
          continue;
        }

        // 目标列首元素变了 → 回写 startIndex（锚点依赖）
        var ti = parseInt(target.firstElementChild.dataset.tokenIndex, 10);
        if (!isNaN(ti)) {
          target.dataset.startIndex = String(ti);
          if (cols[i + 1]) cols[i + 1].startIndex = ti;
        }
        moved = true;
      }
      if (!moved) break;
    }
  }

  function showLoading() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (loadingOverlay) {
      var err = loadingOverlay.querySelector(".loading-error");
      if (err) err.parentNode.removeChild(err); // 清掉上次报错态
      var spinner = loadingOverlay.querySelector(".loading-spinner");
      if (spinner) spinner.style.display = "";
      var text = loadingOverlay.querySelector(".loading-text");
      if (text) text.style.display = "";
      loadingOverlay.classList.add("active");
      loadingOverlay.setAttribute("aria-hidden", "false");
    }
  }

  function hideLoading() {
    hideTimer = setTimeout(function () {
      hideTimer = null;
      if (loadingOverlay) {
        loadingOverlay.classList.remove("active");
        loadingOverlay.setAttribute("aria-hidden", "true");
      }
    }, LOADING_HIDE_DELAY);
  }

  /* 被接受的点击给「正在重排」一次可见反馈（WAAPI 脉冲，避免强制重排）。 */
  function pulseLoadingFeedback() {
    if (!loadingOverlay) return;
    for (var i = 0; i < _pulseAnims.length; i++) _pulseAnims[i].cancel();
    _pulseAnims = [];
    var nodes = loadingOverlay.querySelectorAll(
      ".loading-spinner, .loading-text",
    );
    for (var j = 0; j < nodes.length; j++) {
      if (nodes[j].style.display === "none" || !nodes[j].animate) continue;
      _pulseAnims.push(
        nodes[j].animate([{ opacity: 0.25 }, { opacity: 1 }], {
          duration: 220,
          easing: "ease-out",
        }),
      );
    }
  }

  /* 报错：隐藏转圈、追加独立错误节点（message 可能含 hash，故不用 innerHTML） */
  function setLoadingError(message) {
    if (!loadingOverlay) return;
    var spinner = loadingOverlay.querySelector(".loading-spinner");
    var text = loadingOverlay.querySelector(".loading-text");
    if (spinner) spinner.style.display = "none";
    if (text) text.style.display = "none";
    var err = loadingOverlay.querySelector(".loading-error");
    if (!err) {
      err = document.createElement("div");
      err.className = "loading-error";
      loadingOverlay.appendChild(err);
    }
    err.textContent = message;
    loadingOverlay.classList.add("active");
    loadingOverlay.setAttribute("aria-hidden", "false");
  }

  /* 署名统一字号：取正文一半，最长署名块放不下时按列高封顶，不因空间不足而分列。 */
  function computeProvSize(tokens, colHeight, F) {
    var units = provUnits(tokens);
    var natural = F / 2;
    if (units <= 0) return natural;
    var cap = (colHeight - 1) / units; // 留 1px 余量，避免临界时被 layout 判为溢出
    return Math.max(8, Math.floor(Math.min(natural, cap) * 2) / 2);
  }

  /* 首次与切卷共用：token → layout → 渲染 → 修正 → 竖线；列高迭代收敛。 */
  function rebuild() {
    var res = resolveTokens(_cache, _currentPartId, _rawData);
    _cache = res.cache;
    var tokens = res.tokens;

    var colHeight = computeColHeight();
    if (colHeight <= 0) colHeight = 600;

    var cols = null;
    var provSize = 0;
    for (var pass = 0; pass < 3; pass++) {
      provSize = computeProvSize(tokens, colHeight, currentFontSize);
      document.documentElement.style.setProperty(
        "--prov-size",
        provSize + "px",
      );
      cols = layout(tokens, colHeight, currentFontSize, provSize);
      renderAll(cols);
      var actual = computeColHeight();
      if (Math.abs(actual - colHeight) < 0.5) break; // 已收敛
      colHeight = actual;
    }

    fixOverflow(cols, colHeight); // 需 DOM 才能在测量后弹 token
    renderReaderRules();
    wrapper.scrollLeft = wrapper.scrollWidth; // 竖排起始在最右
    restorePos(_currentPartId); // 若本卷有存档，覆盖到上次阅读位置
    return cols;
  }

  var PREF_KEY = "zztj:prefs";
  var POS_KEY = "zztj:pos";
  var currentTheme = "day";
  var posTimer = null;

  function storageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null; // 隐私模式/禁用 → 静默降级为仅本次会话有效
    }
  }

  function storageSet(key, val) {
    try {
      localStorage.setItem(key, val);
    } catch (e) {}
  }

  function readJSON(key) {
    var raw = storageGet(key);
    if (!raw) return null;
    try {
      var p = JSON.parse(raw);
      return p && typeof p === "object" ? p : null;
    } catch (e) {
      return null;
    }
  }

  function savePrefs() {
    storageSet(
      PREF_KEY,
      JSON.stringify({
        fontSize: currentFontSize,
        lineSpacing: currentLineSpacing,
        theme: currentTheme,
      }),
    );
  }

  function savePos() {
    if (!_currentPartId) return; // 尚未定位到任何卷（启动早期）→ 不写，避免污染存档
    var cols = reader.querySelectorAll(".col");
    if (!cols.length) return;
    storageSet(
      POS_KEY,
      JSON.stringify({
        partId: _currentPartId,
        anchorTokenIndex: currentLeftAnchor(cols),
        ts: Date.now(),
      }),
    );
  }

  /* 阅读起点锚点：取最左可见列的 startIndex（竖排自右向左读） */
  function currentLeftAnchor(colEls) {
    var wRect = wrapper.getBoundingClientRect();
    var eps = 1;
    var idx = null;
    for (var i = 0; i < colEls.length; i++) {
      var r = colEls[i].getBoundingClientRect();
      if (r.right > wRect.left + eps) {
        var v = parseInt(colEls[i].dataset.startIndex, 10);
        if (!isNaN(v)) idx = v;
      }
    }
    return idx === null ? 0 : idx;
  }

  /* 把某列左缘对齐到 wrapper 左缘；与 currentLeftAnchor 互逆，刷新不漂移。 */
  function scrollColToViewStart(colEl) {
    var wRect = wrapper.getBoundingClientRect();
    var cRect = colEl.getBoundingClientRect();
    var next = cRect.left - wRect.left + wrapper.scrollLeft;
    var max = wrapper.scrollWidth - wrapper.clientWidth;
    if (next < 0) next = 0;
    if (next > max) next = max;
    wrapper.scrollLeft = next;
  }

  function restorePos(partId) {
    var pos = readJSON(POS_KEY);
    if (!pos || pos.partId !== partId) return;
    var colEls = reader.querySelectorAll(".col");
    if (!colEls.length) return;
    var cols = [];
    for (var i = 0; i < colEls.length; i++) {
      cols.push({
        startIndex: parseInt(colEls[i].dataset.startIndex, 10) || 0,
      });
    }
    var target = findColForAnchor(cols, pos.anchorTokenIndex); // 越界已 clamp
    if (colEls[target]) scrollColToViewStart(colEls[target]);
  }

  function scheduleSavePos() {
    if (posTimer) clearTimeout(posTimer);
    posTimer = setTimeout(function () {
      posTimer = null;
      savePos();
    }, 200);
  }

  function loadManifest() {
    return fetch("json/index.json")
      .then(function (resp) {
        if (!resp.ok)
          throw new Error("無法載入目錄清單（HTTP " + resp.status + "）");
        return resp.json();
      })
      .then(function (doc) {
        _entries = (doc && doc.entries) || [];
        _entryMap = new Map();
        for (var i = 0; i < _entries.length; i++)
          _entryMap.set(_entries[i].file, _entries[i]);
        _prefetch = new Map();
        return _entries;
      });
  }

  function entryIndex(partId) {
    if (!_entries) return -1;
    for (var i = 0; i < _entries.length; i++)
      if (_entries[i].file === partId) return i;
    return -1;
  }

  function updateHeader(partId) {
    var entry = _entryMap ? _entryMap.get(partId) : null;
    var titleEl = document.getElementById("headerTitle");
    if (titleEl) titleEl.textContent = entry ? entry.title : partId;

    var i = entryIndex(partId);
    var prevBtn = document.getElementById("btnPrevVol");
    var nextBtn = document.getElementById("btnNextVol");
    if (prevBtn) prevBtn.disabled = !(i > 0);
    if (nextBtn) nextBtn.disabled = !(i >= 0 && i < _entries.length - 1);
  }

  /* 地址栏不留卷号 hash：卷位置改由 localStorage 记忆，代价是没有深链与逐卷历史。 */
  function stripHash() {
    if (location.hash === "") return;
    // /index.html → / ：让地址栏回到站点根（用户要求显示 http://localhost:8000/）
    var path = location.pathname.replace(/\/index\.html?$/, "/");
    history.replaceState(null, "", path + location.search);
  }

  /* 切卷：缓存必失效（§4.3 重点 1）；预取命中则跳过 toTokens（§4.6） */
  function goTo(partId) {
    if (!partId) return Promise.resolve();
    if (_stylePhase === "running") return Promise.resolve(); // 执行中不切卷，避免打断重排
    if (_volumeLoading > 0) return Promise.resolve(); // 切卷进行中：忽略新的切卷请求
    savePos(); // 切卷前先存本卷阅读位置（此刻 _currentPartId 仍为旧卷）
    _volumeLoading++;
    syncControls(); // 切卷同样要重排：立即禁用全部 9 个控件
    cancelScheduledStyle(); // 只关窗口；未提交的 pending 保留给新卷
    showLoading();

    var hit = _prefetch && _prefetch.has(partId) ? _prefetch.get(partId) : null;
    if (hit) {
      _prefetch.delete(partId);
      _prefetch.set(partId, hit); // LRU：移到最近使用端
      _cache = { partId: partId, tokens: hit.tokens }; // 命中即跳过 toTokens
    }

    var load = hit ? Promise.resolve(hit.data) : loadVolume(partId);

    return load
      .then(function (data) {
        // 预取命中时数据同任务可用，直接重排会来不及绘制遮罩；等下一帧再排。
        return new Promise(function (resolve) {
          requestAnimationFrame(function () {
            setTimeout(resolve, 0);
          });
        }).then(function () {
          try {
            _rawData = data;
            _currentPartId = partId;
            if (!hit) _cache = resolveTokens(_cache, partId, data).cache; // 切卷必重建
            flushPendingStyle(); // 先吸收待提交的字号/行距，新卷只排一次
            rebuild(); // 内含 restorePos(_currentPartId)
          } finally {
            // 重建完成（或异常）后立刻恢复控件
            if (_volumeLoading > 0) _volumeLoading--;
            syncControls();
          }
          hideLoading();
          stripHash();
          updateHeader(partId);
          schedulePrefetch();
        });
      })
      .catch(function (err) {
        if (_volumeLoading > 0) _volumeLoading--;
        syncControls();
        if (_stylePhase === "pending") {
          // 切卷失败：本卷保持原样，丢弃这次未能提交的连点
          pendingFontSize = null;
          pendingLineSpacing = null;
          _pendingAction = null;
          _stylePhase = "idle";
        }
        setLoadingError(
          "無法載入 " +
            partId +
            "：" +
            (err && err.message ? err.message : err),
        );
      });
  }

  function next() {
    var i = entryIndex(_currentPartId);
    if (i >= 0 && i < _entries.length - 1) return goTo(_entries[i + 1].file);
  }

  function prev() {
    var i = entryIndex(_currentPartId);
    if (i > 0) return goTo(_entries[i - 1].file);
  }

  function trimPrefetch() {
    while (_prefetch.size > MAX_PREFETCH) {
      var oldest = _prefetch.keys().next().value;
      _prefetch.delete(oldest);
    }
  }

  function prefetchCandidates() {
    var i = entryIndex(_currentPartId);
    if (i < 0) return [];
    var out = [];
    if (i + 1 < _entries.length) out.push(_entries[i + 1].file); // 下一卷优先
    if (i - 1 >= 0) out.push(_entries[i - 1].file);
    return out;
  }

  /* 同刻至多 1 个后台请求、不触发遮罩；失败静默（规格 §4.6/§9） */
  function schedulePrefetch() {
    if (_prefetching || !_entries) return;
    var targets = prefetchCandidates();
    for (var i = 0; i < targets.length; i++) {
      var p = targets[i];
      if (p === _currentPartId || _prefetch.has(p)) continue;
      runPrefetch(p);
      return;
    }
  }

  function runPrefetch(partId) {
    _prefetching = partId;
    loadVolume(partId)
      .then(function (data) {
        if (partId === _currentPartId) return; // 用户已切到该卷 → 无需入缓存
        var tokens = resolveTokens(null, partId, data).tokens;
        _prefetch.set(partId, { tokens: tokens, data: data });
        trimPrefetch();
      })
      .catch(function () {})
      .then(function () {
        _prefetching = null;
        schedulePrefetch();
      });
  }

  /* 每卷标题独占一列；复用正文的 .col / .rules 机制 */
  function renderTocCols(inner) {
    inner.innerHTML = "";
    var current = null;
    for (var i = 0; i < _entries.length; i++) {
      var e = _entries[i];
      var isCurrent = e.file === _currentPartId;
      var col = document.createElement("div");
      col.className = "col no-stretch toc-col" + (isCurrent ? " current" : "");
      col.dataset.file = e.file;
      var title = e.title || ""; // 卷题全称（§8.1）
      var titleChars = [];
      pushString(titleChars, title, null); // 同正文：按码点逐字，BMP 外字符不拆
      for (var c = 0; c < titleChars.length; c++) {
        var ch = document.createElement("div");
        ch.className = "char";
        ch.textContent = titleChars[c].char;
        col.appendChild(ch);
      }
      if (isCurrent) current = col;
      inner.appendChild(col);
    }
    return current;
  }

  function openToc() {
    var panel = document.getElementById("tocPanel");
    var overlay = document.getElementById("tocOverlay");
    if (!panel || !overlay || !_entries) return;

    panel.innerHTML = "";
    var inner = document.createElement("div");
    inner.className = "reader"; // 与正文同构，自带外框与定位容器
    var current = renderTocCols(inner);
    panel.appendChild(inner);
    renderRules(inner, inner.querySelectorAll(".col"));

    overlay.classList.add("active");
    overlay.setAttribute("aria-hidden", "false");
    panel.scrollTop = 0;
    panel.scrollLeft = panel.scrollWidth; // 竖排自最右（序档）起读
    if (current && current.scrollIntoView)
      current.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function closeToc() {
    var overlay = document.getElementById("tocOverlay");
    if (!overlay) return;
    overlay.classList.remove("active");
    overlay.setAttribute("aria-hidden", "true");
  }

  function tocActive() {
    var overlay = document.getElementById("tocOverlay");
    return !!(overlay && overlay.classList.contains("active"));
  }

  function defaultFontSize() {
    return window.matchMedia("(max-width:640px)").matches ? 32 : 42;
  }

  function relayout() {
    showLoading();
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        rebuild();
        hideLoading();
      });
    });
  }

  function clampFontSize(size) {
    size = Math.round(size);
    if (size < 18) size = 18;
    if (size > 72) size = 72;
    return size;
  }

  function clampLineSpacing(v) {
    v = Math.round(v * 10) / 10;
    if (v < 1.1) v = 1.1;
    if (v > 3.0) v = 3.0;
    return v;
  }

  /* 关闭 150ms 合并窗口的计时器（不清 pending：切卷时要把值带到新卷）。 */
  function cancelScheduledStyle() {
    if (styleTimer) {
      clearTimeout(styleTimer);
      styleTimer = null;
    }
  }

  function pendingHasChange() {
    return (
      (pendingFontSize !== null && pendingFontSize !== currentFontSize) ||
      (pendingLineSpacing !== null && pendingLineSpacing !== currentLineSpacing)
    );
  }

  function accumulatePending(fontDelta, lineDelta) {
    if (fontDelta) {
      var baseFont =
        pendingFontSize !== null ? pendingFontSize : currentFontSize;
      pendingFontSize = clampFontSize(baseFont + fontDelta);
    }
    if (lineDelta) {
      var baseLine =
        pendingLineSpacing !== null ? pendingLineSpacing : currentLineSpacing;
      pendingLineSpacing = clampLineSpacing(baseLine + lineDelta);
    }
  }

  function clearStyleWindow() {
    cancelScheduledStyle();
    pendingFontSize = null;
    pendingLineSpacing = null;
    _pendingAction = null;
    _stylePhase = "idle";
  }

  /* 按状态计算控件可用性：running 或切卷加载时禁用 9 个控件，☰ 除外。 */
  function syncControls() {
    var disabled = _stylePhase === "running" || _volumeLoading > 0;
    for (var i = 0; i < ALL_CONTROL_IDS.length; i++) {
      var el = document.getElementById(ALL_CONTROL_IDS[i]);
      if (el) el.disabled = disabled;
    }
  }

  /* 展开移动端菜单时抬高遮罩起点，避免合并窗口内菜单被遮罩盖住。 */
  function setMobileMenuOpen(open) {
    var controls = document.getElementById("headerControls");
    var menu = document.getElementById("btnMenu");
    if (!controls) return;
    controls.classList.toggle("open", !!open);
    if (menu) menu.setAttribute("aria-expanded", open ? "true" : "false");

    var root = document.documentElement;
    if (open) {
      var bottom = Math.round(controls.getBoundingClientRect().bottom);
      if (bottom > 0) root.style.setProperty("--loading-top", bottom + "px");
    } else {
      root.style.removeProperty("--loading-top");
    }
  }

  function closeMobileMenu() {
    setMobileMenuOpen(false);
  }

  /* 重排期间排队的点击会在结束后才派发，用时间戳识别并丢弃。 */
  function isStaleStyleClick(ts) {
    return (
      !!ts &&
      _styleExecStart > 0 &&
      _styleExecEnd > 0 &&
      ts >= _styleExecStart &&
      ts <= _styleExecEnd
    );
  }

  /* 等两帧让遮罩先绘制，再执行一次重排；finally 保证按钮与状态一定恢复。 */
  function runRebuildGuarded(applyFn) {
    _styleExecStart = performance.now();
    _styleExecEnd = 0;
    showLoading();
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        try {
          applyFn();
        } finally {
          _styleExecEnd = performance.now();
          pendingFontSize = null;
          pendingLineSpacing = null;
          _pendingAction = null;
          _stylePhase = "idle";
          syncControls(); // 重排异常也必须恢复控件
          hideLoading();
        }
      });
    });
  }

  /* 重新安排窗口到期时间：必须先清掉旧计时器，否则连点步数会被提前提交。 */
  function scheduleStyleExecution(windowMs) {
    cancelScheduledStyle();
    styleTimer = setTimeout(function () {
      styleTimer = null;
      startStyleExecution();
    }, windowMs);
  }

  /* 按输入方式取窗口：键盘 click 无 pointerType（detail=0），其余用按下类型兜底。 */
  function styleWindowMs(ev) {
    if (ev && ev.detail === 0) return STYLE_DEBOUNCE_KEYBOARD;
    var type = ev && ev.pointerType ? ev.pointerType : _lastPointerType;
    if (type === "mouse") return STYLE_DEBOUNCE_MOUSE;
    if (type === "touch" || type === "pen") return STYLE_DEBOUNCE_TOUCH;
    return STYLE_DEBOUNCE_TOUCH;
  }

  /* 窗口到期或点到异类按钮：进入执行阶段，立即禁用全部控件，只重排一次。 */
  function startStyleExecution() {
    if (_stylePhase !== "pending") return;
    cancelScheduledStyle();
    if (!pendingHasChange()) {
      clearStyleWindow();
      hideLoading();
      return;
    }
    _stylePhase = "running";
    syncControls(); // pending 一结束就禁用 9 个控件，早于等帧
    closeMobileMenu(); // 窗口结束：收起移动端菜单
    runRebuildGuarded(function () {
      var changed = applyPendingStyle();
      if (changed.font) rebuild();
      else {
        renderReaderRules(); // 行距只动列宽与竖线
        restorePos(_currentPartId);
      }
    });
  }

  /* 点击/快捷键唯一入口：窗口内同一按钮累积步数，异类按钮丢弃本请求并立即执行。 */
  function requestStyleChange(action, fontDelta, lineDelta, windowMs) {
    if (_stylePhase === "running") return; // 执行中：所有样式点击弃置
    if (_volumeLoading) return; // 切卷加载中：弃置
    if (!windowMs) windowMs = STYLE_DEBOUNCE_TOUCH;

    if (_stylePhase === "pending") {
      if (_pendingAction !== action) {
        startStyleExecution(); // 丢弃新按钮的请求
        return;
      }
      accumulatePending(fontDelta, lineDelta);
      if (!pendingHasChange()) {
        clearStyleWindow();
        hideLoading();
        return;
      }
      scheduleStyleExecution(windowMs);
      pulseLoadingFeedback(); // 每次被接受的点击都重播反馈
      return;
    }

    // idle：开启合并窗口
    pendingFontSize = null;
    pendingLineSpacing = null;
    _pendingAction = action;
    accumulatePending(fontDelta, lineDelta);
    if (!pendingHasChange()) {
      // 已到上下限：没有实际变化，不显示加载
      clearStyleWindow();
      return;
    }
    _stylePhase = "pending";
    showLoading();
    pulseLoadingFeedback();
    scheduleStyleExecution(windowMs);
  }

  /* 把 pending 值一次性写入已应用状态与 CSS 变量；调用方负责随后的重排/重画。 */
  function applyPendingStyle() {
    var fontChanged =
      pendingFontSize !== null && pendingFontSize !== currentFontSize;
    var lineChanged =
      pendingLineSpacing !== null && pendingLineSpacing !== currentLineSpacing;

    if (fontChanged) {
      currentFontSize = pendingFontSize;
      _userChangedFont = true;
      document.documentElement.style.setProperty(
        "--font-size",
        currentFontSize + "px",
      );
    }
    if (lineChanged) {
      currentLineSpacing = pendingLineSpacing;
      document.documentElement.style.setProperty(
        "--line-spacing",
        String(currentLineSpacing),
      );
    }
    if (fontChanged || lineChanged) savePrefs();

    pendingFontSize = null;
    pendingLineSpacing = null;
    return { font: fontChanged, line: lineChanged };
  }

  /* 切卷/卸载前吸收尚未提交的样式值（不触发额外重排）。 */
  function flushPendingStyle() {
    if (_stylePhase === "running") return; // 执行中的值由执行路径保存
    cancelScheduledStyle();
    if (pendingFontSize !== null || pendingLineSpacing !== null) {
      applyPendingStyle();
    }
    _pendingAction = null;
    _stylePhase = "idle";
  }

  function resetAll() {
    if (_stylePhase === "running") return; // 执行中：弃置本次重置
    if (_volumeLoading) return;
    if (_stylePhase === "pending") {
      // 重置属于另一个按钮：丢弃重置请求，立即执行已累积的样式
      startStyleExecution();
      return;
    }

    _stylePhase = "running";
    syncControls();
    closeMobileMenu();
    pendingFontSize = null;
    pendingLineSpacing = null;
    _pendingAction = null;
    // 先让「正在重排」遮罩绘制，再写入新值并重排，避免中间态被画出来。
    runRebuildGuarded(function () {
      currentFontSize = defaultFontSize();
      currentLineSpacing = 1.6;
      _userChangedFont = false; // 重置后重新跟随默认字号（§8.2）
      document.documentElement.style.setProperty(
        "--font-size",
        currentFontSize + "px",
      );
      document.documentElement.style.setProperty("--line-spacing", "1.6");
      savePrefs();
      rebuild();
    });
    pulseLoadingFeedback(); // 每次被接受的点击都重新给一次反馈
  }

  function applyTheme(theme) {
    currentTheme = theme === "night" ? "night" : "day";
    document.documentElement.dataset.theme = currentTheme;
    var btn = document.getElementById("btnTheme");
    if (btn) btn.textContent = currentTheme === "night" ? "日間" : "夜間";
  }

  function prefersDark() {
    return (
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    );
  }

  function bindEvents() {
    document.addEventListener(
      "pointerdown",
      function (e) {
        _lastPointerType = e.pointerType || "";
      },
      true,
    );

    wrapper.addEventListener("scroll", scheduleSavePos, { passive: true });

    wrapper.addEventListener(
      "wheel",
      function (e) {
        if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return; // 已是横向意图
        e.preventDefault();
        var factor = e.deltaMode === 1 ? 20 : 1;
        // 竖排从右向左读：向下滚轮 = 前进 = 视图在内容上左移（scrollLeft 减小）
        wrapper.scrollLeft -= e.deltaY * factor;
      },
      { passive: false },
    );

    var resizeTimer = null;
    window.addEventListener("resize", function () {
      showLoading();
      var hc = document.getElementById("headerControls");
      if (hc && hc.classList.contains("open")) setMobileMenuOpen(true); // 重算遮罩起点
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        resizeTimer = null;
        // 未手动改过字号 → 跨 640px 断点跟随新默认值；已改过则保持（规格 §8.2）
        if (!_userChangedFont) {
          var d = defaultFontSize();
          if (d !== currentFontSize) {
            currentFontSize = d;
            document.documentElement.style.setProperty("--font-size", d + "px");
          }
        }
        relayout();
      }, 120);
    });

    window.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && tocActive()) {
        e.preventDefault();
        closeToc();
        return;
      }
      // 目录打开时屏蔽翻卷与字号快捷键，避免面板留下而底层卷已变
      if (tocActive()) return;
      if (e.ctrlKey || e.metaKey) {
        var k = e.key;
        if (k === "+" || k === "=") {
          e.preventDefault();
          if (isStaleStyleClick(e.timeStamp)) return;
          requestStyleChange("font-inc", 2, 0, styleWindowMs(e));
        } else if (k === "-" || k === "_") {
          e.preventDefault();
          if (isStaleStyleClick(e.timeStamp)) return;
          requestStyleChange("font-dec", -2, 0, styleWindowMs(e));
        } else if (k === "0") {
          e.preventDefault();
          if (isStaleStyleClick(e.timeStamp)) return;
          resetAll();
        }
        return;
      }
      // 竖排从右向左读：向左/下为前进，故 ←/PageDown = 下一卷
      if (e.key === "PageDown" || e.key === "ArrowLeft") {
        e.preventDefault();
        if (_stylePhase === "pending") {
          startStyleExecution(); // 窗口内其它操作：丢弃本请求并立即提交
          return;
        }
        next();
      } else if (e.key === "PageUp" || e.key === "ArrowRight") {
        e.preventDefault();
        if (_stylePhase === "pending") {
          startStyleExecution();
          return;
        }
        prev();
      }
    });

    window.addEventListener("hashchange", function () {
      var id = location.hash.slice(1);
      if (id && id !== _currentPartId) goTo(id);
    });

    window.addEventListener("beforeunload", function () {
      savePos();
      flushPendingStyle(); // 防抖窗口内关闭页面也不丢偏好
    });

    var menu = document.getElementById("btnMenu");
    var controls = document.getElementById("headerControls");

    var btns = {
      btnPrevVol: function () {
        prev();
      },
      btnNextVol: function () {
        next();
      },
      btnFontDec: function (e) {
        requestStyleChange("font-dec", -2, 0, styleWindowMs(e));
      },
      btnFontInc: function (e) {
        requestStyleChange("font-inc", 2, 0, styleWindowMs(e));
      },
      btnLineNarrow: function (e) {
        requestStyleChange("line-dec", 0, -0.1, styleWindowMs(e));
      },
      btnLineWide: function (e) {
        requestStyleChange("line-inc", 0, 0.1, styleWindowMs(e));
      },
      btnReset: function () {
        resetAll();
      },
      btnTheme: function () {
        applyTheme(currentTheme === "night" ? "day" : "night");
      },
      btnToc: function () {
        openToc();
      },
    };
    Object.keys(btns).forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("click", function (e) {
        if (
          STYLE_BUTTON_IDS.indexOf(id) !== -1 &&
          isStaleStyleClick(e.timeStamp)
        ) {
          return;
        }
        // pending 窗口内只接受发起按钮；其它按钮丢弃其请求并立即提交已累积步数。
        if (_stylePhase === "pending" && STYLE_BUTTON_IDS.indexOf(id) === -1) {
          startStyleExecution();
          return;
        }
        btns[id](e);
        // 移动端：样式按钮在合并窗口内保持菜单展开；其余控件仍收起。
        var keepMenuOpen =
          _stylePhase === "pending" &&
          (id === "btnFontDec" ||
            id === "btnFontInc" ||
            id === "btnLineNarrow" ||
            id === "btnLineWide");
        if (!keepMenuOpen) setMobileMenuOpen(false);
      });
    });

    if (menu && controls) {
      menu.addEventListener("click", function () {
        setMobileMenuOpen(!controls.classList.contains("open"));
      });
    }

    var tocClose = document.getElementById("btnTocClose");
    if (tocClose) tocClose.addEventListener("click", closeToc);
    var panel = document.getElementById("tocPanel");
    if (panel) {
      // 目录横向拖动：方向与 scrollLeft 相反；超过 3px 才进入拖动并抑制随后的 click。
      var drag = null;
      var suppressNextClick = false;
      panel.addEventListener("pointerdown", function (e) {
        if (e.pointerType !== "mouse" || e.button !== 0) return;
        suppressNextClick = false; // 新的按下 = 新的意图，解除上一次的抑制
        drag = {
          x: e.clientX,
          left: panel.scrollLeft,
          moved: false,
          id: e.pointerId,
        };
      });
      panel.addEventListener("pointermove", function (e) {
        if (!drag || e.pointerId !== drag.id) return;
        var dx = e.clientX - drag.x;
        if (!drag.moved) {
          if (Math.abs(dx) <= 3) return;
          drag.moved = true;
          panel.classList.add("dragging");
          try {
            if (panel.setPointerCapture) panel.setPointerCapture(e.pointerId);
          } catch (_e) {}
        }
        panel.scrollLeft = drag.left - dx;
      });
      function endDrag(e) {
        if (!drag || e.pointerId !== drag.id) return;
        try {
          if (panel.hasPointerCapture && panel.hasPointerCapture(e.pointerId))
            panel.releasePointerCapture(e.pointerId);
        } catch (_e) {}
        var moved = drag.moved;
        drag = null;
        panel.classList.remove("dragging");
        if (moved) suppressNextClick = true; // 只吞掉紧随拖动的那次 click
      }
      panel.addEventListener("pointerup", endDrag);
      panel.addEventListener("pointercancel", endDrag);

      // 滚轮纵向滚动也转为横向翻目录（目录纵向无溢出）
      panel.addEventListener(
        "wheel",
        function (e) {
          if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
          e.preventDefault();
          var factor = e.deltaMode === 1 ? 20 : 1;
          panel.scrollLeft -= e.deltaY * factor;
        },
        { passive: false },
      );

      panel.addEventListener("click", function (e) {
        if (suppressNextClick) {
          suppressNextClick = false;
          return;
        }
        // 重排/切卷加载期间不响应卷题点击：保持目录打开，避免“关了目录却没跳卷”
        if (_stylePhase === "running" || _volumeLoading > 0) return;
        var col =
          e.target && e.target.closest ? e.target.closest(".toc-col") : null;
        if (!col) return; // 空白处不动作（关闭请用「關閉」或 Esc）
        closeToc();
        goTo(col.dataset.file);
      });
    }
  }

  function loadVolume(partId) {
    return fetch("json/" + partId + ".json").then(function (resp) {
      if (!resp.ok)
        throw new Error(
          "无法加载 " + partId + ".json（HTTP " + resp.status + "）",
        );
      return resp.json();
    });
  }

  /* 首排必须显式 load Web 字体：回退字体度量不同，且 fonts.ready 在使用前已 resolve。 */
  var FONT_SPECS = [
    "42px 'FZDBSK'",
    "42px 'FZXBS'",
    "42px 'FZSKBXK'",
    "42px 'HYFangSongS'",
    "28px 'Arial'",
    "42px 'WenJinMincho'",
  ];
  var FONT_SAMPLE = "資治通鑑卷第一臣光曰週威烈王皰夋一二三○，。";

  function ensureFonts() {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    return Promise.all(
      FONT_SPECS.map(function (spec) {
        return document.fonts.load(spec, FONT_SAMPLE);
      }),
    ).catch(function () {
      return null; // 字体缺失不该阻断正文显示
    });
  }

  function init() {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        var prefs = readJSON(PREF_KEY);
        currentFontSize =
          prefs && typeof prefs.fontSize === "number"
            ? prefs.fontSize
            : defaultFontSize();
        _userChangedFont = !!(prefs && typeof prefs.fontSize === "number");
        currentLineSpacing =
          prefs && typeof prefs.lineSpacing === "number"
            ? prefs.lineSpacing
            : 1.6;
        // 主题默认跟随系统偏好，有 prefs 则以 prefs 为准
        applyTheme(
          prefs && prefs.theme ? prefs.theme : prefersDark() ? "night" : "day",
        );
        document.documentElement.style.setProperty(
          "--font-size",
          currentFontSize + "px",
        );
        document.documentElement.style.setProperty(
          "--line-spacing",
          String(currentLineSpacing),
        );

        bindEvents();

        // 启动顺序：hash → 存档 partId → 默认 part0003
        var pos = readJSON(POS_KEY);
        var startId =
          location.hash.slice(1) || (pos && pos.partId) || "part0003";

        showLoading();
        Promise.all([loadManifest(), ensureFonts()])
          .then(function () {
            return goTo(startId);
          })
          .catch(function (err) {
            setLoadingError(
              "無法載入 " +
                startId +
                "：" +
                (err && err.message ? err.message : err),
            );
          });
      });
    });
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();
})();
