#!/usr/bin/env node
// The one command that says whether the site is done.
//
//   node scripts/verify.mjs [--base <url>] [--pages "/,/who/"] [--lh-runs 5] [--quick] [--sheet <file.jpg>]
//
//   --base     site root to test. Default: start scripts/serve.mjs on a free port over the repo root.
//   --pages    comma list of paths under --base. A path ending in who/ is tested as the Who page,
//              anything else as the home page (hero, DATproof, How it's built, nav).
//   --lh-runs  Lighthouse runs per page (median reported). Default 5.
//   --quick    skip Lighthouse and the sunset scan.
//   --sheet    also write the sunset scan's contact sheet to this file.
//   --plant-css <css>  add this CSS to every page in the visibility runs (checks 3 and 4), to prove they can fail.
//
// Output: one line per check, "PASS|FAIL|SKIP  <page>  <check>  <measured value>", then a summary line.
// SKIP is used for exactly one case: a LinkedIn profile link, which answers 999 to every automated client.
// Exit code 0 only when no check fails; skips don't fail, and the summary counts them. Progress notes go to stderr, prefixed "#".

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { serve } from './serve.mjs';
import { sunsetScan, gpuFrameTime, bfcacheRestore, noWebGL, heroReady, frameCounts, fontMetricFallback, gpuLaunchOptions, bfcacheLaunchOptions } from './checks/hero.mjs';
import { csvTotal, pageTotal } from './checks/datproof.mjs';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const T0 = Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const note = s => process.stderr.write(`# ${s}\n`);

// ---------- args ----------
const argv = process.argv.slice(2);
const flag = k => argv.includes(k);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const QUICK = flag('--quick');
const LH_RUNS = Math.max(1, parseInt(opt('--lh-runs', '5'), 10) || 5);
const SHEET = opt('--sheet', null);
const PAGE_PATHS = opt('--pages', '/,/who/').split(',').map(s => s.trim()).filter(Boolean);
const PLANT_CSS = opt('--plant-css', null);

// ---------- budgets ----------
const B = {
  perf: 90, a11y: 100, bp: 95, seo: 95, lcpMs: 2500, cls: 0.02, tbtMs: 150,
  gpuDeskMs: 4.0, gpuPhoneMs: 2.0, scanStep: 0.005,
};
const DESK = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

// ---------- output ----------
const results = [];
let PW = 4;
// ok: true = PASS, false = FAIL, 'skip' = SKIP (not machine-checkable; counted apart, never as a pass)
function line(ok, page, check, value) {
  const skip = ok === 'skip';
  const status = skip ? 'SKIP' : ok ? 'PASS' : 'FAIL';
  results.push({ ok: !!ok && !skip, skip, page, check, value });
  process.stdout.write(`${status}  ${page.padEnd(PW)}  ${check.padEnd(30)}  ${String(value).replace(/\s+/g, ' ').trim()}\n`);
}
const cut = (s, n = 160) => { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const shortUrl = (u, base) => { try { const x = new URL(u); return base && x.origin === new URL(base).origin ? x.pathname + x.search : u; } catch { return u; } };

// run one check; a thrown error becomes a FAIL line, never a crash
async function guard(page, check, fn) {
  try { return await fn(); }
  catch (e) { line(false, page, check, 'error: ' + cut(e.message.split('\n')[0], 200)); return undefined; }
}

// ---------- in-page helpers (serialised into the page) ----------
// Shared DOM utilities, injected once per document before the probes run.
const PAGE_LIB = () => {
  if (window.__vlib) return;
  const cs = n => getComputedStyle(n);
  const SR = /(^|\s)(sr-only|sr|visually-hidden|screen-reader-text|screen-reader-only|skip-link|skip)(\s|$)/;
  const cls = n => (typeof n.className === 'string' ? n.className : (n.className && n.className.baseVal) || '');
  const sel = el => {
    const parts = [];
    for (let a = el, i = 0; a && a.nodeType === 1 && a !== document.body && i < 3; a = a.parentElement, i++) {
      let s = a.tagName.toLowerCase();
      if (a.id) { s += '#' + a.id; parts.unshift(s); break; }
      const c = cls(a).trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (c.length) s += '.' + c.join('.');
      parts.unshift(s);
    }
    const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 28);
    return parts.join('>') + (txt && !/^(svg|path|figure|section|div)$/i.test(el.tagName) ? ` "${txt}"` : '');
  };
  // visually hidden on purpose: sr-only style classes, or the 1px clipped pattern
  const isSR = el => {
    for (let a = el; a && a.nodeType === 1; a = a.parentElement) {
      if (SR.test(cls(a))) return true;
      const c = cs(a);
      if ((c.position === 'absolute' || c.position === 'fixed') && parseFloat(c.width) <= 1 && parseFloat(c.height) <= 1) return true;
    }
    return false;
  };
  const zeroClipPath = (cp, w, h) => {
    if (!cp || cp === 'none') return false;
    const m = /^inset\(([^)]*)\)/.exec(cp);
    const len = (v, ref) => v.endsWith('%') ? parseFloat(v) / 100 * ref : parseFloat(v) || 0;
    if (m) {
      const v = m[1].split(/\s+round\s+/)[0].trim().split(/\s+/);
      const [t, r = t, b = t, l = r] = v;
      return w - len(l, w) - len(r, w) < 0.5 || h - len(t, h) - len(b, h) < 0.5;
    }
    if (/^circle\(\s*0(px|%)?[\s)]/.test(cp)) return true;
    if (/^ellipse\(\s*0(px|%)?\s+0(px|%)?[\s)]/.test(cp)) return true;
    return false;
  };
  const zeroClip = c => /^rect\(\s*0(px)?[,\s]+0(px)?[,\s]+0(px)?[,\s]+0(px)?\s*\)$/.test(c.clip || '');
  // alpha is the 4th comma value of rgba(), or whatever follows "/" in modern colour syntax
  const transparent = col => {
    if (col === 'transparent') return true;
    const m = /^[a-z-]+\(([^)]*)\)$/i.exec(col || ''); if (!m) return false;
    const [, a] = m[1].split('/');
    if (a !== undefined) return parseFloat(a) === 0;
    const parts = m[1].split(',');
    return parts.length === 4 && parseFloat(parts[3]) === 0;
  };
  const TEXT = /^(h[1-6]|p|li|dt|dd|a|button|figcaption|summary|label|blockquote|td|th)$/i;
  // an element with a text node of its own (not only text inside its children)
  const own = el => { for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) return true; return false; };
  const texty = el => TEXT.test(el.tagName) || own(el);
  // why an element can't be seen, or null when it can
  const hiddenWhy = (el, noClip) => {
    for (let a = el; a && a.nodeType === 1; a = a.parentElement)
      if (cs(a).display === 'none') return 'display:none' + (a === el ? '' : ' on ' + sel(a));
    // catches what display can't: content of a closed <details>, content-visibility:hidden
    if (el.checkVisibility && !el.checkVisibility()) return 'not rendered (closed <details> or content-visibility)';
    const c = cs(el);
    if (c.visibility !== 'visible') return 'visibility:' + c.visibility;
    let o = 1, low = null, lowO = 1;
    for (let a = el; a && a.nodeType === 1; a = a.parentElement) {
      const v = parseFloat(cs(a).opacity); o *= v; if (v < lowO) { lowO = v; low = a; }
    }
    if (o < 0.99) return `opacity ${o.toFixed(2)}` + (low && low !== el ? ' (from ' + sel(low) + ')' : '');
    const r = el.getBoundingClientRect();
    if (r.width < 0.5 || r.height < 0.5) return `size ${Math.round(r.width * 10) / 10}x${Math.round(r.height * 10) / 10}`;
    if (zeroClipPath(c.clipPath, r.width, r.height) || zeroClip(c)) return 'clipped to zero (own clip)';
    let L = r.left, T = r.top, R = r.right, Bm = r.bottom;
    for (let a = el.parentElement; !noClip && a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const ac = cs(a);
      const cx = ac.overflowX === 'hidden' || ac.overflowX === 'clip', cy = ac.overflowY === 'hidden' || ac.overflowY === 'clip';
      const ar = (cx || cy || (ac.clipPath && ac.clipPath !== 'none') || zeroClip(ac)) ? a.getBoundingClientRect() : null;
      if (cx) { L = Math.max(L, ar.left); R = Math.min(R, ar.right); }
      if (cy) { T = Math.max(T, ar.top); Bm = Math.min(Bm, ar.bottom); }
      if (R - L < 0.5 || Bm - T < 0.5) return 'clipped to zero by ' + sel(a);
      if (ar && (zeroClipPath(ac.clipPath, ar.width, ar.height) || zeroClip(ac))) return 'clipped to zero by clip on ' + sel(a);
    }
    if (texty(el) && transparent(c.color) && !el.querySelector('img,svg,picture,video,canvas')) return 'text colour transparent';
    return null;
  };
  // the box an element paints in: its own box cut by every ancestor that clips overflow (html/body excepted)
  const paintBox = el => {
    const r = el.getBoundingClientRect();
    let L = r.left, T = r.top, R = r.right, Bm = r.bottom;
    for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const ac = cs(a);
      const cx = ac.overflowX !== 'visible', cy = ac.overflowY !== 'visible';
      if (!cx && !cy) continue;
      const ar = a.getBoundingClientRect();
      if (cx) { L = Math.max(L, ar.left); R = Math.min(R, ar.right); }
      if (cy) { T = Math.max(T, ar.top); Bm = Math.min(Bm, ar.bottom); }
    }
    return { r, L, T, R, B: Bm };
  };
  window.__vlib = { cs, sel, isSR, hiddenWhy, TEXT, own, texty, paintBox };
};

// Visibility probe. Called at every scroll step; keeps each element's best state, so an element passes if it was
// fully visible at some point of the scroll (e.g. the hero word at the top, a section once it is in view).
// Collects from the whole <body>: every element in `selector`, plus any element with a text node of its own
// (so span, em, b, time and every other bit of text count with no list to keep up). Inside an <svg> only the
// DATproof grid cells and <text> count; <title>/<desc> and friends never render. Collected again at every step, so
// content the page's own script writes later (the footer's measured numbers) is checked too; an element the script
// has since replaced is dropped at the end and counted apart.
const VIS_PROBE = ({ jsOff, selector, finish }) => {
  const { sel, isSR, hiddenWhy, TEXT, own } = window.__vlib;
  const st = window.__vis || (window.__vis = { set: new Set(), els: [], best: new Map() });
  {
    const NEVER = /^(script|style|template|title|desc|metadata|br|wbr|source|track|param|option)$/i;
    for (const el of document.body.querySelectorAll('*')) {
      if (st.set.has(el) || NEVER.test(el.tagName) || el.closest('script,style,template') || el.id === '__hitpe') continue;
      const svg = el.tagName.toLowerCase() !== 'svg' && el.closest('svg');
      if (svg) { if (el.matches('.dp-rows path[data-w]') || (/^(text|tspan)$/i.test(el.tagName) && own(el))) st.set.add(el); continue; }
      if (el.matches(selector) || own(el)) st.set.add(el);
    }
    st.els = [...st.set];
  }
  // closed disclosures: aria-expanded=false + aria-controls, and closed <details> (summary stays visible)
  const closed = new Set();
  if (!jsOff) {
    for (const b of document.querySelectorAll('[aria-expanded="false"][aria-controls]'))
      for (const id of b.getAttribute('aria-controls').split(/\s+/)) { const p = document.getElementById(id); if (p) closed.add(p); }
    for (const d of document.querySelectorAll('details:not([open])')) closed.add(d);
  }
  const inClosed = el => {
    for (let a = el; a; a = a.parentElement) if (closed.has(a)) {
      if (a.tagName === 'DETAILS') { const s = el.closest('summary'); return !(s && s.parentElement === a); }
      return true;
    }
    return false;
  };
  const rank = { ok: 3, exempt: 2, closed: 2, empty: 2, crop: 2, toggle: 2 };
  for (const el of st.els) {
    if (!el.isConnected) continue;
    let state;
    if (isSR(el)) state = 'exempt';
    else if (inClosed(el)) state = 'closed';
    else if (TEXT.test(el.tagName) && !el.textContent.trim() && !el.querySelector('img,svg,picture,video,canvas')) state = 'empty';
    else {
      // decorative product renders (aria-hidden) may be cropped by their window; everything else about them is checked
      const deco = !!el.closest('[aria-hidden="true"]');
      const why = hiddenWhy(el, false);
      // with JS off a disclosure toggle can't do anything, so hiding it is fine; its panel is still checked
      const trig = jsOff && why && el.closest('[aria-controls][aria-expanded]');
      const hasPanel = trig && trig.getAttribute('aria-controls').split(/\s+/).every(id => document.getElementById(id));
      state = !why ? 'ok' : deco && /^clipped to zero by /.test(why) && !hiddenWhy(el, true) ? 'crop' : hasPanel ? 'toggle' : { why };
    }
    const prev = st.best.get(el);
    const rp = prev ? (rank[prev] || 1) : 0, rn = rank[state] || 1;
    if (rn >= rp) st.best.set(el, state);
  }
  if (!finish) return null;
  let checked = 0, exempt = 0, closedN = 0, empty = 0, crop = 0, toggle = 0, gridCells = 0, gridOk = 0, gone = 0;
  const fails = [];
  for (const el of st.els) {
    if (!el.isConnected) { gone++; continue; }
    const s = st.best.get(el);
    const isCell = el.matches('.dp-rows path[data-w]');
    if (isCell) gridCells++;
    if (s === 'exempt') { exempt++; continue; }
    if (s === 'closed') { closedN++; continue; }
    if (s === 'empty') { empty++; continue; }
    if (s === 'crop') { crop++; continue; }
    if (s === 'toggle') { toggle++; continue; }
    checked++;
    if (s === 'ok') { if (isCell) gridOk++; continue; }
    fails.push({ el: sel(el), why: s ? s.why : 'not connected', cell: isCell });
  }
  const hit = st.hit || { tested: 0, core: 0, other: 0, otherOf: 0, fails: [] };
  for (const f of hit.fails) fails.push({ el: f.el, why: f.why, cell: false });
  const kinds = {};
  for (const el of st.els) { if (!el.isConnected) continue; const k = el.tagName.toLowerCase(); kinds[k] = (kinds[k] || 0) + 1; }
  delete window.__vis;
  return { total: st.els.length - gone, gone, checked, exempt, closed: closedN, empty, crop, toggle, gridCells, gridOk, fails,
    hit: { tested: hit.tested, core: hit.core, other: hit.other, otherOf: hit.otherOf, fails: hit.fails.length },
    landmarks: ['header', 'nav', 'main', 'footer', 'h1', 'dt', 'dd'].map(k => `${k} ${kinds[k] || 0}`).join(', ') };
};

// ---------- paint check: is the element really what is drawn at its centre? ----------
// For every text element that passed the style checks (no sampling: the cost is per scroll step, not per element),
// scroll it to the middle of the viewport, then confirm its
// painted box lies inside the document, has a size, and that the topmost painted element at the centre of that box
// is the element itself, something inside it, or an ancestor within the same component. pointer-events is forced
// on for the test, so hit-testing follows paint order only; layers at opacity ~0 paint nothing and are passed over.
const HIT_SETUP = () => {
  const { texty } = window.__vlib;
  const st = window.__vis;
  const CORE = /^(h[1-6]|a|button|dt|dd|summary|label|figcaption)$/i;
  const list = [];
  let core = 0, other = 0, otherOf = 0;
  for (const el of st.els) {
    if (!el.isConnected || st.best.get(el) !== 'ok' || el.closest('svg') || !texty(el)) continue;
    if (CORE.test(el.tagName)) core++; else { other++; otherOf++; }
    list.push(el);
  }
  const s = document.createElement('style'); s.id = '__hitpe';
  s.textContent = '*{pointer-events:auto!important}';
  document.head.append(s);
  st.hit = { list, done: new Set(), tries: new Map(), core, other, otherOf, tested: 0, fails: [] };
  scrollTo(0, 0);
  return list.length;
};
const HIT_STEP = () => {
  const { cs, sel, paintBox } = window.__vlib;
  const h = window.__vis.hit;
  const vw = innerWidth, vh = innerHeight, de = document.documentElement;
  const docW = Math.max(de.scrollWidth, document.body.scrollWidth), docH = Math.max(de.scrollHeight, document.body.scrollHeight);
  const COMP = 'header,nav,footer,section,article,aside,figure,dl,ul,ol,table,form,.win,.mat';
  const faint = el => { let o = 1; for (let a = el; a && a.nodeType === 1; a = a.parentElement) o *= parseFloat(cs(a).opacity); return o < 0.05; };
  const test = (el, b) => {
    const { r } = b;
    if (r.width < 0.5 || r.height < 0.5) return `size ${Math.round(r.width)}x${Math.round(r.height)} at paint`;
    const L = b.L + scrollX, T = b.T + scrollY, R = b.R + scrollX, B = b.B + scrollY;
    if (R - L < 0.5 || B - T < 0.5) return 'painted box clipped to nothing';
    if (L < -0.5 || T < -0.5 || R > docW + 0.5 || B > docH + 0.5) return `painted box outside the document (x ${Math.round(L)}..${Math.round(R)} of ${docW}, y ${Math.round(T)}..${Math.round(B)} of ${docH})`;
    const x = (Math.max(b.L, 0) + Math.min(b.R, vw)) / 2, y = (Math.max(b.T, 0) + Math.min(b.B, vh)) / 2;
    if (x <= 0 || y <= 0 || x >= vw || y >= vh) return 'not in view after scrolling to it';
    const top = document.elementsFromPoint(x, y).find(e => !faint(e));
    if (!top) return 'nothing painted at its centre';
    if (top === el || el.contains(top)) return null;
    const comp = (el.parentElement && el.parentElement.closest(COMP)) || document.body;
    if (top.contains(el) && comp.contains(top)) return null;
    return 'covered by ' + sel(top);
  };
  let next = null;
  for (const el of h.list) {
    if (h.done.has(el)) continue;
    if (!el.isConnected) { h.done.add(el); continue; }   // replaced by the page's script mid-pass
    const b = paintBox(el);
    const cy = (b.T + b.B) / 2;
    const tall = b.B - b.T > vh * 0.7;
    const inBand = tall ? b.T < vh * 0.5 && b.B > vh * 0.5 : b.T >= vh * 0.15 && b.B <= vh * 0.85;
    const tries = h.tries.get(el) || 0;
    if (inBand || tries >= 1) {
      // a second look where it could not be centred (top or bottom of the page): test it where it is
      h.done.add(el); h.tested++;
      const why = test(el, b);
      if (why) h.fails.push({ el: sel(el), why: 'paint: ' + why });
    } else if (!next) { next = el; h.tries.set(el, tries + 1); }
  }
  if (!next) { document.getElementById('__hitpe')?.remove(); return { left: 0 }; }
  const b = next.getBoundingClientRect();
  return { left: h.list.length - h.done.size, y: Math.max(0, Math.round(scrollY + (b.top + b.bottom) / 2 - vh / 2)) };
};

// Horizontal overflow probe at phone width: page scroll width, and the element whose visible box (after clipping by
// any ancestor except html/body) sticks out furthest past either side of the viewport.
const OVERFLOW_PROBE = () => {
  const { cs, sel, isSR } = window.__vlib;
  const de = document.documentElement, vw = de.clientWidth;
  const sw = Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0);
  let worst = null, n = 0;
  const op = new Map();
  const effOp = el => { if (!el || el.nodeType !== 1) return 1; if (op.has(el)) return op.get(el); const v = parseFloat(cs(el).opacity) * effOp(el.parentElement); op.set(el, v); return v; };
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const c = cs(el);
    if (c.visibility !== 'visible' || effOp(el) === 0 || isSR(el)) continue;
    n++;
    let L = r.left, R = r.right;
    for (let a = el.parentElement; a && a !== document.body && a !== de; a = a.parentElement) {
      if (cs(a).overflowX !== 'visible') { const ar = a.getBoundingClientRect(); L = Math.max(L, ar.left); R = Math.min(R, ar.right); }
    }
    if (R - L <= 0) continue;
    const over = Math.max(R - vw, -L);
    if (over > 0.5 && (!worst || over > worst.over)) worst = { over: Math.round(over * 10) / 10, el: sel(el), left: Math.round(L), right: Math.round(R) };
  }
  return { vw, sw, worst, n };
};

// ---------- browser helpers ----------
function watchErrors(page, base) {
  const errors = [];
  const skip = u => /\/favicon\.ico(\?|$)/.test(u || '');
  page.on('pageerror', e => errors.push('pageerror: ' + cut(e.message.split('\n')[0], 180)));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const u = (m.location() || {}).url || '';
    if (skip(u) || /^Failed to load resource/.test(m.text())) return;   // HTTP failures are reported by URL below
    errors.push('console: ' + cut(m.text(), 180) + (u ? ' @' + shortUrl(u, base) : ''));
  });
  page.on('response', r => { if (r.status() >= 400 && !skip(r.url())) errors.push(`http ${r.status()}: ${shortUrl(r.url(), base)}`); });
  page.on('requestfailed', r => {
    const f = (r.failure() || {}).errorText || '';
    if (/ERR_ABORTED/.test(f) || skip(r.url())) return;
    errors.push(`requestfailed ${f}: ${shortUrl(r.url(), base)}`);
  });
  return errors;
}

async function fresh(browser, ctxOpts = {}) {
  const ctx = await browser.newContext({ ...DESK, ...ctxOpts });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  return { ctx, page };
}

// slow full scroll with the wheel, top to bottom; onStep runs after each step
async function wheelScroll(page, { step = 300, wait = 160, onStep } = {}) {
  const vp = page.viewportSize() || { width: 1440, height: 900 };
  await page.mouse.move(vp.width / 2, vp.height / 2);
  let still = 0, last = -1, steps = 0;
  for (let i = 0; i < 600; i++) {
    const { y, h, H } = await page.evaluate(() => ({ y: scrollY, h: innerHeight, H: document.documentElement.scrollHeight }));
    if (y + h >= H - 2) break;
    if (y === last) { if (++still >= 6) break; } else still = 0;
    last = y;
    await page.mouse.wheel(0, step);
    await sleep(wait);
    steps++;
    if (onStep) await onStep();
  }
  await sleep(700);
  if (onStep) await onStep();
  const end = await page.evaluate(() => ({ y: Math.round(scrollY + innerHeight), H: document.documentElement.scrollHeight }));
  return { steps, ...end };
}

// scroll by script (works with JS off in the page, and under touch emulation)
async function stepScroll(page, { frac = 0.6, wait = 250, onStep } = {}) {
  if (onStep) await onStep();
  for (let i = 0; i < 400; i++) {
    const done = await page.evaluate(f => { const y = scrollY; scrollBy(0, Math.round(innerHeight * f)); return scrollY === y; }, frac);
    await sleep(wait);
    if (onStep) await onStep();
    if (done) break;
  }
  await page.evaluate(() => scrollTo(0, 0));
  await sleep(wait * 2);
  if (onStep) await onStep();
}

// landmarks and every kind of content element; VIS_PROBE adds any element with its own text on top of these
const VIS_SELECTOR = 'header,nav,main,footer,h1,h2,h3,h4,h5,h6,p,li,dt,dd,a,button,figcaption,summary,label,time,' +
  'img,picture,video,svg,figure,[data-total],.win,.mat,.dp-rows path[data-w]';

async function visibilityRun(browser, url, ctxOpts, jsOff) {
  const { ctx, page } = await fresh(browser, ctxOpts);
  try {
    await page.goto(url, { waitUntil: 'load' });
    // appended directly: page.addStyleTag waits for a load event that never comes with JS off
    if (PLANT_CSS) await page.evaluate(css => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); }, PLANT_CSS);
    await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
    await sleep(jsOff ? 300 : 1200);
    await page.evaluate(PAGE_LIB);
    const probe = () => page.evaluate(VIS_PROBE, { jsOff, selector: VIS_SELECTOR, finish: false });
    await stepScroll(page, { onStep: probe });
    await sleep(jsOff ? 200 : 3200);   // at the top again: past the hero's opening fade
    await probe();
    // paint pass: walk the page again, centring each sampled element, and hit-test it
    await page.evaluate(HIT_SETUP);
    await sleep(jsOff ? 150 : 400);
    for (let i = 0; i < 500; i++) {
      const s = await page.evaluate(HIT_STEP);
      if (!s.left) break;
      await page.evaluate(y => scrollTo(0, y), s.y);
      await sleep(jsOff ? 150 : 400);
    }
    return await page.evaluate(VIS_PROBE, { jsOff, selector: VIS_SELECTOR, finish: true });
  } finally { await ctx.close(); }
}

function visLine(label, check, r) {
  const fl = r.fails.filter(f => !f.cell);
  const cellFails = r.fails.length - fl.length;
  const shown = fl.slice(0, 4).map(f => `${f.el} [${f.why}]`).join('; ');
  const extra = [];
  if (r.exempt) extra.push(`${r.exempt} sr-only`);
  if (r.closed) extra.push(`${r.closed} in closed panels`);
  if (r.empty) extra.push(`${r.empty} empty`);
  if (r.crop) extra.push(`${r.crop} aria-hidden, cropped by their window`);
  if (r.toggle) extra.push(`${r.toggle} in disclosure toggles hidden without JS`);
  if (r.gone) extra.push(`${r.gone} replaced by the page's script, their replacements checked`);
  const ok = r.fails.length === 0 && r.checked > 0 && r.hit.tested > 0;
  const styleFails = r.fails.length - r.hit.fails;
  line(ok, label, check, `whole body, ${r.total} elements (${r.landmarks}): ${r.checked - styleFails}/${r.checked} visible` +
    (extra.length ? ` (skipped: ${extra.join(', ')})` : '') +
    `; paint hit-test ${r.hit.tested - r.hit.fails}/${r.hit.tested} (every text element that passed: ${r.hit.core} headings/links/buttons/dt/dd + ${r.hit.other} other)` +
    (cellFails ? `; ${cellFails} grid cells hidden` : '') + (shown ? `; failures: ${shown}` + (fl.length > 4 ? ` +${fl.length - 4} more` : '') : '') +
    (r.checked === 0 ? '; nothing found in body' : ''));
}

// ---------- page checks ----------
const isWho = p => /(^|\/)who\/?(index\.html)?$/.test(p);

async function mainPageChecks(browser, P, csv) {
  const { ctx, page } = await fresh(browser, DESK);
  const errors = watchErrors(page, P.url);
  const out = { links: [] };
  try {
    // 1. errors after load + slow wheel scroll
    await guard(P.label, '1 console/page errors', async () => {
      await page.goto(P.url, { waitUntil: 'load' });
      await sleep(1500);
      const s = await wheelScroll(page);
      await sleep(800);
      const reached = s.y >= s.H - 2;
      line(errors.length === 0 && reached, P.label, '1 console/page errors',
        `${errors.length} errors, scrolled ${s.steps} wheel steps to ${s.y}/${s.H}px` + (reached ? '' : ' (did not reach bottom)') +
        (errors.length ? ': ' + errors.slice(0, 5).join(' | ') + (errors.length > 5 ? ` +${errors.length - 5} more` : '') : ''));
    });
    await page.evaluate(() => scrollTo(0, 0)).catch(() => {});
    await sleep(500);

    // 11. structure
    await guard(P.label, '11 structure', async () => {
      const s = await page.evaluate(() => {
        const abs = h => { try { return new URL(h, location.href); } catch { return null; } };
        const all = [...document.querySelectorAll('a[href]')].map(a => ({ raw: a.getAttribute('href'), u: abs(a.getAttribute('href')), inNav: !!a.closest('nav,[role=navigation]') }));
        return {
          h1: document.querySelectorAll('h1').length, hasNav: !!document.querySelector('nav,[role=navigation]'),
          nav: all.filter(a => a.inNav).map(a => ({ raw: a.raw, href: a.u && a.u.href, path: a.u && a.u.pathname, hash: a.u && a.u.hash, same: a.u && a.u.origin === location.origin })),
          any: all.map(a => a.u && a.u.href).filter(Boolean),
          ids: ['skillproof', 'datproof', 'modelproof'].filter(id => document.getElementById(id)),
        };
      });
      line(s.h1 === 1, P.label, '11 exactly one h1', `${s.h1} h1`);
      if (P.role === 'home') {
        const want = ['skillproof', 'datproof', 'modelproof'];
        const miss = want.filter(id => !s.nav.some(a => a.hash === '#' + id)).map(id => '#' + id);
        if (!s.nav.some(a => a.same && /\/who\/(index\.html)?$/.test(a.path || '') && !a.hash)) miss.push('who/');
        const noTarget = want.filter(id => !s.ids.includes(id)).map(id => '#' + id);
        line(s.hasNav && !miss.length && !noTarget.length, P.label, '11 nav links',
          !s.hasNav ? 'no <nav> element' :
            `${s.nav.length} nav links` + (miss.length ? `; missing ${miss.join(' ')}` : '; has #skillproof #datproof #modelproof who/') +
            (noTarget.length ? `; no element with id ${noTarget.join(' ')}` : ''));
      } else {
        const want = [
          ['github.com/lucascashwell3-ai', u => /^https:\/\/github\.com\/lucascashwell3-ai\/?$/i.test(u)],
          ['linkedin.com/in/lucas-cashwell', u => /^https:\/\/(www\.)?linkedin\.com\/in\/lucas-cashwell\/?$/i.test(u)],
          ['x.com/cashwell21', u => /^https:\/\/(www\.)?x\.com\/cashwell21\/?$/i.test(u)],
          ['mailto:lucascashwell3@gmail.com', u => /^mailto:lucascashwell3@gmail\.com(\?.*)?$/i.test(u)],
        ];
        const miss = want.filter(([, t]) => !s.any.some(t)).map(([n]) => n);
        line(!miss.length, P.label, '11 contact links', miss.length ? `missing ${miss.join(', ')}` : want.map(([n]) => n).join(', '));
      }
      out.links = s.any;
    });

    if (P.role === 'home') {
      // 8a. the word
      await guard(P.label, '8a hero h1 text', async () => {
        const t = await page.evaluate(() => { const h = document.querySelector('h1'); return h ? h.textContent.trim() : null; });
        line(t === 'Welcome', P.label, '8a hero h1 text', t === null ? 'no h1' : JSON.stringify(t));
      });

      // 9. DATproof numbers
      await guard(P.label, '9 DATproof total', async () => {
        const has = await page.evaluate(() => !!document.querySelector('.dp-num'));
        if (!has) { line(false, P.label, '9 DATproof total', 'no DATproof block (.dp-num) on page'); return; }
        const t = await pageTotal(page);
        const exact = t.dataTotal === csv.total;
        const shownOk = t.shown === Math.round(csv.total);
        const d = new Date(t.throughText + ' 00:00 UTC');
        const textIso = isNaN(d) ? null : d.toISOString().slice(0, 10);
        const thruOk = t.through === csv.through && textIso === csv.through;
        line(exact && shownOk && thruOk, P.label, '9 DATproof total',
          `data-total ${t.dataTotal} vs CSV ${csv.totalExact} (${csv.rows} buys) ${exact ? '=' : '≠'}; shown ${t.shown} vs round ${Math.round(csv.total)} ${shownOk ? '=' : '≠'}; ` +
          `through ${t.through} "${t.throughText}" vs CSV ${csv.through} ${thruOk ? '=' : '≠'}`);
      });

      // 10. How it's built
      await guard(P.label, '10 how-it\'s-built toggles', async () => {
        const btns = page.locator('button, [role="button"]').filter({ hasText: /how it.?s built/i });
        const n = await btns.count();
        if (!n) { line(false, P.label, '10 how-it\'s-built toggles', '0 "How it\'s built" buttons found'); return; }
        const errBefore = errors.length;
        const state = i => btns.nth(i).evaluate(b => {
          const ids = (b.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean);
          const p = ids.length ? document.getElementById(ids[0]) : null;
          if (!p) return { exp: b.getAttribute('aria-expanded'), panel: null };
          const r = p.getBoundingClientRect(), c = getComputedStyle(p);
          let o = 1; for (let a = p; a && a.nodeType === 1; a = a.parentElement) o *= parseFloat(getComputedStyle(a).opacity);
          const shown = c.display !== 'none' && c.visibility === 'visible' && !p.hidden && !p.closest('[inert]');
          return { exp: b.getAttribute('aria-expanded'), panel: p.id, h: Math.round(r.height), text: shown ? (p.innerText || '').trim().length : 0, o: Math.round(o * 100) / 100, shown };
        });
        const settle = () => sleep(900);
        const bad = [], good = [];
        for (let i = 0; i < n; i++) {
          const b = btns.nth(i);
          const name = `#${i + 1}`;
          const s0 = await state(i);
          if (!s0.panel) { bad.push(`${name}: no aria-controls panel (aria-expanded=${s0.exp})`); continue; }
          if (s0.exp !== 'false') bad.push(`${name}: starts aria-expanded=${s0.exp}`);
          await b.scrollIntoViewIfNeeded();
          await b.click(); await settle();
          const s1 = await state(i);
          const open1 = s1.exp === 'true' && s1.h > 0 && s1.text > 0 && s1.o >= 0.99;
          await b.click(); await settle();
          const s2 = await state(i);
          const shut2 = s2.exp === 'false' && (s2.h < 1 || !s2.shown);
          await b.focus(); await page.keyboard.press('Enter'); await settle();
          const s3 = await state(i);
          const open3 = s3.exp === 'true' && s3.h > 0 && s3.text > 0 && s3.o >= 0.99;
          await page.keyboard.press('Enter'); await settle();
          const s4 = await state(i);
          const shut4 = s4.exp === 'false' && (s4.h < 1 || !s4.shown);
          const desc = `${name} click open ${s1.exp}/${s1.h}px/${s1.text}ch, close ${s2.exp}/${s2.h}px, Enter open ${s3.exp}/${s3.h}px, Enter close ${s4.exp}/${s4.h}px`;
          (open1 && shut2 && open3 && shut4 ? good : bad).push(desc);
        }
        const newErr = errors.slice(errBefore);
        line(!bad.length && !newErr.length, P.label, '10 how-it\'s-built toggles',
          `${n} buttons, ${good.length} ok` + (bad.length ? '; ' + bad.join('; ') : '') + (newErr.length ? '; errors: ' + newErr.slice(0, 3).join(' | ') : ''));
      });
    }
  } finally { await ctx.close(); }
  return out;
}

async function phoneOverflow(browser, P, wantLcp) {
  const { ctx, page } = await fresh(browser, PHONE);
  try {
    if (wantLcp) await page.addInitScript(() => {
      window.__lcp = [];
      try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lcp.push(e); }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch {}
    });
    await page.goto(P.url, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
    await sleep(1500);
    let lcp = null;
    if (wantLcp) lcp = await page.evaluate(() => {
      const e = (window.__lcp || []).at(-1); if (!e) return null; const el = e.element;
      return { tag: el ? el.tagName.toLowerCase() : null, id: el && el.id, text: el ? el.textContent.trim().slice(0, 40) : null, ms: Math.round(e.startTime) };
    });
    await page.evaluate(PAGE_LIB);
    let worst = null, sw = 0, vw = 0, n = 0;
    await stepScroll(page, {
      wait: 200, onStep: async () => {
        const r = await page.evaluate(OVERFLOW_PROBE);
        sw = Math.max(sw, r.sw); vw = r.vw; n = Math.max(n, r.n);
        if (r.worst && (!worst || r.worst.over > worst.over)) worst = r.worst;
      },
    });
    const ok = sw <= vw && !worst;
    line(ok, P.label, '2 no horizontal scroll 390', `scrollWidth ${sw} / clientWidth ${vw}; ` +
      (worst ? `worst element ${worst.el} sticks out ${worst.over}px (x ${worst.left}..${worst.right})` : `0 of ${n} elements past the viewport`));
    return lcp;
  } finally { await ctx.close(); }
}

// ---------- DATproof grid fill, motion on ----------
// The grid is complete in the HTML; with motion on, the script hides the cells until the grid scrolls into view,
// then fills them once. Proves: hidden before entering view, filling just after, all visible 3 s later, and
// scrolling away and back never replays it (every cell stays at full opacity on every frame after returning).
async function gridFillCheck(browser, P) {
  const { ctx, page } = await fresh(browser, { ...DESK, reducedMotion: 'no-preference' });
  const errors = watchErrors(page, P.url);
  try {
    await page.goto(P.url, { waitUntil: 'load' });
    await sleep(800);   // the observer's first report arms the fill
    const count = () => page.evaluate(() => {
      const rows = document.getElementById('dpRows'); if (!rows) return null;
      const cells = [...rows.querySelectorAll('path[data-w]')], r = rows.getBoundingClientRect();
      let hidden = 0, part = 0, running = 0;
      for (const c of cells) {
        let o = 1; for (let a = c; a && a.nodeType === 1; a = a.parentElement) o *= parseFloat(getComputedStyle(a).opacity);
        if (o < 0.01) hidden++; else if (o < 0.99) part++;
        running += c.getAnimations().filter(a => a.playState === 'running').length;
      }
      return { n: cells.length, hidden, part, running, inView: r.top < innerHeight && r.bottom > 0 };
    });
    const before = await count();
    if (!before) { line(false, P.label, '9 DATproof grid fill (motion)', 'no #dpRows on page'); return; }
    await page.evaluate(() => document.getElementById('dpRows').scrollIntoView({ block: 'center', behavior: 'instant' }));
    await sleep(250);
    const during = await count();
    await sleep(3000);
    const after = await count();
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    await sleep(800);
    const again = await page.evaluate(async () => {
      const rows = document.getElementById('dpRows'), cells = [...rows.querySelectorAll('path[data-w]')];
      rows.scrollIntoView({ block: 'center', behavior: 'instant' });
      let minO = 1, frames = 0, running = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < 1500) {
        await new Promise(r => requestAnimationFrame(r)); frames++;
        let run = 0;
        for (const c of cells) {
          let o = 1; for (let a = c; a && a.nodeType === 1; a = a.parentElement) o *= parseFloat(getComputedStyle(a).opacity);
          minO = Math.min(minO, o); run += c.getAnimations().filter(a => a.playState === 'running').length;
        }
        running = Math.max(running, run);
      }
      return { minO: Math.round(minO * 100) / 100, frames, running };
    });
    const filled = !before.inView && before.n > 0 && before.hidden === before.n && during.hidden + during.part > 0;
    const ok = filled && after.hidden === 0 && after.part === 0 && again.minO >= 0.99 && again.running === 0 && !errors.length;
    line(ok, P.label, '9 DATproof grid fill (motion)',
      `before view ${before.hidden}/${before.n} hidden${before.inView ? ' (grid already in view at load)' : ''}; ` +
      `250 ms after entering ${during.hidden} hidden, ${during.part} fading; 3 s later ${after.hidden}/${after.n} hidden, ${after.part} fading; ` +
      `away and back: min cell opacity ${again.minO} over ${again.frames} frames, ${again.running} animations running; ${errors.length} errors` +
      (errors.length ? ': ' + errors.slice(0, 2).join(' | ') : ''));
  } finally { await ctx.close(); }
}

// ---------- hero ----------
async function hasHero(page) {
  try { await page.waitForSelector('canvas.sky-gl', { state: 'attached', timeout: 3000 }); } catch { return false; }
  return page.evaluate(() => !!window.__hero).catch(() => false);
}

async function heroChecks(gpu, P) {
  const L = P.label;
  // availability probe
  {
    const { ctx, page } = await fresh(gpu, DESK);
    let ok = false;
    try { await page.goto(P.url, { waitUntil: 'load' }); ok = await hasHero(page); } finally { await ctx.close(); }
    if (!ok) {
      for (const c of ['8b sunset scan', '8c gpu frame 1440x900', '8c gpu frame 390x844', '8d no-WebGL fallback', '8e frames off-screen/handoff/RM', '8f font-metric fallback'])
        if (!(QUICK && c.startsWith('8b'))) line(false, L, c, 'no hero on page (canvas.sky-gl / window.__hero missing)');
      return;
    }
  }
  if (!QUICK) await guard(L, '8b sunset scan', async () => {
    note(`sunset scan ${L} (${Math.round(1 / B.scanStep) + 1} steps)`);
    const { ctx, page } = await fresh(gpu, DESK);
    try {
      await page.goto(P.url, { waitUntil: 'load' });
      const r = await sunsetScan(page, { step: B.scanStep, contactSheet: SHEET || undefined });
      if (r.error) { line(false, L, '8b sunset scan', r.error); return; }
      const f = r.artifactFrames;
      line(f.length === 0 && r.steps > 0, L, '8b sunset scan', `${r.steps} steps at ${B.scanStep * 100}%, ${f.length} flagged` +
        (f.length ? ': p ' + f.slice(0, 8).map(x => `${x.p}(${x.darkWord}+${x.darkLine}px)`).join(' ') : '') + (SHEET ? `; sheet ${SHEET}` : ''));
    } finally { await ctx.close(); }
  });
  // The budget is on the MEAN GPU time per frame, gated at 1440x900 dpr 2 (a laptop's real pixel count; the hero caps its
  // buffer at 1.5x). p95 is printed beside every mean, and dpr 1 is printed for reference, so neither hides.
  const gpuRun = async o => {
    const { ctx, page } = await fresh(gpu, o);
    try { await page.goto(P.url, { waitUntil: 'load' }); return await gpuFrameTime(page); } finally { await ctx.close(); }
  };
  for (const [c, o, budget, ref] of [['8c gpu frame 1440x900', { ...DESK, deviceScaleFactor: 2 }, B.gpuDeskMs, DESK], ['8c gpu frame 390x844', PHONE, B.gpuPhoneMs]]) {
    await guard(L, c, async () => {
      const r = await gpuRun(o);
      if (r.error) { line(false, L, c, r.error); return; }
      const r1 = ref ? await gpuRun(ref) : null;
      line(r.mean <= budget && r.frames > 0, L, c, `dpr ${r.dpr}: mean ${r.mean} ms, p95 ${r.p95} ms over ${r.frames} frames (budget: mean ≤ ${budget} ms at dpr ${r.dpr})` +
        (r1 ? r1.error ? `; dpr 1: ${r1.error}` : `; dpr ${r1.dpr} for reference: mean ${r1.mean} ms, p95 ${r1.p95} ms` : '') + `; ${cut(r.renderer, 48)}`);
    });
  }
  await guard(L, '8d no-WebGL fallback', async () => {
    const { ctx, page } = await fresh(gpu, DESK);
    try {
      const r = await noWebGL(page, P.url);
      line(r.fallback && r.h1Visible && !r.errors.length, L, '8d no-WebGL fallback',
        `fallback ${r.fallback} (mode ${r.mode}, sky-css ${r.skyCss}, canvas opacity ${r.canvasOpacity}), h1 visible ${r.h1Visible}, ${r.errors.length} errors` +
        (r.errors.length ? ': ' + r.errors.slice(0, 3).join(' | ') : ''));
    } finally { await ctx.close(); }
  });
  await guard(L, '8f font-metric fallback', async () => {
    // an engine without fontBoundingBoxAscent must still draw, with no NaN in any uniform and no errors
    const run = async stub => { const { ctx, page } = await fresh(gpu, DESK); try { return await fontMetricFallback(page, P.url, { stub }); } finally { await ctx.close(); } };
    const s = await run(true), real = await run(false);
    const dPx = Number.isFinite(s.uBase) && Number.isFinite(real.uBase) ? Math.abs(s.uBase - real.uBase) * s.canvasH : NaN;
    const ok = s.ready && s.mode === 'gl' && s.frames > 0 && s.calls > 0 && !s.bad.length && !s.errors.length && dPx <= 1.5;
    line(ok, L, '8f font-metric fallback', `metric stubbed out: mode ${s.mode}, ${s.frames} frames, ${s.calls} float uniforms sent, ${s.bad.length} not finite` +
      (s.bad.length ? ` (${s.bad.slice(0, 3).join('; ')})` : '') + `, ${s.errors.length} errors` + (s.errors.length ? ': ' + s.errors.slice(0, 2).join(' | ') : '') +
      `; horizon uBase ${s.uBase} vs ${real.uBase} with the real metric (${Number.isFinite(dPx) ? dPx.toFixed(2) : 'n/a'} css px apart, ≤ 1.5 allowed)`);
  });
  await guard(L, '8e frames off-screen/handoff/RM', async () => {
    note(`frame counts ${L} (~40 s)`);
    const { ctx, page } = await fresh(gpu, DESK);
    try {
      const r = await frameCounts(page, P.url);
      const ok = r.offscreen === 0 && r.handedOff === 0 && r.reduced === 0 && r.hidden === 0;
      line(ok, L, '8e frames off-screen/handoff/RM',
        `fps: off-screen ${r.offscreen}, handed-off ${r.handedOff}, reduced ${r.reduced}, hidden ${r.hidden} (${r.hiddenMethod}); ` +
        `for reference idle ${r.idle}, pointer ${r.pointerMoving}, scrolling ${r.scrolling}, reduced+scroll ${r.reducedScrolling}`);
    } finally { await ctx.close(); }
  });
}

// ---------- 6. back/forward cache ----------
async function bfCheck(bf, P, awayUrl) {
  const { ctx, page } = await fresh(bf, DESK);
  try {
    const r = await bfcacheRestore(page, P.url, { awayUrl });
    // with the hero, the page must let go of the GPU on the way out and build it again on the way back
    const ev = JSON.stringify(r.contextEvents || []);
    const heroOk = r.hero ? r.canvasPaintsAfter > 0 && r.nonBlank && ev === '["lost","restored"]' : P.role !== 'home';
    line(r.persisted && !r.errors.length && heroOk, P.label, '6 back/forward cache',
      `persisted ${r.persisted}, ${r.errors.length} errors` +
      (r.hero ? `, context events ${ev} (want ["lost","restored"]), canvas paints after ${r.canvasPaintsAfter}, non-blank ${r.nonBlank}` : P.role === 'home' ? ', no hero canvas on page' : '') +
      (r.errors.length ? ': ' + r.errors.slice(0, 3).join(' | ') : '') + (r.notRestoredReasons ? '; not restored: ' + cut(r.notRestoredReasons, 200) : ''));
  } finally { await ctx.close(); }
}

// ---------- 7. external links ----------
async function linkChecks(linkMap) {
  const mails = [...linkMap.keys()].filter(u => /^mailto:/i.test(u));
  const webs = [...linkMap.keys()].filter(u => /^https?:/i.test(u));
  const at = u => [...linkMap.get(u)].join(',');
  for (const m of mails) {
    const addr = decodeURIComponent(m.slice(7).split('?')[0]);
    const ok = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(addr);
    line(ok, at(m), '7 mailto format', `${m} ${ok ? 'valid' : 'invalid'} address`);
  }
  const others = [...linkMap.keys()].filter(u => !/^(mailto|https?):/i.test(u));
  for (const o of others) line(false, at(o), '7 external link', `unsupported scheme ${o}`);
  if (!webs.length) return;
  note(`external links: ${webs.length} in Chrome`);
  let browser;
  try { browser = await chromium.launch({ channel: 'chrome', headless: true }); }
  catch (e) { for (const u of webs) line(false, at(u), '7 external link', `${u} could not launch Chrome: ${cut(e.message.split('\n')[0], 100)}`); return; }
  try {
    const major = (browser.version().match(/^\d+/) || ['140'])[0];
    const ua = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
    const ctx = await browser.newContext({ userAgent: ua, viewport: { width: 1440, height: 900 }, locale: 'en-US' });
    const queue = [...webs];
    const worker = async () => {
      while (queue.length) {
        const u = queue.shift();
        const page = await ctx.newPage();
        let status = null, final = u, hops = 0, err = null, tries = 0;
        // one retry on a thrown navigation error (a network stall), and the retry is printed; a real status never retries
        while (tries < 2) {
          tries++; err = null;
          try {
            const res = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 });
            if (res) {
              status = res.status(); final = res.url();
              for (let q = res.request().redirectedFrom(); q; q = q.redirectedFrom()) hops++;
            }
            break;
          } catch (e) { err = cut(e.message.split('\n')[0], 120); }
        }
        await page.close().catch(() => {});
        const host = (() => { try { return new URL(u).host; } catch { return ''; } })();
        // only a true 200 passes. One exception is printed as SKIP, never PASS: www.linkedin.com answering 999 with
        // no redirect. LinkedIn sends 999 to every automated client, so no script can tell a live profile from a dead one.
        let ok = status === 200, v;
        const redir = hops ? ` -> ${final} (${hops} redirect${hops > 1 ? 's' : ''})` : '';
        if (err) v = `${u} error: ${err}`;
        else if (status === 999 && host === 'www.linkedin.com' && hops === 0) {
          ok = 'skip';
          v = `999 ${u} (LinkedIn answers 999 to every automated client; not machine-checkable — confirm by hand)`;
        } else v = `${status} ${u}${redir}`;
        if (tries > 1) v += ` (after 1 retry)`;
        line(ok, at(u), '7 external link', v);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    await ctx.close();
  } finally { await browser.close(); }
}

// ---------- 5. Lighthouse ----------
const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function findNode(d) {
  if (!d || typeof d !== 'object') return null;
  if (d.type === 'node' && (d.snippet || d.selector)) return d;
  for (const v of Array.isArray(d) ? d : Object.values(d)) { const n = findNode(v); if (n) return n; }
  return null;
}

async function lighthouseChecks(pages) {
  const { default: lighthouse } = await import('lighthouse');
  const chromeLauncher = await import('chrome-launcher');
  const chrome = await chromeLauncher.launch({
    chromePath: chromium.executablePath(),
    chromeFlags: ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', ...gpuLaunchOptions.args],
  });
  const lcpEls = {};
  try {
    for (const P of pages) {
      const runs = [];
      for (let i = 0; i < LH_RUNS; i++) {
        note(`lighthouse ${P.label} run ${i + 1}/${LH_RUNS}`);
        try {
          const r = await lighthouse(P.url, { port: chrome.port, output: 'json', logLevel: 'error', disableFullPageScreenshot: true,
            onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'] });
          const lhr = r.lhr;
          if (lhr.runtimeError) { runs.push({ error: lhr.runtimeError.code + ' ' + (lhr.runtimeError.message || '') }); continue; }
          const sc = k => lhr.categories[k] && lhr.categories[k].score !== null ? Math.round(lhr.categories[k].score * 100) : null;
          const nv = k => lhr.audits[k] ? lhr.audits[k].numericValue : null;
          const node = findNode(lhr.audits['largest-contentful-paint-element'] && lhr.audits['largest-contentful-paint-element'].details);
          const bfA = lhr.audits['bf-cache'];
          const failA = k => Object.values(lhr.audits).filter(a => lhr.categories[k] && lhr.categories[k].auditRefs.some(r => r.id === a.id && r.weight > 0) && a.score !== null && a.score < 1).map(a => a.id);
          runs.push({ perf: sc('performance'), a11y: sc('accessibility'), bp: sc('best-practices'), seo: sc('seo'),
            lcp: nv('largest-contentful-paint'), cls: nv('cumulative-layout-shift'), tbt: nv('total-blocking-time'),
            lcpNode: node ? { selector: node.selector || '', snippet: node.snippet || '', label: node.nodeLabel || '' } : null,
            bf: bfA ? (bfA.scoreDisplayMode === 'notApplicable' ? 'n/a' : bfA.score === 1 ? 'pass' : 'fail: ' + ((bfA.details && bfA.details.items || []).map(x => x.reason).filter(Boolean).slice(0, 2).join('; ') || bfA.displayValue || '')) : 'missing',
            a11yFails: failA('accessibility'), bpFails: failA('best-practices'), seoFails: failA('seo') });
        } catch (e) { runs.push({ error: cut(e.message.split('\n')[0], 120) }); }
      }
      const good = runs.filter(r => !r.error);
      const errs = runs.filter(r => r.error);
      const L = P.label;
      if (!good.length) { line(false, L, '5 lighthouse', `all ${runs.length} runs failed: ${errs.map(e => e.error).slice(0, 2).join(' | ')}`); continue; }
      const col = k => good.map(r => r[k]).filter(v => v !== null && v !== undefined);
      const errNote = errs.length ? ` [${errs.length} failed runs: ${cut(errs[0].error, 60)}]` : '';
      const uniq = a => [...new Set(a.flat())];
      const score = (k, name, test, want, failsKey) => {
        const v = col(k); const m = v.length ? median(v) : null;
        const f = failsKey ? uniq(good.map(r => r[failsKey])) : [];
        line(m !== null && test(m) && !errs.length, L, `5 lh ${name}`, `median ${m} (${want}; runs ${v.join(' ')})` + (f.length && m !== 100 ? `; failing audits: ${f.slice(0, 6).join(', ')}` : '') + errNote);
      };
      score('perf', 'performance', m => m >= B.perf, `≥${B.perf}`);
      score('a11y', 'accessibility', m => m === B.a11y, `=${B.a11y}`, 'a11yFails');
      score('bp', 'best-practices', m => m >= B.bp, `≥${B.bp}`, 'bpFails');
      score('seo', 'seo', m => m >= B.seo, `≥${B.seo}`, 'seoFails');
      const lcp = median(col('lcp')), cls = median(col('cls')), tbt = median(col('tbt'));
      line(lcp <= B.lcpMs, L, '5 lh LCP', `median ${(lcp / 1000).toFixed(2)} s (≤${B.lcpMs / 1000} s; runs ${col('lcp').map(v => (v / 1000).toFixed(2)).join(' ')})`);
      line(cls <= B.cls, L, '5 lh CLS', `median ${cls.toFixed(3)} (≤${B.cls}; runs ${col('cls').map(v => v.toFixed(3)).join(' ')})`);
      line(tbt <= B.tbtMs, L, '5 lh TBT', `median ${Math.round(tbt)} ms (≤${B.tbtMs}; runs ${col('tbt').map(Math.round).join(' ')})`);
      const bfs = good.map(r => r.bf), bfPass = bfs.filter(b => b === 'pass' || b === 'n/a').length;
      line(bfPass === good.length, L, '5 lh bf-cache audit', `${bfPass}/${good.length} runs pass` + (bfPass < good.length ? ': ' + [...new Set(bfs.filter(b => b !== 'pass'))].join(' | ') : ''));
      const els = good.map(r => r.lcpNode ? `${r.lcpNode.selector || r.lcpNode.snippet} "${cut(r.lcpNode.label, 30)}"` : 'none');
      const counts = {}; els.forEach(e => counts[e] = (counts[e] || 0) + 1);
      lcpEls[L] = { counts, nodes: good.map(r => r.lcpNode), n: good.length };
    }
  } finally { await chrome.kill(); }
  return lcpEls;
}

// ---------- main ----------
async function main() {
  let server = null, base = opt('--base', null);
  if (!base) { server = await serve({ root: REPO, port: 0 }); base = server.url; note(`serving repo at ${base}`); }
  if (!base.endsWith('/')) base += '/';
  const pages = PAGE_PATHS.map(p => ({ label: p, url: new URL(p.replace(/^\/+/, ''), base).href, role: isWho(p) ? 'who' : 'home' }));
  PW = Math.max(4, ...pages.map(p => p.label.length));
  const csv = csvTotal(resolve(REPO, 'data/datproof'));

  const live = [];
  for (const P of pages) {
    let status = null, bytes = 0, err = null;
    try { const r = await fetch(P.url, { redirect: 'follow' }); status = r.status; bytes = (await r.arrayBuffer()).byteLength; } catch (e) { err = e.message; }
    const ok = status === 200;
    line(ok, P.label, '0 page loads', err ? `error: ${err}` : `HTTP ${status}, ${(bytes / 1024).toFixed(1)} KB` + (ok ? '' : ' (page missing: every other check for it fails)'));
    if (ok) live.push(P);
    else line(false, P.label, 'all checks', 'not run: page missing');
  }

  const linkMap = new Map();
  let away = null;
  for (const c of ['assets/site.css', 'assets/datproof.js']) {
    try { const r = await fetch(new URL(c, base)); if (r.ok) { away = new URL(c, base).href; break; } } catch {}
  }

  const gpu = await chromium.launch(gpuLaunchOptions);
  const quickLcp = {};
  try {
    for (const P of live) {
      note(`page checks ${P.label}`);
      const m = await guard(P.label, '1 page checks', () => mainPageChecks(gpu, P, csv));
      for (const u of (m && m.links) || []) {
        let ext = false;
        try { const x = new URL(u); ext = x.protocol === 'mailto:' || ((x.protocol === 'http:' || x.protocol === 'https:') && x.origin !== new URL(P.url).origin) || !/^(https?|mailto):$/.test(x.protocol); } catch {}
        if (ext) { const key = u.replace(/#.*$/, ''); if (!linkMap.has(key)) linkMap.set(key, new Set()); linkMap.get(key).add(P.label); }
      }
      const lcp = await guard(P.label, '2 no horizontal scroll 390', () => phoneOverflow(gpu, P, QUICK && P.role === 'home'));
      if (lcp !== undefined) quickLcp[P.label] = lcp;
      await guard(P.label, '3 reduced-motion visibility', async () => {
        const r = await visibilityRun(gpu, P.url, { reducedMotion: 'reduce' }, false);
        visLine(P.label, '3 reduced-motion visibility', r);
        if (P.role === 'home') line(r.gridCells > 0 && r.gridOk === r.gridCells, P.label, '9 DATproof grid (reduced mo.)', r.gridCells ? `${r.gridOk}/${r.gridCells} cells visible` : 'no grid cells (.dp-rows path[data-w])');
      });
      await guard(P.label, '4 JS-off visibility', async () => {
        const r = await visibilityRun(gpu, P.url, { javaScriptEnabled: false }, true);
        visLine(P.label, '4 JS-off visibility', r);
        if (P.role === 'home') line(r.gridCells > 0 && r.gridOk === r.gridCells, P.label, '9 DATproof grid (JS off)', r.gridCells ? `${r.gridOk}/${r.gridCells} cells visible` : 'no grid cells (.dp-rows path[data-w])');
      });
      if (P.role === 'home') await guard(P.label, '9 DATproof grid fill (motion)', () => gridFillCheck(gpu, P));
    }
    for (const P of live.filter(p => p.role === 'home')) {
      note(`hero checks ${P.label}`);
      await heroChecks(gpu, P);
    }
  } finally { await gpu.close(); }

  const bf = await chromium.launch(bfcacheLaunchOptions);
  try {
    for (const P of live) {
      const a = away || pages.find(q => q !== P && live.includes(q))?.url || base;
      await guard(P.label, '6 back/forward cache', () => bfCheck(bf, P, a));
    }
  } finally { await bf.close(); }

  await guard('all', '7 external links', () => linkChecks(linkMap));
  if (live.length && !linkMap.size) line(false, 'all', '7 external links', 'no external links found');

  if (!QUICK && live.length) {
    const lcpEls = await guard('all', '5 lighthouse', () => lighthouseChecks(live)) || {};
    for (const P of live.filter(p => p.role === 'home')) {
      const e = lcpEls[P.label];
      if (!e) { line(false, P.label, '8a hero is LCP element', 'no Lighthouse result'); continue; }
      const hits = e.nodes.filter(n => n && /^<h1\b/i.test(n.snippet) && n.label.trim() === 'Welcome').length;
      line(hits === e.n, P.label, '8a hero is LCP element', `lighthouse: ` + Object.entries(e.counts).map(([k, c]) => `${k} ${c}/${e.n}`).join('; '));
    }
  } else if (QUICK) {
    for (const P of live.filter(p => p.role === 'home')) {
      const l = quickLcp[P.label];
      const ok = !!l && l.tag === 'h1' && l.text === 'Welcome';
      line(ok, P.label, '8a hero is LCP element', l ? `in-page (quick, 390x844, no throttling): ${l.tag}${l.id ? '#' + l.id : ''} "${l.text}" at ${l.ms} ms` : 'no LCP entry');
    }
  }

  if (server) await server.close();
  const skips = results.filter(r => r.skip).length;
  const passes = results.filter(r => r.ok).length;
  const fails = results.length - passes - skips;
  const secs = ((Date.now() - T0) / 1000).toFixed(0);
  process.stdout.write(`${fails ? 'FAIL' : 'PASS'}  summary  ${results.length} checks, ${passes} passed, ${fails} failed, ${skips} skipped, ${secs} s${QUICK ? ' (quick: no Lighthouse, no sunset scan)' : ''}\n`);
  process.exitCode = fails ? 1 : 0;
}

main().catch(e => {
  process.stdout.write(`FAIL  summary  crashed: ${e.stack || e}\n`);
  process.exitCode = 2;
});
