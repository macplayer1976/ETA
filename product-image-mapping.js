
/*! product-image-mapping.js (auto-wired) */
(function () {
  "use strict";
  var IMG_BASE = ""; // 若圖片在子資料夾，改成例如 "assets/"

  var RULES = {
    "塞子": "plug.jpg",
    "plug": "plug.jpg",
    "管子_h": "sleeve_H.jpg",
    "sleeve_h": "sleeve_H.jpg",
    "管子_a": "sleeve_A.jpg",
    "sleeve_a": "sleeve_A.jpg",
    "管子_b": "sleeve_A.jpg",
    "sleeve_b": "sleeve_A.jpg",
    "成品_h": "finish_H.jpg",
    "finish_h": "finish_H.jpg",
    "成品_a": "finish_A.jpg",
    "finish_a": "finish_A.jpg",
    "成品_b": "finish_A.jpg",
    "finish_b": "finish_A.jpg",
    "內迫工具": "special_tool.jpg",
    "內脹工具": "special_tool.jpg",
    "內胀工具": "special_tool.jpg",
    "special_tool": "special_tool.jpg",
    "special tool": "special_tool.jpg",
    "expansion tool": "special_tool.jpg"
  };
  var DEFAULT_IMG = "final_finished.jpg";

  function norm(s) {
    if (!s) return "";
    s = String(s).toLowerCase().trim();
    s = s.replace(/\u3000/g, " ")
         .replace(/[()（）]/g, " ")
         .replace(/\s+/g, " ")
         .replace(/-/g, " ")
         .replace(/type/g, "")
         .replace(/_/g, " ")
         .replace(/\s+/g, " ")
         .trim();
    s = s.replace(/\s*h\b/, "_h").replace(/\s*a\b/, "_a").replace(/\s*b\b/, "_b");
    s = s.replace(/\bsleeve\s*h\b/, "sleeve_h")
         .replace(/\bsleeve\s*a\b/, "sleeve_a")
         .replace(/\bsleeve\s*b\b/, "sleeve_b")
         .replace(/\bfinish\s*h\b/, "finish_h")
         .replace(/\bfinish\s*a\b/, "finish_a")
         .replace(/\bfinish\s*b\b/, "finish_b");
    return s;
  }

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
        targets.forEach(function(t){ if (text.includes(t)) score++; });
        var n = norm(opt.textContent || opt.label || opt.value || "");
        if (RULES[n]) score += 2;
      });
      if (score > bestScore) { best = sel; bestScore = score; }
    });
    return best;
  }

  function findReferenceImg() {
    var byAttr = document.querySelector('img[data-reference-image]');
    if (byAttr) return byAttr;
    var candidates = Array.from(document.querySelectorAll("img"));
    // Prefer one whose src or alt mentions final_finished / 參考 / reference
    var preferred = candidates.find(function(img){
      var src = (img.getAttribute("src") || "").toLowerCase();
      var alt = (img.getAttribute("alt") || "").toLowerCase();
      return src.includes("final_finished") || alt.includes("參考") || alt.includes("参考") || alt.includes("reference");
    });
    return preferred || candidates[0] || null;
  }

  function pickImageByLabel(label) {
    var n = norm(label);
    if (RULES[n]) return RULES[n];
    var has = function(word){ return n.includes(word); };
    if (has("塞子") || has("plug")) return "plug.jpg";
    if (has("管子") || has("sleeve")) {
      if (/\bh\b|_h\b/.test(n)) return "sleeve_H.jpg";
      if (/\ba\b|_a\b/.test(n)) return "sleeve_A.jpg";
      if (/\bb\b|_b\b/.test(n)) return "sleeve_A.jpg";
    }
    if (has("成品") || has("finish")) {
      if (/\bh\b|_h\b/.test(n)) return "finish_H.jpg";
      if (/\ba\b|_a\b/.test(n)) return "finish_A.jpg";
      if (/\bb\b|_b\b/.test(n)) return "finish_A.jpg";
    }
    if (has("內迫") || has("內脹") || has("內胀") || (has("special") && has("tool")) || has("expansion tool")) {
      return "special_tool.jpg";
    }
    return DEFAULT_IMG;
  }

  function updateRefImage(sel, img) {
    if (!sel || !img) return;
    var opt = sel.selectedOptions && sel.selectedOptions[0];
    var label = opt ? (opt.textContent || opt.label || opt.value) : (sel.value || "");
    var file = pickImageByLabel(label);
    var target = IMG_BASE + file;
    if (img.getAttribute("src") !== target) {
      img.setAttribute("src", target);
      var langLabel = (label || "").trim();
      if (langLabel) {
        img.setAttribute("alt", "參考簡圖 - " + langLabel);
        img.setAttribute("aria-label", "參考簡圖 - " + langLabel);
      }
    }
  }

  function preloadAllImages() {
    var files = Array.from(new Set(Object.values(RULES).concat([DEFAULT_IMG])));
    files.forEach(function(fn){ var i = new Image(); i.src = IMG_BASE + fn; });
  }

  function init() {
    var sel = findCategorySelect();
    var img = findReferenceImg();
    if (!sel || !img) return;
    preloadAllImages();
    updateRefImage(sel, img);
    ["change","input","blur"].forEach(function(evt){
      sel.addEventListener(evt, function(){ updateRefImage(sel, img); });
    });
    window.__updateRefImage = function(){ updateRefImage(sel, img); };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
