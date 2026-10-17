#!/usr/bin/env node
// Keeps the Modelproof window's picture true to the live Modelproof home.
//
//   node scripts/capture-modelproof.mjs              read the live board; renew the pictures only if it changed
//   node scripts/capture-modelproof.mjs --force      renew the pictures even if the board is the same (a restyle)
//   node scripts/capture-modelproof.mjs --dry-run    read, capture and check into a temp folder; write nothing here
//   node scripts/capture-modelproof.mjs --self-test  check the reader and the picture checks on frozen inputs, offline
//   [--url https://lucascashwell3-ai.github.io/modelproof/]
//
// "The board" is what the picture shows that can go out of date: the tap picked in each of the three groups, and the
// model on each role. It is kept in data/modelproof-capture.json; the same board means nothing is written.
// Pictures: desktop 1120 css px wide, the narrowest width where the board lays out as a graph, rendered at 3/4 and 3/2
// scale so the window shows it 840 px wide and sharp at 1x and 2x. Phone: a 390 css px phone's first screen down to
// the end of the three taps, drawn 716 and 1074 px wide for the phone window (358 css px) at 2x and 3x; its floating
// Install bar is left out, since in a still it reads as covering the board.
// Each capture load must show the same board as the first read, with no failed request, and every picture is checked
// before anything is written: exact size, a sane file size, not blank, and dark (the window's backing is the page's own
// dark). Any failed check exits 1 and leaves the repo as it was. A dry run writes its pictures first, checks after, so a
// failed one can still be looked at.
// Exit 0 with a one-line summary; in GitHub Actions, also writes changed=true|false to $GITHUB_OUTPUT.

import { chromium } from 'playwright';
import { readFile, writeFile, mkdtemp, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const IMG = join(ROOT, 'assets/img');
const STATE = join(ROOT, 'data/modelproof-capture.json');
const FIXTURE = join(ROOT, 'scripts/checks/fixtures/modelproof-home.html');
const argv = process.argv.slice(2), flag = f => argv.includes(f);
const at = argv.indexOf('--url');
const SOURCE = at >= 0 ? argv[at + 1] : 'https://lucascashwell3-ai.github.io/modelproof/';

const SHOTS = [
  { file: 'modelproof-board-1x.webp', w: 1120, h: 912, dpr: .75 },
  { file: 'modelproof-board.webp', w: 1120, h: 912, dpr: 1.5 },
  { file: 'modelproof-board-phone.webp', w: 390, h: 484, dpr: 716 / 390, phone: true },
  { file: 'modelproof-board-phone-3x.webp', w: 390, h: 484, dpr: 1074 / 390, phone: true },
];
const LIMITS = { minKB: 8, maxKB: 600, minSpread: .04, maxMean: .45 };

/* ---------- the board, read from the page ---------- */
// runs in the page: the pressed tap in each group, and each role with its model (from the role's own label)
const READ_BOARD = () => ({
  taps: [...document.querySelectorAll('.tap-opts')].map(g => (g.querySelector('[aria-pressed="true"]')?.textContent || '').trim()),
  roles: [...document.querySelectorAll('button.node[data-role]')].map(b => ({
    role: b.dataset.role,
    model: ((b.getAttribute('aria-label') || '').match(/Model: (.+?)\. /) || [])[1] || '',
  })),
});
function boardProblems(b) {
  const p = [];
  if (b.taps.length !== 3) p.push(`expected 3 tap groups, found ${b.taps.length}`);
  if (b.taps.some(t => !t)) p.push('a tap group has nothing picked');
  if (b.roles.length < 3) p.push(`expected at least 3 roles, found ${b.roles.length}`);
  if (!b.roles.some(r => r.role === 'lead')) p.push('no lead role');
  for (const r of b.roles) if (!r.model) p.push(`role ${r.role} shows no model`);
  return p;
}
const sameBoard = (a, b) => !!a && !!b && JSON.stringify({ t: a.taps, r: a.roles }) === JSON.stringify({ t: b.taps, r: b.roles });
const summary = b => `${b.taps.join(' / ')}: ` + Object.entries(b.roles.reduce((m, r) => ((m[r.model] ||= []).push(r.role), m), {}))
  .map(([model, roles]) => `${model} (${roles.join(', ')})`).join('; ');

/* ---------- picture checks, run in a browser page on the encoded webp ---------- */
// returns { w, h, mean, spread } over the luminance of every 4th pixel
const MEASURE = async b64 => {
  const img = new Image(); img.src = 'data:image/webp;base64,' + b64; await img.decode();
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  let n = 0, s = 0, s2 = 0;
  for (let i = 0; i < d.length; i += 16) { const y = (.2126 * d[i] + .7152 * d[i + 1] + .0722 * d[i + 2]) / 255; s += y; s2 += y * y; n++; }
  const mean = s / n;
  return { w: c.width, h: c.height, mean, spread: Math.sqrt(Math.max(0, s2 / n - mean * mean)) };
};
function pictureProblems(shot, bytes, m) {
  const p = [], kb = bytes / 1024, w = Math.round(shot.w * shot.dpr), h = Math.round(shot.h * shot.dpr);
  if (m.w !== w || m.h !== h) p.push(`${shot.file}: ${m.w}x${m.h}, expected ${w}x${h}`);
  if (kb < LIMITS.minKB || kb > LIMITS.maxKB) p.push(`${shot.file}: ${kb.toFixed(1)} KB, outside ${LIMITS.minKB}-${LIMITS.maxKB} KB`);
  if (m.spread < LIMITS.minSpread) p.push(`${shot.file}: nearly blank (spread ${m.spread.toFixed(3)})`);
  if (m.mean > LIMITS.maxMean) p.push(`${shot.file}: not dark (mean ${m.mean.toFixed(2)}); the window's backing assumes a dark page`);
  return p;
}

/* ---------- capture ---------- */
async function encodeWebp(enc, png) {
  return Buffer.from(await enc.evaluate(async src => {
    const img = new Image(); img.src = 'data:image/png;base64,' + src; await img.decode();
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    return c.toDataURL('image/webp', .9).split(',')[1];
  }, png.toString('base64')), 'base64');
}

async function openHome(b, shot) {
  const ctx = await b.newContext({ viewport: { width: shot.w, height: shot.h }, deviceScaleFactor: shot.dpr, reducedMotion: 'reduce' });
  const p = await ctx.newPage(), errors = [];
  p.on('pageerror', e => errors.push(e.message));
  p.on('requestfailed', r => errors.push(`request failed: ${r.url()}`));
  p.on('response', r => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  const res = await p.goto(SOURCE, { waitUntil: 'networkidle', timeout: 60000 });
  if (!res || res.status() !== 200) throw new Error(`${SOURCE} answered ${res ? res.status() : 'nothing'}`);
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(600);
  if (errors.length) throw new Error(`${SOURCE} threw: ${errors.join(' | ')}`);
  return { ctx, p };
}

async function run() {
  const force = flag('--force'), dry = flag('--dry-run');
  const prev = JSON.parse(await readFile(STATE, 'utf8').catch(() => 'null'));
  const b = await chromium.launch();
  try {
    /* the board first, from the desktop layout: if it is the same, nothing else runs */
    const first = await openHome(b, SHOTS[0]);
    const board = await first.p.evaluate(READ_BOARD);
    await first.ctx.close();
    const bad = boardProblems(board);
    if (bad.length) throw new Error('the Modelproof home no longer reads as expected: ' + bad.join('; '));
    if (!force && !dry && sameBoard(prev, board)) { await done(false, `unchanged: ${summary(board)}`); return; }

    const out = dry ? await mkdtemp(join(tmpdir(), 'mp-capture-')) : IMG;
    const enc = await (await b.newContext()).newPage();
    const pics = [], problems = [];
    for (const s of SHOTS) {
      const { ctx, p } = await openHome(b, s);
      /* the page must show the board that was read: a half-loaded or mid-deploy page is never captured */
      const seen = await p.evaluate(READ_BOARD);
      if (!sameBoard(board, seen)) throw new Error(`${s.file}: the page showed a different board than the first read (${summary(seen)})`);
      /* phone: the floating Install bar is the Install button's nearest fixed or sticky holder, and only that */
      if (s.phone) await p.evaluate(() => {
        let e = [...document.querySelectorAll('button, a')].find(x => x.textContent.trim() === 'Install');
        while (e && e !== document.body && !['fixed', 'sticky'].includes(getComputedStyle(e).position)) e = e.parentElement;
        if (e && e !== document.body && !e.querySelector('.tap-opts, .nodes')) e.style.visibility = 'hidden';
      });
      const webp = await encodeWebp(enc, await p.screenshot({ type: 'png' }));
      await ctx.close();
      if (dry) await writeFile(join(out, s.file), webp);
      problems.push(...pictureProblems(s, webp.length, await enc.evaluate(MEASURE, webp.toString('base64'))));
      pics.push({ s, webp });
    }
    if (problems.length) throw new Error(`a picture failed its checks, ${dry ? 'pictures kept in ' + out : 'nothing written'}: ` + problems.join('; '));

    /* every check passed: only now is anything written */
    const images = {};
    for (const { s, webp } of pics) {
      if (!dry) await writeFile(join(out, s.file), webp);
      images[s.file] = createHash('sha256').update(webp).digest('hex');
    }
    const state = { source: SOURCE, captured_at: new Date().toISOString(), taps: board.taps, roles: board.roles, images };
    if (!dry) await writeFile(STATE, JSON.stringify(state, null, 2) + '\n');
    const how = dry ? `dry run, pictures in ${out}` : sameBoard(prev, board) ? 'renewed (forced)' : 'renewed';
    await done(!dry, `${how}: ${summary(board)}`);
  } finally {
    await b.close();
  }
}

async function done(changed, line) {
  console.log(line);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}

/* ---------- self-test: frozen inputs only, never the live page ---------- */
async function selfTest() {
  const fails = [], ok = (c, m) => { if (!c) fails.push(m); };
  const b = await chromium.launch();
  try {
    const p = await (await b.newContext()).newPage();
    await p.setContent(await readFile(FIXTURE, 'utf8'));
    const board = await p.evaluate(READ_BOARD);
    ok(JSON.stringify(board.taps) === JSON.stringify(['Claude Code', 'Max 5x', 'Several jobs']), 'reader: taps ' + JSON.stringify(board.taps));
    ok(board.roles.length === 6 && board.roles[0].role === 'lead' && board.roles[0].model === 'Claude Opus 5.5', 'reader: lead ' + JSON.stringify(board.roles[0]));
    ok(board.roles.find(r => r.role === 'bulk')?.model === 'Claude Haiku 5.5', 'reader: bulk model');
    ok(boardProblems(board).length === 0, 'board checks: the fixture should pass: ' + boardProblems(board).join('; '));
    /* planted failures: each one must be caught */
    ok(boardProblems({ taps: ['Claude Code', '', 'Several jobs'], roles: board.roles }).length > 0, 'board checks: missed an empty tap group');
    ok(boardProblems({ taps: board.taps, roles: board.roles.map(r => ({ ...r, model: r.role === 'scout' ? '' : r.model })) }).length > 0, 'board checks: missed a role with no model');
    ok(boardProblems({ taps: board.taps, roles: [] }).length > 0, 'board checks: missed an empty board');
    ok(sameBoard(board, JSON.parse(JSON.stringify(board))), 'change check: the same board read as changed');
    ok(!sameBoard(board, { ...board, roles: board.roles.map(r => r.role === 'lead' ? { ...r, model: 'Claude Opus 6' } : r) }), 'change check: missed a new lead model');
    ok(!sameBoard(board, { ...board, taps: ['Codex', 'Max 5x', 'Several jobs'] }), 'change check: missed a new default tap');
    ok(!sameBoard(board, null), 'change check: no saved board must count as changed');
    /* picture checks on made-up pictures: a busy dark one passes; blank, light, wrong-size and tiny ones fail */
    const make = async (w, h, kind) => Buffer.from(await p.evaluate(([w, h, kind]) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
      x.fillStyle = kind === 'light' ? '#f4f4f4' : '#0d0e10'; x.fillRect(0, 0, w, h);
      if (kind !== 'blank') for (let i = 0; i < 400; i++) { x.fillStyle = `hsl(${i * 37 % 360} 10% ${30 + i % 60}%)`; x.fillRect((i * 97) % w, (i * 53) % h, 30 + i % 50, 12); }
      return c.toDataURL('image/webp', .9).split(',')[1];
    }, [w, h, kind]), 'base64');
    const s = SHOTS[0], W = Math.round(s.w * s.dpr), H = Math.round(s.h * s.dpr);
    const check = async (buf, size) => pictureProblems(s, size, await p.evaluate(MEASURE, buf.toString('base64')));
    const good = await check(await make(W, H, 'busy'), 40 * 1024);
    ok(good.length === 0, 'picture checks: a good picture failed: ' + good.join('; '));
    ok((await check(await make(W, H, 'blank'), 40 * 1024)).some(m => /blank/.test(m)), 'picture checks: missed a blank picture');
    ok((await check(await make(W, H, 'light'), 40 * 1024)).some(m => /not dark/.test(m)), 'picture checks: missed a light page');
    ok((await check(await make(W - 10, H, 'busy'), 40 * 1024)).some(m => /expected/.test(m)), 'picture checks: missed a wrong size');
    ok((await check(await make(W, H, 'busy'), 2 * 1024)).some(m => /KB/.test(m)), 'picture checks: missed a too-small file');
  } finally {
    await b.close();
  }
  if (fails.length) { console.error('self-test FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
  console.log('self-test passed: reader, board checks, change check, picture checks (10 planted failures caught)');
}

(flag('--self-test') ? selfTest() : run()).catch(e => { console.error('modelproof capture failed: ' + e.message); process.exit(1); });
