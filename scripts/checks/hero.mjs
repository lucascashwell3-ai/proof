// Playwright checks for the First Light hero. Plain async functions, no test framework.
// Every function takes a Playwright Page; the ones that need a fresh load also take its URL.
import { writeFile } from 'node:fs/promises';

// New headless Chrome (channel "chromium") drives the real GPU through ANGLE and exposes
// EXT_disjoint_timer_query_webgl2. The bundled headless shell falls back to SwiftShader and has no timer queries.
export const gpuLaunchOptions = {
  channel: 'chromium',
  args: ['--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-webgl-draft-extensions'],
};
// Playwright launches Chromium with --disable-back-forward-cache; drop it so back/forward restores from the cache.
export const bfcacheLaunchOptions = {
  ...gpuLaunchOptions,
  ignoreDefaultArgs: ['--disable-back-forward-cache'],
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function collectErrors(page) {
  const errors = [];
  const onErr = e => errors.push('pageerror: ' + e.message);
  // the away page used by bfcacheRestore has no icon, so the browser asks for /favicon.ico; that is not the hero's error
  const onCon = m => { if (m.type() === 'error' && !/\/favicon\.ico$/.test(m.location().url || '')) errors.push('console: ' + m.text() + ' ' + (m.location().url || '')); };
  page.on('pageerror', onErr); page.on('console', onCon);
  return { errors, off: () => { page.off('pageerror', onErr); page.off('console', onCon); } };
}

export async function heroReady(page, timeout = 15000) {
  await page.waitForFunction(() => {
    const h = window.__hero; if (!h) return false;
    const m = h.state().mode;
    return m === 'nogl' || (m === 'gl' && h.frameCount() > 0);
  }, null, { timeout });
  return page.evaluate(() => window.__hero.state());
}

// ---------- in-page pixel helpers (screenshots are decoded inside the page with createImageBitmap) ----------
async function decode(page, bufs) {
  return page.evaluate(async list => {
    const out = [];
    for (const b64 of list) {
      const bin = atob(b64), u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([u8], { type: 'image/png' }));
      const oc = new OffscreenCanvas(bmp.width, bmp.height), cx = oc.getContext('2d');
      cx.drawImage(bmp, 0, 0);
      const d = cx.getImageData(0, 0, bmp.width, bmp.height).data, Y = new Float32Array(bmp.width * bmp.height);
      for (let i = 0, j = 0; i < d.length; i += 4, j++) Y[j] = .2126 * d[i] + .7152 * d[i + 1] + .0722 * d[i + 2];
      out.push({ w: bmp.width, h: bmp.height, Y: Array.from(Y) });
    }
    return out;
  }, bufs.map(b => b.toString('base64')));
}

// ---------- sunsetScan ----------
// Walks night to day in `step` increments. At each step it renders the frame twice at the same scene time:
// A = the real frame; R = the same frame with the contrast guard switched off and the text layer hidden.
// Where A is darker than R outside a tight band around the glyphs, something non-glyph-shaped is darkening the sky
// behind the text (a box). The band is the guard's designed reach: ~10 css px around the word (a blurred mip level)
// and ~4 css px around the small line (a ring of taps), plus the half-resolution upscale.
export async function sunsetScan(page, opts = {}) {
  const { step = 0.005, from = 0, to = 1, contactSheet, darkLevels = 3, minArea = 24, wordReach = 18, lineReach = 8,
    pad = 40, settleMs = 400, only } = opts;
  let st = await page.evaluate(() => window.__hero && window.__hero.state());
  if (!st || !st.manual) {
    await page.addInitScript(() => { window.__HERO_MANUAL_CLOCK = true; });
    await page.reload({ waitUntil: 'load' });
  }
  st = await heroReady(page);
  if (st.mode !== 'gl') return { steps: 0, artifactFrames: [], error: 'hero is not running WebGL (mode ' + st.mode + ')' };
  // switch the guard off from outside: before each scene draw, zero uGuardMode when asked
  await page.evaluate(() => {
    const gl = document.querySelector('canvas.sky-gl').getContext('webgl2');
    if (gl.__scanPatched) return; gl.__scanPatched = true;
    const draw = gl.drawArrays.bind(gl), locs = new WeakMap();
    gl.drawArrays = (...a) => {
      if (window.__guardOff) {
        const p = gl.getParameter(gl.CURRENT_PROGRAM);
        if (p) { if (!locs.has(p)) locs.set(p, gl.getUniformLocation(p, 'uGuardMode')); const l = locs.get(p); if (l) gl.uniform2f(l, 0, 0); }
      }
      return draw(...a);
    };
  });
  await page.evaluate(() => { window.__tick(3200); document.getAnimations().forEach(a => a.finish()); });
  await sleep(1300);
  // glyph geometry: tight ink boxes from Ranges, and a pure glyph mask from a black-on-white render
  const geo = await page.evaluate(pad => {
    const r = el => { const g = document.createRange(); g.selectNodeContents(el); return g.getBoundingClientRect(); };
    const w = r(document.getElementById('welcome')), b = r(document.querySelector('.hero .byline'));
    const x0 = Math.max(0, Math.floor(Math.min(w.left, b.left) - pad)), y0 = Math.max(0, Math.floor(w.top - pad));
    const x1 = Math.min(innerWidth, Math.ceil(Math.max(w.right, b.right) + pad)), y1 = Math.min(innerHeight, Math.ceil(b.bottom + pad));
    return { clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, word: [w.left - x0, w.top - y0, w.right - x0, w.bottom - y0], line: [b.left - x0, b.top - y0, b.right - x0, b.bottom - y0] };
  }, pad);
  const shot = () => page.screenshot({ clip: geo.clip, scale: 'css', animations: 'allow' });
  const sid = 'scan-glyphs';
  await page.evaluate(id => { const s = document.createElement('style'); s.id = id;
    s.textContent = '.hero-stage{background:#fff!important}.hero .sky-css,.hero .sky-gl,.hero .sky-day{visibility:hidden!important}.hero h1,.hero .byline{color:#000!important;text-shadow:none!important;transition:none!important}';
    document.head.append(s); }, sid);
  const glyphPng = await shot();
  await page.evaluate(id => document.getElementById(id).remove(), sid);
  // distance (css px) from each pixel to the nearest glyph pixel, word and small line apart
  await page.evaluate(async ({ b64, geo, wordReach, lineReach }) => {
    const bin = atob(b64), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([u8], { type: 'image/png' }));
    const W = bmp.width, H = bmp.height, oc = new OffscreenCanvas(W, H), cx = oc.getContext('2d'); cx.drawImage(bmp, 0, 0);
    const d = cx.getImageData(0, 0, W, H).data;
    const dist = inBox => { const D = new Float32Array(W * H).fill(1e9);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (d[i * 4] < 128 && inBox(x, y)) D[i] = 0; }
      const s2 = Math.SQRT2;   // two-pass chamfer distance
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; let v = D[i];
        if (x > 0) v = Math.min(v, D[i - 1] + 1); if (y > 0) { v = Math.min(v, D[i - W] + 1); if (x > 0) v = Math.min(v, D[i - W - 1] + s2); if (x < W - 1) v = Math.min(v, D[i - W + 1] + s2); } D[i] = v; }
      for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) { const i = y * W + x; let v = D[i];
        if (x < W - 1) v = Math.min(v, D[i + 1] + 1); if (y < H - 1) { v = Math.min(v, D[i + W] + 1); if (x < W - 1) v = Math.min(v, D[i + W + 1] + s2); if (x > 0) v = Math.min(v, D[i + W - 1] + s2); } D[i] = v; }
      return D; };
    const inside = (bx, m) => (x, y) => x >= bx[0] - m && x <= bx[2] + m && y >= bx[1] - m && y <= bx[3] + m;
    const Dw = dist(inside(geo.word, 2)), Db = dist(inside(geo.line, 2));
    // zone: near the text, but outside the guard's designed reach around any glyph
    const zone = new Uint8Array(W * H); let glyphs = 0, zw = 0, zl = 0;
    for (let i = 0; i < W * H; i++) {
      if (Dw[i] === 0 || Db[i] === 0) glyphs++;
      if (Dw[i] > wordReach && Db[i] > lineReach) { const y = Math.floor(i / W); zone[i] = y < geo.line[1] - 6 ? 1 : 2; zone[i] === 1 ? zw++ : zl++; }
    }
    window.__scan = { W, H, zone, glyphs, zw, zl };
  }, { b64: glyphPng.toString('base64'), geo, wordReach, lineReach });

  const hideId = 'scan-hide';
  const steps = [], artifactFrames = [], thumbs = [];
  const n = Math.round((to - from) / step);
  for (let k = 0; k <= n; k++) {
    if (only && k % only) continue;
    const p = +(from + k * step).toFixed(6);
    await page.evaluate(({ p, ms }) => { window.__hero.setProgress(p); window.__tick(ms); }, { p, ms: settleMs });
    await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished)));
    const A = await shot();
    await page.evaluate(id => { window.__guardOff = true; const s = document.createElement('style'); s.id = id;
      s.textContent = '.hero .hero-copy{visibility:hidden!important}'; document.head.append(s); window.__tick(0); }, hideId);
    const R = await shot();
    await page.evaluate(id => { window.__guardOff = false; document.getElementById(id).remove(); window.__tick(0); }, hideId);
    const res = await page.evaluate(async ({ a, r, darkLevels }) => {
      const dec = async b64 => { const bin = atob(b64), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        const bmp = await createImageBitmap(new Blob([u8], { type: 'image/png' })); const oc = new OffscreenCanvas(bmp.width, bmp.height), cx = oc.getContext('2d');
        cx.drawImage(bmp, 0, 0); return { bmp, d: cx.getImageData(0, 0, bmp.width, bmp.height).data }; };
      const A = await dec(a), R = await dec(r), S = window.__scan, lum = (d, i) => .2126 * d[i] + .7152 * d[i + 1] + .0722 * d[i + 2];
      let dw = 0, dl = 0, maxD = 0, bx = [1e9, 1e9, -1, -1];
      for (let i = 0; i < S.W * S.H; i++) {
        if (!S.zone[i]) continue;
        const dd = lum(R.d, i * 4) - lum(A.d, i * 4);
        if (dd > darkLevels) { S.zone[i] === 1 ? dw++ : dl++; maxD = Math.max(maxD, dd);
          const x = i % S.W, y = (i / S.W) | 0; bx = [Math.min(bx[0], x), Math.min(bx[1], y), Math.max(bx[2], x), Math.max(bx[3], y)]; }
      }
      const tw = 240, th = Math.round(S.H * tw / S.W), oc = new OffscreenCanvas(tw, th); oc.getContext('2d').drawImage(A.bmp, 0, 0, tw, th);
      const bl = await oc.convertToBlob({ type: 'image/png' }), buf = new Uint8Array(await bl.arrayBuffer());
      let s = ''; for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
      return { dw, dl, maxD: Math.round(maxD * 10) / 10, box: bx[2] >= 0 ? bx : null, thumb: btoa(s) };
    }, { a: A.toString('base64'), r: R.toString('base64'), darkLevels });
    const flagged = res.dw >= minArea || res.dl >= minArea;
    const rec = { p, darkWord: res.dw, darkLine: res.dl, maxDarkLevels: res.maxD, box: res.box, flagged };
    steps.push(rec); thumbs.push({ p, b64: res.thumb, flagged });
    if (flagged) artifactFrames.push(rec);
  }
  if (contactSheet) {
    const jpg = await page.evaluate(async list => {
      const bm = [];
      for (const t of list) { const bin = atob(t.b64), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        bm.push(await createImageBitmap(new Blob([u8], { type: 'image/png' }))); }
      const cols = 10, tw = bm[0].width, th = bm[0].height, lab = 16, rows = Math.ceil(bm.length / cols);
      const oc = new OffscreenCanvas(cols * tw, rows * (th + lab)), cx = oc.getContext('2d');
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, oc.width, oc.height); cx.font = '11px monospace'; cx.textBaseline = 'top';
      bm.forEach((b, i) => { const x = (i % cols) * tw, y = Math.floor(i / cols) * (th + lab);
        cx.drawImage(b, x, y + lab); cx.fillStyle = list[i].flagged ? '#d00' : '#333'; cx.fillText('p ' + list[i].p.toFixed(3) + (list[i].flagged ? '  FLAG' : ''), x + 4, y + 2);
        if (list[i].flagged) { cx.strokeStyle = '#d00'; cx.lineWidth = 3; cx.strokeRect(x + 1.5, y + lab + 1.5, tw - 3, th - 3); } });
      const bl = await oc.convertToBlob({ type: 'image/jpeg', quality: .82 }), buf = new Uint8Array(await bl.arrayBuffer());
      let s = ''; for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]); return btoa(s);
    }, thumbs);
    await writeFile(contactSheet, Buffer.from(jpg, 'base64'));
  }
  const zone = await page.evaluate(() => { const s = window.__scan; window.__hero.setProgress(null); delete window.__scan;
    return { wordPx: s.zw, linePx: s.zl, glyphPx: s.glyphs }; });
  return { steps: steps.length, artifactFrames, detail: steps, zone, clip: geo.clip };
}

// ---------- gpuFrameTime ----------
// GPU milliseconds per hero frame from EXT_disjoint_timer_query_webgl2 (every pass of one frame, nothing else).
// mode 'busy' (default): frames are drawn back to back on the manual clock, each fenced by a 1px read, so the GPU runs
//   at full clock and each query covers exactly one frame. This is the frame's cost.
// mode 'paced': the live loop at its own 60 fps. Apple GPUs clock down between light frames, so this reads 2-4x the cost.
export async function gpuFrameTime(page, opts = {}) {
  const { frames = 150, progress = 0, timeout = 20000, mode = 'busy' } = opts;
  let st = await heroReady(page);
  if (mode === 'busy' && !st.manual) {
    await page.addInitScript(() => { window.__HERO_MANUAL_CLOCK = true; });
    await page.reload({ waitUntil: 'load' });
    st = await heroReady(page);
  }
  if (st.mode !== 'gl') return { error: 'hero is not running WebGL (mode ' + st.mode + ')' };
  return page.evaluate(async ({ frames, progress, timeout, mode }) => {
    const gl = document.querySelector('canvas.sky-gl').getContext('webgl2');
    const ext = gl && gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!ext) return { error: 'EXT_disjoint_timer_query_webgl2 unavailable' };
    const dbg = gl.getExtension('WEBGL_debug_renderer_info'), renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const h = window.__hero, frame = () => new Promise(r => requestAnimationFrame(r));
    const ms = []; let disjoint = 0;
    const read = q => { if (gl.getParameter(ext.GPU_DISJOINT_EXT)) disjoint++; else ms.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6); gl.deleteQuery(q); };
    if (progress !== null) h.setProgress(progress);
    if (mode === 'busy') {
      window.__tick(3200);                                   // past the opening fade
      const px = new Uint8Array(4), qs = [], warm = 40;
      for (let i = 0; i < frames + warm; i++) {
        const q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
        window.__tick(1000 / 60);
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        qs.push(q);
      }
      const t0 = performance.now();
      while (!gl.getQueryParameter(qs.at(-1), gl.QUERY_RESULT_AVAILABLE) && performance.now() - t0 < timeout) await frame();
      qs.forEach((q, i) => i < warm ? gl.deleteQuery(q) : read(q));
    } else {
      /* wrap the hero's own calls: open at the first program switch of a frame, close after the draw to the screen */
      const orig = { useProgram: gl.useProgram, drawArrays: gl.drawArrays, bindFramebuffer: gl.bindFramebuffer };
      let active = null, fb = null; const pending = [];
      gl.bindFramebuffer = function (t, f) { fb = f; return orig.bindFramebuffer.call(gl, t, f); };
      gl.useProgram = function (p) { if (!active && pending.length < 8) { active = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, active); } return orig.useProgram.call(gl, p); };
      gl.drawArrays = function (...a) { const r = orig.drawArrays.apply(gl, a); if (active && fb === null) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(active); active = null; } return r; };
      const manual = h.state().manual, t0 = performance.now();
      while (ms.length < frames && performance.now() - t0 < timeout) {
        if (manual) window.__tick(1000 / 60);
        else window.dispatchEvent(new PointerEvent('pointermove', { clientX: innerWidth * (.5 + .3 * Math.sin(performance.now() / 700)), clientY: innerHeight * .4, pointerType: 'mouse' }));
        await frame();
        while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) read(pending.shift());
      }
      const proto = Object.getPrototypeOf(gl);
      for (const k of Object.keys(orig)) { if (orig[k] === proto[k]) delete gl[k]; else gl[k] = orig[k]; }
    }
    if (progress !== null) h.setProgress(null);
    const s = [...ms].sort((a, b) => a - b), q = f => s[Math.min(s.length - 1, Math.floor(f * s.length))];
    const r3 = x => Math.round(x * 1000) / 1000;
    return { mode, mean: r3(ms.reduce((a, b) => a + b, 0) / Math.max(1, ms.length)), median: r3(q(.5)), p95: r3(q(.95)), frames: ms.length, disjoint,
      renderer, viewport: [innerWidth, innerHeight], dpr: devicePixelRatio, state: h.state() };
  }, { frames, progress, timeout, mode });
}

// ---------- bfcacheRestore ----------
// Needs a browser launched with bfcacheLaunchOptions. Loads `url`, scrolls a little, leaves for another same-origin
// page, comes back, and checks the page came out of the cache, threw nothing, and the canvas draws again.
export async function bfcacheRestore(page, url, opts = {}) {
  const { awayUrl = new URL('/assets/site.css', url).href, scroll = 300 } = opts;
  const { errors, off } = collectErrors(page);
  await page.addInitScript(() => {
    addEventListener('pageshow', e => { (window.__pageshows ||= []).push(e.persisted); });
    for (const t of ['webglcontextlost', 'webglcontextrestored']) document.addEventListener(t, () => (window.__glEvents ||= []).push(t.slice(12)), true);
  });
  await page.goto(url, { waitUntil: 'load' });
  // pages without the hero (e.g. /who/) still get the cache round trip, just no canvas checks
  const hasHero = await page.evaluate(() => !!document.querySelector('canvas.sky-gl'));
  if (hasHero) await heroReady(page);
  await page.evaluate(y => scrollTo(0, y), scroll);
  await sleep(800);
  const before = hasHero ? await page.evaluate(() => window.__hero.frameCount()) : 0;
  await page.goto(awayUrl, { waitUntil: 'load' });
  await sleep(500);
  await page.goBack({ waitUntil: 'commit' });
  let persisted = false;
  try { await page.waitForFunction(() => (window.__pageshows || []).includes(true), null, { timeout: 5000 }); persisted = true; } catch {}
  const why = persisted ? null : await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return n && n.notRestoredReasons ? JSON.stringify(n.notRestoredReasons) : null; }).catch(() => null);
  let canvasPaintsAfter = 0, nonBlank = false, mode = null;
  if (!hasHero) {
    await sleep(800); off();
    const ev = await page.evaluate(() => ({ pageshows: window.__pageshows })).catch(() => ({}));
    return { persisted, errors, hero: false, canvasPaintsAfter: null, nonBlank: null, mode: null, pageshows: ev.pageshows, contextEvents: [], notRestoredReasons: why };
  }
  try {
    await page.waitForFunction(b => window.__hero && window.__hero.state().mode === 'gl' && window.__hero.frameCount() > b, before, { timeout: 8000 });
    await sleep(1500);
    const after = await page.evaluate(() => ({ n: window.__hero.frameCount(), s: window.__hero.state() }));
    canvasPaintsAfter = after.n - before; mode = after.s.mode;
    // the canvas is really drawing if hiding it changes the pixels, and it isn't flat
    const clip = await page.evaluate(() => ({ x: 0, y: 0, width: innerWidth, height: Math.round(innerHeight * .3) }));
    const a = await page.screenshot({ clip, scale: 'css' });
    await page.evaluate(() => { document.querySelector('canvas.sky-gl').style.visibility = 'hidden'; });
    const b = await page.screenshot({ clip, scale: 'css' });
    await page.evaluate(() => { document.querySelector('canvas.sky-gl').style.visibility = ''; });
    const [A, B] = await decode(page, [a, b]);
    let diff = 0, m = 0, v = 0;
    for (let i = 0; i < A.Y.length; i++) { diff += Math.abs(A.Y[i] - B.Y[i]); m += A.Y[i]; }
    m /= A.Y.length; for (let i = 0; i < A.Y.length; i++) v += (A.Y[i] - m) ** 2;
    nonBlank = diff / A.Y.length > 0.5 && Math.sqrt(v / A.Y.length) > 0.5;
  } catch (e) { errors.push('check: ' + e.message.split('\n')[0]); }
  off();
  const ev = await page.evaluate(() => ({ pageshows: window.__pageshows, gl: window.__glEvents || [] })).catch(() => ({}));
  return { persisted, errors, hero: true, canvasPaintsAfter, nonBlank, mode, pageshows: ev.pageshows, contextEvents: ev.gl, notRestoredReasons: why };
}

// ---------- noWebGL ----------
export async function noWebGL(page, url, opts = {}) {
  const { screenshot } = opts;
  const { errors, off } = collectErrors(page);
  await page.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...a) { return /webgl/i.test(type) ? null : get.call(this, type, ...a); };
  });
  await page.goto(url, { waitUntil: 'load' });
  let fallback = false;
  try { await page.waitForFunction(() => document.documentElement.classList.contains('nogl'), null, { timeout: 5000 }); fallback = true; } catch {}
  await sleep(300);
  const r = await page.evaluate(() => {
    const h1 = document.getElementById('welcome'), cs = getComputedStyle(h1), rc = h1.getBoundingClientRect();
    const sky = getComputedStyle(document.querySelector('.hero .sky-css')), gl = getComputedStyle(document.querySelector('canvas.sky-gl'));
    return { skyCss: sky.display, canvasOpacity: gl.opacity, h1: { text: h1.textContent, visibility: cs.visibility, opacity: cs.opacity, color: cs.color, top: rc.top, height: rc.height },
      mode: window.__hero && window.__hero.state().mode };
  });
  if (screenshot) await page.screenshot({ path: screenshot });
  off();
  const h1Visible = r.h1.visibility === 'visible' && +r.h1.opacity === 1 && r.h1.height > 0 && r.h1.top >= 0 && r.h1.top < 2000;
  return { fallback: fallback && r.skyCss === 'block' && +r.canvasOpacity === 0, h1Visible, errors, ...r };
}

// ---------- fontMetricFallback ----------
// Loads the page twice: once as is, once with canvas text metrics that lack fontBoundingBoxAscent (as in engines
// without font metrics). Every float uniform the hero sends is watched; a value that isn't a finite number is recorded
// with its uniform's name. Returns the horizon (uBase) each load drew with, so the fallback can be compared to the real
// metric, plus mode, frames drawn and errors.
export async function fontMetricFallback(page, url, { stub = true, settleMs = 1500 } = {}) {
  const { errors, off } = collectErrors(page);
  await page.addInitScript(stub => {
    if (stub) {
      const mt = CanvasRenderingContext2D.prototype.measureText;
      CanvasRenderingContext2D.prototype.measureText = function (t) {
        const m = mt.call(this, t);
        return { width: m.width, actualBoundingBoxLeft: m.actualBoundingBoxLeft, actualBoundingBoxRight: m.actualBoundingBoxRight,
          actualBoundingBoxAscent: m.actualBoundingBoxAscent, actualBoundingBoxDescent: m.actualBoundingBoxDescent };
      };
    }
    const P = WebGL2RenderingContext.prototype, names = new WeakMap(), gul = P.getUniformLocation;
    const bad = window.__badUniforms = [], last = window.__lastUniforms = {};
    let calls = 0; window.__uniformCalls = () => calls;
    P.getUniformLocation = function (p, n) { const l = gul.call(this, p, n); if (l) names.set(l, n); return l; };
    for (const k of ['uniform1f', 'uniform2f', 'uniform3f', 'uniform4f', 'uniform1fv', 'uniform2fv', 'uniform3fv', 'uniform4fv']) {
      const f = P[k];
      P[k] = function (l, ...a) {
        calls++;
        const vals = k.endsWith('v') ? Array.from(a[0] || []) : a;
        const n = names.get(l) || '?';
        if (vals.some(v => !Number.isFinite(v))) { if (bad.length < 20) bad.push(`${n}=${vals.join(',')}`); }
        else last[n] = vals;
        return f.call(this, l, ...a);
      };
    }
  }, stub);
  await page.goto(url, { waitUntil: 'load' });
  let st = null;
  try { st = await heroReady(page); } catch (e) { errors.push('check: hero never drew: ' + e.message.split('\n')[0]); }
  await sleep(settleMs);
  const r = await page.evaluate(() => ({
    bad: window.__badUniforms, calls: window.__uniformCalls(), uBase: (window.__lastUniforms.uBase || [])[0], uHz: (window.__lastUniforms.uHz || [])[0],
    canvasH: document.querySelector('canvas.sky-gl').getBoundingClientRect().height, frames: window.__hero.frameCount(), mode: window.__hero.state().mode,
  }));
  off();
  return { ...r, errors, ready: !!st };
}

// ---------- frameCounts ----------
// Frames the hero draws per second in each state. Expect ~30 idle, ~60 while the pointer moves or the page scrolls,
// and 0 when hidden, handed off, off-screen or reduced. Chrome under Playwright never reports a background tab as
// hidden (headless or headed), so when a real switch leaves the page visible, `hidden` is measured by reporting the
// page as hidden to the page itself (document.hidden + visibilitychange), and hiddenMethod says so.
export async function frameCounts(page, url, opts = {}) {
  const { window: win = 2000 } = opts;
  const count = async () => { const a = await page.evaluate(() => window.__hero.frameCount()); await sleep(win);
    return Math.round((await page.evaluate(() => window.__hero.frameCount()) - a) * 1000 / win * 10) / 10; };
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(url, { waitUntil: 'load' });
  await heroReady(page);
  await sleep(3800);
  const out = {};
  out.idle = await count();
  let go = true;
  const mover = (async () => { let t = 0; while (go) { await page.mouse.move(700 + 300 * Math.sin(t), 400 + 100 * Math.cos(t)); t += .2; await sleep(40); } })();
  await sleep(300); out.pointerMoving = await count(); go = false; await mover;
  await sleep(2000);
  go = true;
  const scroller = (async () => { while (go) { await page.evaluate(() => scrollBy(0, 2)); await sleep(30); } })();
  await sleep(300); out.scrolling = await count(); go = false; await scroller;
  await page.evaluate(() => scrollTo(0, 0)); await sleep(2500);
  const other = await page.context().newPage();
  await other.goto('about:blank'); await other.bringToFront(); await sleep(500);
  const real = await page.evaluate(() => document.visibilityState) === 'hidden';
  out.hiddenMethod = real ? 'real' : 'simulated';
  if (!real) await page.evaluate(() => {
    for (const [k, v] of [['hidden', true], ['visibilityState', 'hidden']]) Object.defineProperty(document, k, { get: () => v, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  out.hidden = await count();
  if (!real) await page.evaluate(() => { delete document.hidden; delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); });
  await page.bringToFront(); await other.close(); await sleep(600);
  out.visibleAgain = await count();
  const geo = await page.evaluate(() => { const h = document.querySelector('.hero'), s = h.querySelector('.hero-stage');
    return { top: h.offsetTop, H: h.offsetHeight, S: s.offsetHeight }; });
  const span = geo.H - geo.S, tail = geo.S * .5;
  await page.evaluate(y => scrollTo(0, y), geo.top + span + tail + 20); await sleep(2500);
  out.handedOff = await count();
  out.handedOffStageVisible = await page.evaluate(() => { const r = document.querySelector('.hero-stage').getBoundingClientRect(); return r.bottom > 0; });
  await page.evaluate(y => scrollTo(0, y), geo.top + geo.H + 400); await sleep(800);
  out.offscreen = await count();
  await page.evaluate(() => scrollTo(0, 0)); await sleep(1500);
  out.backAtTop = await count();
  await page.emulateMedia({ reducedMotion: 'reduce' }); await sleep(500);
  out.reduced = await count();
  go = true;
  const rs = (async () => { while (go) { await page.evaluate(() => scrollBy(0, 3)); await sleep(30); } })();
  out.reducedScrolling = await count(); go = false; await rs;
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  return out;
}
