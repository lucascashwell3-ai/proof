/* Proof: the small page script. How it's built toggles, the nav's chapter indicator, the footer measurement,
   and the browser bar colour. The page is complete without it: panels open, no indicator, no numbers. */
(function () {
  "use strict";
  var D = document, W = window;

  /* ---------- How it's built: real buttons, panels closed from first paint by html.js ---------- */
  var btns = D.querySelectorAll(".how-btn");
  for (var i = 0; i < btns.length; i++) (function (btn) {
    var panel = D.getElementById(btn.getAttribute("aria-controls"));
    if (!panel) return;
    btn.setAttribute("aria-expanded", "false");
    btn.addEventListener("click", function () {
      var open = btn.getAttribute("aria-expanded") !== "true";
      btn.setAttribute("aria-expanded", String(open));
      panel.classList.toggle("open", open);
    });
  })(btns[i]);

  /* ---------- nav: which chapter is in view, and a hairline once the bar is stuck ---------- */
  var nav = D.getElementById("nav"), ind = D.getElementById("ind");
  var links = [].slice.call(D.querySelectorAll('#chapters a[href^="#"]'));
  var secs = links.map(function (a) { return D.getElementById(a.hash.slice(1)); });
  var hero = D.querySelector(".hero"), theme = D.querySelector('meta[name="theme-color"]');
  var active = -1, preview = -1, shown = -1, ticking = false, dark = true;

  function place(i) {
    if (i < 0) { ind.classList.remove("on"); shown = -1; return; }
    var a = links[i], tf = "translateX(" + a.offsetLeft + "px) scaleX(" + a.offsetWidth + ")";
    if (shown < 0) {
      /* arriving from nothing: appear in place, don't slide in from the left edge */
      ind.classList.add("jump");
      ind.style.transform = tf;
      void ind.offsetWidth;
      ind.classList.remove("jump");
    } else {
      ind.style.transform = tf;
    }
    ind.classList.add("on");
    shown = i;
  }
  function frame() {
    ticking = false;
    var vh = W.innerHeight, nr = nav.getBoundingClientRect();
    var probe = nr.height + (vh - nr.height) * 0.4, act = -1;
    for (var k = 0; k < secs.length; k++) {
      var r = secs[k].getBoundingClientRect();
      if (r.top <= probe && r.bottom > probe) act = k;
    }
    nav.classList.toggle("lined", nr.top <= 0.5 && (W.scrollY || W.pageYOffset) > 0);
    if (act !== active) {
      active = act;
      for (var j = 0; j < links.length; j++) {
        if (j === act) links[j].setAttribute("aria-current", "true");
        else links[j].removeAttribute("aria-current");
      }
      if (preview < 0) place(act);
    }
    /* the browser bar follows the sky: night while the hero is dark, the page colour after */
    var d = !!hero && !hero.classList.contains("day") && hero.getBoundingClientRect().bottom > nr.height;
    if (theme && d !== dark) { dark = d; theme.setAttribute("content", d ? "#02050d" : "#f7f8f9"); }
  }
  function onScroll() { if (!ticking) { ticking = true; W.requestAnimationFrame(frame); } }
  function relayout() { var s = shown; shown = -1; place(preview >= 0 ? preview : s >= 0 ? s : active); frame(); }

  links.forEach(function (a, i) {
    a.addEventListener("pointerenter", function (e) {
      if (e.pointerType !== "mouse") return;
      preview = i;
      ind.classList.toggle("preview", i !== active);
      place(i);
    });
  });
  D.getElementById("chapters").addEventListener("pointerleave", function () {
    if (preview < 0) return;
    preview = -1;
    ind.classList.remove("preview");
    place(active);
  });
  W.addEventListener("scroll", onScroll, { passive: true });
  W.addEventListener("resize", relayout);
  if (hero && "MutationObserver" in W) new MutationObserver(onScroll).observe(hero, { attributes: true, attributeFilter: ["class"] });
  if (D.fonts && D.fonts.ready) D.fonts.ready.then(relayout);
  frame();

  /* ---------- footer: what this visit actually cost, from the Performance API ---------- */
  function measure() {
    var P = W.performance, out = D.getElementById("measure");
    if (!out || !P || !P.getEntriesByType) return;
    var nv = P.getEntriesByType("navigation")[0];
    if (!nv || !nv.loadEventEnd) return;
    var bytes = nv.transferSize || 0, res = P.getEntriesByType("resource");
    for (var i = 0; i < res.length; i++) bytes += res[i].transferSize || 0;
    var ms = Math.round(nv.loadEventEnd - nv.startTime).toLocaleString("en-US");
    var kb = Math.max(1, Math.round(bytes / 1000)).toLocaleString("en-US");
    out.innerHTML = bytes > 0
      ? " Your browser just loaded this page: <span class=\"num\">" + kb + "</span> KB in <span class=\"num\">" + ms + "</span> ms."
      : " Your browser just loaded this page from its cache in <span class=\"num\">" + ms + "</span> ms.";
  }
  function afterLoad() { setTimeout(measure, 0); }
  if (D.readyState === "complete") afterLoad(); else W.addEventListener("load", afterLoad);
})();
