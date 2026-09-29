/* Proof: the small script both pages share. How it's built toggles, the nav's chapter indicator and hairline, the
   footer measurement, and the browser bar colour. Each part does nothing on a page without its elements.
   The page is complete without it: panels open, no indicator, no numbers. */
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
  var nav = D.getElementById("nav"), ind = D.getElementById("ind"), list = D.getElementById("chapters");
  var links = [].slice.call(D.querySelectorAll('#chapters a[href^="#"]'));
  var secs = links.map(function (a) { return D.getElementById(a.hash.slice(1)); });
  var hero = D.querySelector(".hero"), theme = D.querySelector('meta[name="theme-color"]');
  var active = -1, preview = -1, shown = -1, ticking = false, dark = true;

  function place(i) {
    if (!ind) return;
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
      if (!secs[k]) continue;
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

  if (nav) {
    links.forEach(function (a, i) {
      a.addEventListener("pointerenter", function (e) {
        if (e.pointerType !== "mouse" || !ind) return;
        preview = i;
        ind.classList.toggle("preview", i !== active);
        place(i);
      });
    });
    if (list) list.addEventListener("pointerleave", function () {
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
  }

  /* ---------- footer: what this visit actually cost, from the Performance API ----------
     Bytes: the page plus every file it fetched, counted as each one lands, so images that load late (lazy, below
     the fold) are added when they arrive. Time: from the start of navigation to the end of the load event. */
  var out = D.getElementById("measure"), P = W.performance;
  if (out && P && P.getEntriesByType) {
    var got = 0, ms = -1, wait = 0, watching = false, kbEl = null;
    var add = function (list) { for (var i = 0; i < list.length; i++) got += list[i].transferSize || 0; };
    var show = function () {
      wait = 0;
      if (ms < 0) return;
      var nv = P.getEntriesByType("navigation")[0], bytes = got + ((nv && nv.transferSize) || 0);
      var t = Math.round(ms).toLocaleString("en-US"), kb = Math.max(1, Math.round(bytes / 1000)).toLocaleString("en-US");
      /* after the first write only the figure changes, so the sentence never flickers or rebuilds */
      if (kbEl) { if (kbEl.textContent !== kb) kbEl.textContent = kb; return; }
      if (bytes > 0) {
        out.innerHTML = " Your browser just loaded this page: <span class=\"num\">" + kb + "</span> KB in <span class=\"num\">" + t + "</span> ms.";
        kbEl = out.querySelector(".num");
      } else {
        out.innerHTML = " Your browser just loaded this page from its cache in <span class=\"num\">" + t + "</span> ms.";
      }
    };
    /* a burst of arrivals (the fonts, a srcset swap) settles into one update */
    var later = function () { clearTimeout(wait); wait = setTimeout(show, 200); };
    if (W.PerformanceObserver) {
      try {
        new PerformanceObserver(function (l) { add(l.getEntries()); later(); }).observe({ type: "resource", buffered: true });
        watching = true;
      } catch (e) { watching = false; }
    }
    var loaded = function () {
      setTimeout(function () {
        var nv = P.getEntriesByType("navigation")[0];
        if (!nv || !nv.loadEventEnd) return;
        ms = nv.loadEventEnd - nv.startTime;
        if (!watching) add(P.getEntriesByType("resource"));
        show();
      }, 0);
    };
    if (D.readyState === "complete") loaded(); else W.addEventListener("load", loaded);
  }
})();
