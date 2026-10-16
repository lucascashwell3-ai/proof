#!/usr/bin/env node
// Captures the live Modelproof home for the Modelproof window on the home page, so the picture can be renewed in one
// step whenever the models on its board change.
//
//   node scripts/capture-modelproof.mjs [--url https://lucascashwell3-ai.github.io/modelproof/]
//
// Desktop: 1120 css px wide, the narrowest width where the board lays out as a graph, rendered at 3/4 and 3/2 scale so
// the window shows it 840 px wide and sharp at 1x and 2x. Phone: a 390 css px phone's first screen down to the end of
// the three taps, drawn 716 and 1074 px wide for the phone window (358 css px) at 2x and 3x; its floating Install bar
// is left out, since in a still it reads as covering the board.
// Writes the four webp files over assets/img/modelproof-board*.webp, then prints the board as text for the alt text.

import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const arg = process.argv.indexOf('--url');
const URL_ = arg > 0 ? process.argv[arg + 1] : 'https://lucascashwell3-ai.github.io/modelproof/';
const OUT = fileURLToPath(new URL('../assets/img/', import.meta.url));
const SHOTS = [
  { file: 'modelproof-board-1x.webp', w: 1120, h: 912, dpr: .75 },
  { file: 'modelproof-board.webp', w: 1120, h: 912, dpr: 1.5 },
  { file: 'modelproof-board-phone.webp', w: 390, h: 484, dpr: 716 / 390, phone: true },
  { file: 'modelproof-board-phone-3x.webp', w: 390, h: 484, dpr: 1074 / 390, phone: true },
];

const b = await chromium.launch();
try {
  const enc = await (await b.newContext()).newPage();
  let board = '';
  for (const s of SHOTS) {
    const ctx = await b.newContext({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: s.dpr, reducedMotion: 'reduce' });
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', e => errors.push(e.message));
    await p.goto(URL_, { waitUntil: 'networkidle' });
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(600);
    if (errors.length) throw new Error(`${URL_} threw: ${errors.join(' | ')}`);
    if (s.phone) await p.evaluate(() => {
      for (const el of document.querySelectorAll('body *')) {
        const pos = getComputedStyle(el).position;
        if ((pos === 'fixed' || pos === 'sticky') && /install/i.test(el.textContent)) el.style.visibility = 'hidden';
      }
    });
    const png = await p.screenshot({ type: 'png' });
    if (!board) board = await p.evaluate(() => document.querySelector('main')?.innerText.replace(/\n{2,}/g, '\n').slice(0, 900) || '');
    await ctx.close();
    /* webp in the browser itself: no image tool to install */
    const b64 = await enc.evaluate(async src => {
      const img = new Image(); img.src = 'data:image/png;base64,' + src; await img.decode();
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/webp', .9).split(',')[1];
    }, png.toString('base64'));
    const buf = Buffer.from(b64, 'base64');
    await writeFile(OUT + s.file, buf);
    console.log(`${s.file}  ${Math.round(s.w * s.dpr)}x${Math.round(s.h * s.dpr)}  ${(buf.length / 1024).toFixed(1)} KB`);
  }
  console.log('\nOn the page now (for the alt text):\n' + board);
} finally {
  await b.close();
}
