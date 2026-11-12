// ==UserScript==
// @name         脚本名（改成你自己的）
// @namespace    https://github.com/ccf-yang1/test
// @version      0.1.0
// @description  一句话说明这个脚本干什么
// @author       ccf-yang
// @match        https://example.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // 站点页面可能还没就绪，等 DOMContentLoaded 之后再动 DOM 更稳
  function main() {
    // TODO: 在这里写脚本逻辑
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main);
  } else {
    main();
  }
})();
