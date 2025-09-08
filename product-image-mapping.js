
/*!
 * product-image-mapping.js
 * 讓「產品類別」選項改變時，自動切換「參考簡圖」。
 * 不需改動既有程式，只要把本檔案放到 index.html 並在底部以 <script defer> 載入即可。
 * 若想更精準，建議在 HTML 上標註 data-product-category-select 與 data-reference-image。
 */
(function () {
  "use strict";

  // ---- 可調整：圖片所在的相對路徑 (若圖片與 index.html 在同一層，維持空字串即可) ----
  var IMG_BASE = ""; // 例如 "assets/"

  // ---- 規則：對應「產品類別」→ 應顯示的圖片檔名 ----
  // 注意：中文/英文/大小寫/底線空白都會做標準化處理，並有關鍵字規則做容錯。
  var RULES = {
    // 塞子 / Plug
    "塞子": "plug.jpg",
    "plug": "plug.jpg",

    // 管子 - H/A/B type → H 用 sleeve_H.jpg；A/B 用 sleeve_A.jpg
    "管子_h": "sleeve_H.jpg",
    "sleeve_h": "sleeve_H.jpg",
    "管子_a": "sleeve_A.jpg",
    "sleeve_a": "sleeve_A.jpg",
    "管子_b": "sleeve_A.jpg",
    "sleeve_b": "sleeve_A.jpg",

    // 成品 - H/A/B type → H 用 finish_H.jpg；A/B 用 finish_A.jpg
    "成品_h": "finish_H.jpg",
    "finish_h": "finish_H.jpg",
    "成品_a": "finish_A.jpg",
    "finish_a": "finish_A.jpg",
    "成品_b": "finish_A.jpg",
    "finish_b": "finish_A.jpg",

    // 內迫工具 / Special Tool
    "內迫工具": "special_tool.jpg",
    "內脹工具": "special_tool.jpg",
    "內胀工具": "special_tool.jpg",
    "special_tool": "special_tool.jpg",
    "special tool": "special_tool.jpg",
    "expansion tool": "special_tool.jpg"
  };

  // 預設圖 (找不到對應時)
  var DEFAULT_IMG = "final_finished.jpg";

  // ---- 工具：標準化字串 ----
  function norm(s) {
    if (!s) return "";
    // 轉小寫、去前後空白
    s = String(s).toLowerCase().trim();
    // 轉全形空白 → 半形、移除多餘符號
    s = s
      .replace(/\u3000/g, " ")
      .replace(/[()（）]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/-/g, " ")
      .replace(/type/g, "") // 忽略 "type" 字眼
      .replace(/_/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // 合併常見寫法：例如 "管子 h", "管子_h" → "管子_h"
    s = s.replace(/\s*h\b/, "_h").replace(/\s*a\b/, "_a").replace(/\s*b\b/, "_b");
    // 英文 sleeve h/a/b
    s = s.replace(/\bsleeve\s*h\b/, "sleeve_h")
         .replace(/\bsleeve\s*a\b/, "sleeve_a")
         .replace(/\bsleeve\s*b\b/, "sleeve_b")
         .replace(/\bfinish\s*h\b/, "finish_h")
         .replace(/\bfinish\s*a\b/, "finish_a")
         .replace(/\bfinish\s*b\b/, "finish_b");

    return s;
  }

  // ---- 找到「產品類別」那個 select：
  // 策略：
  // 1) 先找 [data-product-category-select]（若你願意在 HTML 標上這個屬性，辨識最穩）
  // 2) 否則掃描頁面所有 <select>，找其 options 是否包含我們關心的關鍵字（匹配度最高者）
  function findCategorySelect() {
    var byAttr = document.querySelector('select[data-product-category-select]');
    if (byAttr) return byAttr;

    var selects = Array.from(document.querySelectorAll("select"));
    var targets = ["塞子","管子","成品","內迫","內脹","內胀","plug","sleeve","finish","special","tool"];
    var best = null, bestScore = 0;

    selects.forEach(function(sel) {
      var score = 0;
      Array.from(sel.options).forEach(function(opt) {
        var text = (opt.textContent || opt.label || "").toLowerCase();
        targets.forEach(function(t){
          if (text.includes(t)) score++;
        });
        // 額外加分：若完全命中明確詞
        var n = norm(opt.textContent || opt.label || opt.value || "");
        if (RULES[n]) score += 2;
      });
      if (score > bestScore) { best = sel; bestScore = score; }
    });

    return best;
  }

  // ---- 找到「參考簡圖」那張 <img>：
  // 策略：
  // 1) 先找 [data-reference-image]
  // 2) 再找 id / 常見 selector
  // 3) 再找目前 src 含有 final_finished.jpg 的 <img>
  // 4) 最後保底：抓頁面第一張 <img>
  function findReferenceImg() {
    var cands = [
      'img[data-reference-image]',
      '#referenceImage',
      '#reference-image',
      'img[alt*="參考"]',
      'img[alt*="参考"]',
      'img[alt*="reference"]',
      'img[src*="final_finished.jpg" i]'
    ];
    for (var i = 0; i < cands.length; i++) {
      var el = document.querySelector(cands[i]);
      if (el) return el;
    }
    return document.querySelector("img");
  }

  // ---- 預載所有可能的圖片，減少切換閃爍 ----
  function preloadAllImages() {
    var files = Array.from(new Set(Object.values(RULES).concat([DEFAULT_IMG])));
    files.forEach(function(fn){
      var img = new Image();
      img.src = IMG_BASE + fn;
    });
  }

  // ---- 依選項文字判斷應切換的圖片檔名 ----
  function pickImageByLabel(label) {
    var n = norm(label);
    // 先嘗試直接對應
    if (RULES[n]) return RULES[n];

    // 規則容錯：包含關鍵詞的情形
    var has = function(word){ return n.includes(word); };

    // 塞子
    if (has("塞子") || has("plug")) return "plug.jpg";

    // 管子：H → sleeve_H；A/B → sleeve_A
    if (has("管子") || has("sleeve")) {
      if (/\bh\b|_h\b/.test(n)) return "sleeve_H.jpg";
      if (/\ba\b|_a\b/.test(n)) return "sleeve_A.jpg";
      if (/\bb\b|_b\b/.test(n)) return "sleeve_A.jpg"; // B 規則和 A 相同
    }

    // 成品：H → finish_H；A/B → finish_A
    if (has("成品") || has("finish")) {
      if (/\bh\b|_h\b/.test(n)) return "finish_H.jpg";
      if (/\ba\b|_a\b/.test(n)) return "finish_A.jpg";
      if (/\bb\b|_b\b/.test(n)) return "finish_A.jpg"; // B 規則和 A 相同
    }

    // 內迫工具 / special tool
    if (has("內迫") || has("內脹") || has("內胀") || (has("special") && has("tool")) || has("expansion tool")) {
      return "special_tool.jpg";
    }

    // 預設
    return DEFAULT_IMG;
  }

  // ---- 切換圖片 ----
  function updateRefImage(selectEl, imgEl) {
    if (!selectEl || !imgEl) return;
    var opt = selectEl.selectedOptions && selectEl.selectedOptions[0];
    var label = opt ? (opt.textContent || opt.label || opt.value) : (selectEl.value || "");
    var file = pickImageByLabel(label);

    // 若已是正確圖片則不動
    var targetSrc = IMG_BASE + file;
    if (imgEl.getAttribute("src") !== targetSrc) {
      imgEl.setAttribute("src", targetSrc);
      // 順手更新 alt，利於無障礙與多語系
      var langLabel = (label || "").trim();
      if (langLabel) {
        imgEl.setAttribute("alt", "參考簡圖 - " + langLabel);
        imgEl.setAttribute("aria-label", "參考簡圖 - " + langLabel);
      }
    }
  }

  // ---- 初始化 ----
  function init() {
    var sel = findCategorySelect();
    var img = findReferenceImg();
    if (!sel || !img) return;

    preloadAllImages();           // 預載圖片
    updateRefImage(sel, img);     // 進頁面先套用一次

    // 監聽變更
    sel.addEventListener("change", function(){ updateRefImage(sel, img); });

    // 若頁面有語言切換、或是框架動態重繪，可視情況也監聽 input / blur / click
    ["input","blur"].forEach(function(evt){
      sel.addEventListener(evt, function(){ updateRefImage(sel, img); });
    });

    // 暴露到全域：你也可以在其它腳本顧及初始化後手動呼叫 window.__updateRefImage()
    window.__updateRefImage = function(){ updateRefImage(sel, img); };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
