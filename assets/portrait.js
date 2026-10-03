/* Proof, Who am I: the photo, drawn in text. Each cell of a grid takes one Fragment Mono glyph from a short ramp of
   symbols, picked by how dark the photo is there, so the picture reads as tone. The pointer stirs the glyphs near
   it (they scramble, step away and warm to the hero's sunrise, then settle back); a tap or click sends a ring out.
   On arrival the picture resolves from scrambled glyphs, top to bottom, once. The loop only runs while something
   moves. Reduced motion: the finished picture, still. Without script, or if the photo can't be drawn, the figure
   shows the photo itself. */
(() => {
  const fig = document.querySelector('.pf');
  if (!fig) return;
  const cv = fig.querySelector('canvas');
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const RM = matchMedia('(prefers-reduced-motion: reduce)');

  const RAMP = ' .:-=+*#%@';           // index 0 = blank; then light to heavy
  const STIR = '01<>/\\{}[]+=*#%&$?';   // what a stirred cell flickers through
  const COLS = 84;                       // glyphs across
  const ADV = 0.6;                       // Fragment Mono advance, in em
  const RADIUS = 64;                     // px the pointer reaches

  let cols = 0, rows = 0, cw = 0, ch = 0, W = 0, H = 0, dpr = 1;
  let glyph = null, tone = null, energy = null, settleAt = null;
  let px = -1e4, py = -1e4, inside = false, ripples = [], raf = 0, ready = false;
  let ink = '#222', hot = '#d9772b';

  const img = new Image();
  img.decoding = 'async';
  img.src = fig.dataset.src;

  /* tone grid: average the photo over each cell (drawn at 4x, then box-averaged), stretch the figure's own range,
     sharpen against the neighbours, then pick a glyph. Transparent (cut-out) cells stay blank. */
  function build() {
    W = fig.clientWidth;
    if (!W || !img.naturalWidth) return false;
    dpr = Math.min(2, devicePixelRatio || 1);
    cols = COLS;
    cw = W / cols;
    ch = cw / ADV;
    rows = Math.round((W * img.naturalHeight / img.naturalWidth) / ch);
    H = rows * ch;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.height = H + 'px';

    const S = 4, oc = document.createElement('canvas');
    oc.width = cols * S; oc.height = rows * S;
    const o = oc.getContext('2d', { willReadFrequently: true });
    o.imageSmoothingQuality = 'high';
    o.drawImage(img, 0, 0, oc.width, oc.height);
    const px4 = o.getImageData(0, 0, oc.width, oc.height).data;

    const n = cols * rows, L = new Float32Array(n), A = new Float32Array(n);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      let l = 0, a = 0;
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const i = ((r * S + y) * oc.width + (c * S + x)) * 4, al = px4[i + 3] / 255;
        l += (0.2126 * px4[i] + 0.7152 * px4[i + 1] + 0.0722 * px4[i + 2]) / 255 * al;
        a += al;
      }
      const k = r * cols + c;
      A[k] = a / (S * S);
      L[k] = a > 0 ? l / a : 1;
    }
    const inF = k => A[k] > 0.45;
    const vals = [];
    for (let k = 0; k < n; k++) if (inF(k)) vals.push(L[k]);
    vals.sort((p, q) => p - q);
    const lo = vals[Math.floor(vals.length * 0.02)] ?? 0, hi = vals[Math.floor(vals.length * 0.98)] ?? 1;
    const T = new Float32Array(n).fill(1);
    for (let k = 0; k < n; k++) if (inF(k)) T[k] = Math.min(1, Math.max(0, (L[k] - lo) / Math.max(0.05, hi - lo)));
    const N = new Float32Array(n).fill(1);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      if (!inF(k)) continue;
      let sum = 0, cnt = 0;
      for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) {
        const rr = r + y, cc = c + x;
        if (rr >= 0 && rr < rows && cc >= 0 && cc < cols && inF(rr * cols + cc)) { sum += T[rr * cols + cc]; cnt++; }
      }
      N[k] = Math.min(1, Math.max(0, T[k] + (T[k] - sum / cnt) * 0.7));
    }
    glyph = new Uint8Array(n); tone = new Float32Array(n);
    const top = RAMP.length - 1;
    for (let k = 0; k < n; k++) {
      if (!inF(k)) continue;
      /* the shoulders fade into the page over the bottom third */
      const fy = Math.floor(k / cols) / rows, fade = fy < 0.66 ? 1 : Math.max(0.12, 1 - (fy - 0.66) / 0.34 * 0.88);
      /* on the light page the skin is the brightest part, so lift the mid-tones and cap the darks */
      const v = Math.min(0.9, 0.06 + 0.88 * Math.pow(1 - N[k], 0.8));
      if (v < 0.05) { glyph[k] = 1; tone[k] = 0.18 * fade; continue; }
      glyph[k] = 1 + Math.round(v * (top - 1));
      tone[k] = (0.22 + 0.78 * v) * fade;
    }
    energy = new Float32Array(n);
    settleAt = new Float32Array(n);
    return true;
  }

  function draw(now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.font = `${ch * 0.98}px "Fragment Mono", "Fragment Fallback", ui-monospace, monospace`;
    ctx.textBaseline = 'top';
    const tick = Math.floor(now / 70);
    let busy = false;
    for (let r = 0, k = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++, k++) {
        const g = glyph[k];
        if (!g) continue;
        const intro = now < settleAt[k];
        const e = intro ? Math.max(energy[k], 0.9) : energy[k];
        let x = c * cw, y = r * ch, s = RAMP[g];
        if (e > 0.12) {
          busy = true;
          let h = Math.imul(k, 374761393) + Math.imul(tick, 668265263);
          h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
          s = STIR[(h >>> 0) % STIR.length];
          if (!intro && inside) {
            const dx = x + cw / 2 - px, dy = y + ch / 2 - py, d = Math.hypot(dx, dy) || 1;
            x += (dx / d) * e * 5; y += (dy / d) * e * 5;
          }
          ctx.fillStyle = hot;
          ctx.globalAlpha = intro ? 0.35 : 0.5 + 0.5 * e;
        } else {
          ctx.fillStyle = ink;
          ctx.globalAlpha = tone[k];
        }
        ctx.fillText(s, x, y);
      }
    }
    ctx.globalAlpha = 1;
    return busy;
  }

  /* lift every cell within `band` of distance R from (x, y) (R = 0: a disc) to at least `amount * falloff` */
  function stir(x, y, R, band, amount) {
    const reach = R + band;
    const c0 = Math.max(0, Math.floor((x - reach) / cw)), c1 = Math.min(cols - 1, Math.ceil((x + reach) / cw));
    const r0 = Math.max(0, Math.floor((y - reach) / ch)), r1 = Math.min(rows - 1, Math.ceil((y + reach) / ch));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const d = Math.abs(Math.hypot(c * cw + cw / 2 - x, r * ch + ch / 2 - y) - R);
      if (d < band) { const k = r * cols + c; energy[k] = Math.max(energy[k], (1 - d / band) * amount); }
    }
  }

  function step(now) {
    raf = 0;
    if (inside) stir(px, py, 0, RADIUS, 1);
    ripples = ripples.filter(rp => now - rp.t < 900);
    for (const rp of ripples) {
      const age = (now - rp.t) / 900;
      stir(rp.x, rp.y, 10 + age * Math.max(W, H) * 0.9, 18, 1 - age);
    }
    let live = ripples.length > 0 || inside;
    for (let k = 0; k < energy.length; k++) {
      if (energy[k] > 0.01) { energy[k] *= 0.93; live = true; } else energy[k] = 0;
    }
    const busy = draw(now);
    if (live || busy) raf = requestAnimationFrame(step);
  }

  const kick = () => { if (!raf && ready && !RM.matches) raf = requestAnimationFrame(step); };

  function start() {
    const cs = getComputedStyle(fig);
    ink = cs.getPropertyValue('--pf-ink').trim() || ink;
    hot = cs.getPropertyValue('--pf-hot').trim() || hot;
    /* if the photo can't be drawn, show it as it is */
    if (!build()) { document.documentElement.classList.remove('pf-js'); return; }
    ready = true;
    fig.classList.add('on');
    fig.querySelector('img')?.remove();
    if (RM.matches) { draw(Infinity); return; }
    /* arrival: each cell settles at a time set by its row, with a little scatter */
    const t0 = performance.now();
    for (let r = 0, k = 0; r < rows; r++) for (let c = 0; c < cols; c++, k++) {
      settleAt[k] = t0 + 120 + r * (900 / rows) + ((Math.imul(k, 2654435761) >>> 0) % 260);
    }
    kick();
  }

  const local = e => { const b = cv.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
  cv.addEventListener('pointermove', e => { [px, py] = local(e); inside = true; kick(); });
  cv.addEventListener('pointerleave', () => { inside = false; px = py = -1e4; kick(); });
  cv.addEventListener('pointerdown', e => { const [x, y] = local(e); ripples.push({ x, y, t: performance.now() }); kick(); });

  /* a new width rebuilds the grid and shows it finished */
  let rw = 0;
  new ResizeObserver(() => {
    if (!ready || fig.clientWidth === rw) return;
    rw = fig.clientWidth;
    build();
    draw(Infinity);
  }).observe(fig);
  RM.addEventListener('change', () => { if (ready) draw(Infinity); });

  Promise.all([img.decode().catch(() => {}), document.fonts.load('16px "Fragment Mono"').catch(() => {})]).then(() => {
    rw = fig.clientWidth;
    start();
  });
})();
