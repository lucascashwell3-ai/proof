/* DATproof window. The finished grid is the page's default state, drawn in the HTML.
   This file only (1) replays it once as a left-to-right fill the first time it scrolls into view,
   and (2) adds a hover readout per week on fine pointers. No JS, no observer, or reduced motion:
   the finished grid, no motion. */
(function () {
  "use strict";
  var W = window, doc = document, rows = doc.getElementById("dpRows");
  if (!rows) return;
  var NW = +rows.getAttribute("data-weeks");
  /* build geometry in SVG units, written by the build script: one week = PITCH wide, its cell = CELL wide */
  var PITCH = +rows.getAttribute("data-pitch"), CELL = +rows.getAttribute("data-cell");
  var mm = function (q) { return W.matchMedia ? W.matchMedia(q) : { matches: false }; };

  /* ---------- one-time fill ---------- */
  var RM = mm("(prefers-reduced-motion: reduce)");
  if ("IntersectionObserver" in W && !RM.matches && rows.animate && NW > 0) {
    var SWEEP = 1400, FADE = 360, state = 0; /* 0 waiting, 1 armed (cells hidden), 2 done */
    var cells = rows.querySelectorAll("path[data-w]"), head = rows.querySelector(".dp-head"), anims = [];
    /* inverse ease-out-cubic: each chunk starts as the playhead, eased the same way, reaches it */
    var at = function (x) { return SWEEP * (1 - Math.cbrt(1 - Math.min(1, x))); };
    var arm = function () {
      for (var i = 0; i < cells.length; i++) {
        var a = cells[i].animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: FADE, delay: at(cells[i].getAttribute("data-w") / NW),
          easing: "cubic-bezier(.25,1,.5,1)", fill: "backwards"
        });
        a.pause();
        anims.push(a);
      }
      state = 1;
    };
    var reveal = function () {
      if (state === 2) return;
      state = 2;
      io.disconnect();
      for (var i = 0; i < anims.length; i++) anims[i].cancel();
    };
    var play = function () {
      state = 2;
      io.disconnect();
      for (var i = 0; i < anims.length; i++) anims[i].play();
      if (head) head.animate([
        { transform: "translateX(0)", opacity: 0 }, { opacity: 1, offset: 0.04 }, { opacity: 1, offset: 0.92 },
        { transform: "translateX(" + (rows.clientWidth - 1) + "px)", opacity: 0 }
      ], { duration: SWEEP, easing: "cubic-bezier(.33,1,.68,1)" });
      /* whatever happens to the timeline (hidden tab, throttling), end on the finished grid */
      setTimeout(function () { for (var i = 0; i < anims.length; i++) anims[i].cancel(); }, SWEEP + FADE + 600);
    };
    var io = new IntersectionObserver(function (es) {
      if (state === 2) return;
      var inView = es[es.length - 1].isIntersecting;
      if (state === 0) {
        /* already on screen at load: keep the finished grid rather than blank it */
        if (inView) return reveal();
        return arm();
      }
      if (inView) play();
    }, { threshold: 0.35 });
    io.observe(rows);
    /* safety: if the observer never reports, never hide anything */
    setTimeout(function () { if (state === 0) reveal(); }, 3000);
    W.addEventListener("beforeprint", reveal);
    if (RM.addEventListener) RM.addEventListener("change", function () { if (RM.matches) reveal(); });
  }

  /* ---------- hover readout: week, row, BTC ---------- */
  /* no geometry, no readout: a guess could point at the wrong week */
  if (!(PITCH > 0 && CELL > 0) || !mm("(hover: hover) and (pointer: fine)").matches) return;
  var data;
  try { data = JSON.parse(doc.getElementById("dpData").textContent); } catch (e) { return; }
  var svgs = rows.querySelectorAll("svg"), labels = rows.querySelectorAll(".dp-label"), box = rows.parentNode;
  var vals = [{}], names = [], t0 = Date.parse(data.s + "T00:00:00Z"), tip, mark;
  var MON = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
  data.r.forEach(function (r) {
    var m = {};
    r.forEach(function (p) { m[p[0]] = p[1]; vals[0][p[0]] = (vals[0][p[0]] || 0) + p[1]; });
    vals.push(m);
  });
  for (var i = 0; i < labels.length; i++) names.push(labels[i].querySelector("em").textContent);
  var fmt = function (v) {
    return v >= 100 ? Math.round(v).toLocaleString("en-US") : v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  };
  var hide = function () { if (tip) { tip.classList.remove("on"); mark.classList.remove("on"); } };
  rows.addEventListener("pointermove", function (e) {
    var r, k;
    for (k = 0; k < svgs.length; k++) {
      r = svgs[k].getBoundingClientRect();
      if (e.clientY >= r.top - 3 && e.clientY <= r.bottom + 3) break;
    }
    if (k === svgs.length || e.clientX < r.left || e.clientX > r.right) return hide();
    var vw = svgs[k].viewBox.baseVal.width, px = r.width / vw;
    var w = Math.max(0, Math.min(NW - 1, Math.floor((e.clientX - r.left) / px / PITCH)));
    var d = new Date(t0 + w * 6048e5), v = vals[k][w];
    if (!tip) {
      tip = doc.createElement("div");
      mark = doc.createElement("span");
      tip.className = "dp-tip";
      mark.className = "dp-mark";
      tip.setAttribute("aria-hidden", "true");
      mark.setAttribute("aria-hidden", "true");
      box.appendChild(mark);
      box.appendChild(tip);
    }
    tip.innerHTML = names[k] + " <span>· week of " + MON[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + d.getUTCFullYear() +
      " ·</span> " + (v ? fmt(v) + " BTC" : "no buys");
    var b = box.getBoundingClientRect(), tw = tip.offsetWidth;
    /* ring the hovered week: the cell, not the gap after it */
    mark.style.cssText = "left:" + (r.left - b.left + w * PITCH * px).toFixed(1) + "px;top:" + (r.top - b.top).toFixed(1) +
      "px;width:" + (CELL * px).toFixed(1) + "px;height:" + r.height + "px";
    mark.classList.add("on");
    var x = Math.max(8, Math.min(b.width - tw - 8, e.clientX - b.left - tw / 2));
    tip.style.transform = "translate(" + Math.round(x) + "px," + Math.round(r.top - b.top - tip.offsetHeight - 8) + "px)";
    tip.classList.add("on");
  });
  rows.addEventListener("pointerleave", hide);
})();
