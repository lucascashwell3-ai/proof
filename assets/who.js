/* Proof, Who am I: copy the email address, with a note that says so, and open the two documents at reading size.
   The nav and the footer measurement come from site.js, as on the home page; the portrait is portrait.js. The page
   is complete without it: the email row is a plain mailto link and each document link opens its image. */
(function () {
  "use strict";
  var D = document, W = window, ADDR = "lucascashwell3@gmail.com";
  var CHECK = '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" focusable="false"><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm45.66,85.66-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35a8,8,0,0,1,11.32,11.32Z"/></svg>';
  var COPY = '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" focusable="false"><path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32Zm-8,128H176V88a8,8,0,0,0-8-8H96V48H208Z"/></svg>';

  /* ---------- copy the address: a real button, added only when script runs ---------- */
  var row = D.getElementById("mail"), toast = D.getElementById("toast");
  if (row && toast) {
    var btn = D.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-line copy";
    btn.innerHTML = COPY + "Copy<span class=\"sr\"> email address</span>";
    row.appendChild(btn);

    var tShow, tHide, tClear;
    var say = function (ok) {
      clearTimeout(tShow); clearTimeout(tHide); clearTimeout(tClear);
      toast.classList.remove("show");
      toast.textContent = "";
      /* new text a moment later, so a second copy is announced again */
      tShow = setTimeout(function () {
        toast.innerHTML = ok
          ? CHECK + "Copied <span>" + ADDR + "</span>"
          : "Couldn’t copy. The address is <span>" + ADDR + "</span>";
        toast.classList.add("show");
        tHide = setTimeout(function () {
          toast.classList.remove("show");
          tClear = setTimeout(function () { toast.textContent = ""; }, 400);
        }, 2600);
      }, 60);
    };
    /* older browsers, or a page served without https */
    var legacy = function () {
      var ta = D.createElement("textarea"), ok = false;
      ta.value = ADDR;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0";
      D.body.appendChild(ta);
      ta.select();
      try { ok = D.execCommand("copy"); } catch (e) { ok = false; }
      D.body.removeChild(ta);
      btn.focus();
      return ok;
    };
    btn.addEventListener("click", function () {
      var cb = W.navigator.clipboard;
      if (cb && cb.writeText && W.isSecureContext) {
        cb.writeText(ADDR).then(function () { say(true); }, function () { say(legacy()); });
      } else {
        say(legacy());
      }
    });
  }
  /* ---------- the documents: each link opens its template in a dialog; the dialog is removed once it closes ---------- */
  var docs = D.querySelectorAll("a.doc[data-sheet]");
  if (docs.length && typeof W.HTMLDialogElement === "function") {
    var open = function (e) {
      if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;   /* new tab, new window: leave it */
      var a = e.currentTarget, tpl = D.getElementById(a.getAttribute("data-sheet"));
      if (!tpl) return;
      e.preventDefault();
      var dlg = D.createElement("dialog");
      dlg.className = "sheet" + (a.getAttribute("data-sheet") === "sheet-cert" ? " sheet-badge" : "");
      dlg.setAttribute("aria-label", a.querySelector(".dk").textContent);
      dlg.appendChild(tpl.content.cloneNode(true));
      /* a click on the dimmed page (the dialog's own box, outside the sheet) closes it */
      dlg.addEventListener("click", function (ev) { if (ev.target === dlg) dlg.close(); });
      dlg.addEventListener("close", function () { setTimeout(function () { dlg.remove(); }, 300); });
      D.body.appendChild(dlg);
      dlg.showModal();
    };
    for (var i = 0; i < docs.length; i++) docs[i].addEventListener("click", open);
  }
})();
