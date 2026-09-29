#!/usr/bin/env node
// DATproof window: dev-time data refresh. The site itself has no build step; run this after
// updating data/datproof/*.csv and commit the rewritten HTML.
//
//   node scripts/build-datproof.mjs [page.html ...] [--fallback <file>]
//
// Rewrites everything between <!-- datproof:grid:start --> and <!-- datproof:grid:end --> in each
// page (default: index.html) with the finished, fully drawn window body: top bar, total, through-date,
// the weekly grid, legend. The grid is complete in the HTML, so it shows with no JS and under reduced
// motion; assets/datproof.js only replays it once as a fill. Idempotent: same CSVs, same bytes.
// If no page has the markers yet, the fragment goes to --fallback (default _dev/datproof-grid.html)
// and the script exits 0.
//
// DOM weight: one SVG per row, one <path> per (4-week chunk, level), and the empty track is a single
// dashed line per row, instead of one element per week: about 230 nodes for the grid, not 1,300+.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data', 'datproof');
const START = '<!-- datproof:grid:start -->';
const END = '<!-- datproof:grid:end -->';

// Intensity levels: BTC bought in one week, per row (the All row uses the same scale).
//   0  no buy that week
//   1  under 100 BTC
//   2  100 to under 1,000 BTC
//   3  1,000 to under 10,000 BTC
//   4  10,000 BTC or more
// Decade steps, so a 20 BTC week and a 50,000 BTC week both read on one scale.
export const THRESHOLDS = [100, 1000, 10000];
export const level = (v) => (v <= 0 ? 0 : 1 + THRESHOLDS.filter((t) => v >= t).length);

// Geometry in SVG user units, stretched to each row's CSS box: one week = PITCH, one cell = CELL wide.
// Both are written onto #dpRows (data-pitch, data-cell) so the hover readout reads them, never a copy.
const PITCH = 5;
const CELL = 4;
// The fill replays the grid in chunks of CHUNK weeks: one path per (chunk, level), and the
// overlapping fades still read as one continuous left-to-right sweep.
const CHUNK = 4;

const DAY = 864e5;
const WEEK = 7 * DAY;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------- CSV (RFC 4180: quoted fields, doubled quotes, commas and newlines inside quotes) ----------
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

// ---------- exact decimal BTC (integer satoshis, so the total never picks up float error) ----------
const SAT = 100000000n;
export function toSats(s) {
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(String(s).trim());
  if (!m) throw new Error(`not a BTC amount: "${s}"`);
  return BigInt(m[1]) * SAT + BigInt((m[2] || '').padEnd(8, '0'));
}
export function satsToString(n) {
  const frac = (n % SAT).toString().padStart(8, '0').replace(/0+$/, '');
  return frac ? `${n / SAT}.${frac}` : `${n / SAT}`;
}
const satsRound = (n) => (n + SAT / 2n) / SAT; // half up, to whole BTC
const commas = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// ---------- dates ----------
const utc = (iso) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error(`not a YYYY-MM-DD date: "${iso}"`);
  return Date.parse(`${iso}T00:00:00Z`);
};
const mondayOf = (t) => t - ((new Date(t).getUTCDay() + 6) % 7) * DAY; // ISO weeks start Monday
const usDate = (t) => { const d = new Date(t); return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; };
const monYear = (t) => { const d = new Date(t); return `${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const isoDate = (t) => new Date(t).toISOString().slice(0, 10);

// ---------- load ----------
export function loadData(dir = DATA) {
  const companies = JSON.parse(readFileSync(join(dir, 'companies.json'), 'utf8'))
    .filter((c) => existsSync(join(dir, c.file)));
  const buys = [];
  for (const c of companies) {
    for (const r of parseCSV(readFileSync(join(dir, c.file), 'utf8'))) {
      if (r.type !== 'btc_buy') continue;
      if (!r.btc.trim()) { console.warn(`skipped ${c.ticker} ${r.date}: btc_buy with no btc value`); continue; }
      if (!r.source_url) console.warn(`${c.ticker} ${r.date}: btc_buy with no source_url`);
      buys.push({ ticker: c.ticker, date: r.date, t: utc(r.date), sats: toSats(r.btc) });
    }
  }
  if (!buys.length) throw new Error(`no btc_buy rows in ${dir}`);
  return { companies, buys };
}

// ---------- model ----------
export function buildModel({ companies, buys }) {
  const first = Math.min(...buys.map((b) => b.t));
  const last = Math.max(...buys.map((b) => b.t));
  const start = mondayOf(first);
  const weeks = (mondayOf(last) - start) / WEEK + 1;
  const wk = (t) => (mondayOf(t) - start) / WEEK;

  const series = companies.map((c) => {
    const mine = buys.filter((b) => b.ticker === c.ticker);
    const w = Array.from({ length: weeks }, () => 0n);
    for (const b of mine) w[wk(b.t)] += b.sats;
    const lastT = Math.max(...mine.map((b) => b.t));
    const latest = mine.filter((b) => b.t === lastT).reduce((s, b) => s + b.sats, 0n);
    return {
      name: c.name, tick: c.ticker, top: !!c.top, w,
      sum: w.reduce((s, v) => s + v, 0n), buys: mine.length, latest,
    };
  });
  const all = Array.from({ length: weeks }, (_, i) => series.reduce((s, c) => s + c.w[i], 0n));
  const total = all.reduce((s, v) => s + v, 0n);

  // year labels sit on the first ISO week of each year
  const years = [];
  const y0 = new Date(start).getUTCFullYear() + 1;
  const y1 = new Date(last).getUTCFullYear();
  for (let y = y0; y <= y1; y++) years.push({ y, w: (mondayOf(Date.UTC(y, 0, 4)) - start) / WEEK });

  return {
    start, weeks, first, last, years, total, count: buys.length,
    rows: [{ name: 'All DATs', tick: '', w: all }, ...series], series,
  };
}

// ---------- markup ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (sats) => Number(satsToString(sats));
const vbWidth = (weeks) => weeks * PITCH - (PITCH - CELL);

function rowSVG(w) {
  const groups = new Map(); // chunk -> level -> [week]
  w.forEach((sats, i) => {
    const l = level(num(sats));
    if (!l) return;
    const c = Math.floor(i / CHUNK);
    if (!groups.has(c)) groups.set(c, new Map());
    const g = groups.get(c);
    if (!g.has(l)) g.set(l, []);
    g.get(l).push(i);
  });
  let paths = '';
  for (const [c, byLevel] of [...groups].sort((a, b) => a[0] - b[0])) {
    for (const [l, list] of [...byLevel].sort((a, b) => a[0] - b[0])) {
      let d = '';
      let prev = -1;
      for (const i of list) {
        d += prev < 0 ? `M${i * PITCH} 0` : `m${(i - prev) * PITCH} 0`;
        d += `h${CELL}v1h-${CELL}z`;
        prev = i;
      }
      paths += `<path class="l${l}" data-w="${c * CHUNK}" d="${d}"/>`;
    }
  }
  const vw = vbWidth(w.length);
  // the empty track: one dashed line, a dash per week, drawn under the lit cells
  return `<svg viewBox="0 0 ${vw} 1" preserveAspectRatio="none" aria-hidden="true" focusable="false">`
    + `<path class="c0" d="M0 .5H${vw}" stroke-dasharray="${CELL} ${PITCH - CELL}"/>${paths}</svg>`;
}

export function renderFragment(m) {
  const vw = vbWidth(m.weeks);
  const through = usDate(m.last);
  const totalExact = satsToString(m.total);
  const totalShown = commas(satsRound(m.total));
  const tops = m.series.filter((s) => s.top);

  const label = `Weekly bitcoin purchases, ${monYear(m.start)} to ${monYear(m.last)}. `
    + m.series.map((s) => `${s.name} (${s.tick}): ${commas(satsRound(s.sum))} BTC over ${s.buys} purchases.`).join(' ')
    + ` Total ${totalShown} BTC.`;

  const axis = m.years
    .map((y) => `<span style="left:${((y.w * PITCH) / vw * 100).toFixed(2)}%">${y.y}</span>`).join('');

  const rows = m.rows.map((r) => {
    const lab = r.tick ? `<em>${esc(r.name)}</em> · ${esc(r.tick)}` : `<em>${esc(r.name)}</em>`;
    return `<div class="dp-row"><span class="dp-label">${lab}</span>${rowSVG(r.w)}</div>`;
  }).join('\n');

  // per-week values for the hover readout: company rows only, [week, BTC] pairs; All is their sum
  const data = {
    s: isoDate(m.start),
    r: m.series.map((s) => s.w.flatMap((v, i) => (v > 0n ? [[i, num(v)]] : []))),
  };

  const top = [
    '<span class="dp-logo">DAT<b>proof</b></span>',
    `<span>latest filing <em>${isoDate(m.last)}</em></span>`,
    ...tops.map((s) => `<span class="wide">${esc(s.tick)} <em>${commas(satsRound(s.latest))} BTC</em></span>`),
  ].join('');

  return `
<div class="wbody dp">
<div class="dp-top" aria-hidden="true">${top}</div>
<div class="dp-hero">
<p class="dp-num" data-total="${totalExact}">${totalShown.replace(/,/g, '<span class="cm">,</span>')}</p>
<p class="dp-sub"><b>bitcoin</b> bought by tracked companies, <span class="thru">through <time datetime="${isoDate(m.last)}">${through}</time></span></p>
</div>
<div class="dp-act">
<div class="dp-act-h"><p class="dp-h">Purchase activity</p><p class="dp-wk">${m.weeks} weeks · ${m.count} purchases</p></div>
<div class="dp-rows" id="dpRows" role="img" aria-label="${esc(label)}" data-weeks="${m.weeks}" data-pitch="${PITCH}" data-cell="${CELL}">
<div class="dp-axis" aria-hidden="true">${axis}</div>
${rows}
<span class="dp-head" aria-hidden="true"></span>
</div>
<div class="dp-legend" aria-hidden="true"><span>1 bar = 1 week</span><span class="dp-key">less <i class="k1"></i><i class="k2"></i><i class="k3"></i><i class="k4"></i> more</span></div>
</div>
<script type="application/json" id="dpData">${JSON.stringify(data)}</script>
</div>
`;
}

// ---------- write ----------
function main(argv) {
  const args = argv.slice(2);
  let fallback = join(ROOT, '_dev', 'datproof-grid.html');
  const pages = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--fallback') fallback = resolve(args[++i]);
    else pages.push(resolve(args[i]));
  }
  if (!pages.length) pages.push(join(ROOT, 'index.html'));

  const model = buildModel(loadData());
  const frag = renderFragment(model);
  const block = `${START}${frag}${END}`;
  const markerRe = new RegExp(`${START}[\\s\\S]*?${END}`);

  let wrote = 0;
  for (const p of pages) {
    if (!existsSync(p)) continue;
    const html = readFileSync(p, 'utf8');
    if (!html.includes(START) || !html.includes(END)) continue;
    const next = html.replace(markerRe, () => block);
    if (next !== html) writeFileSync(p, next);
    console.log(`${next === html ? 'unchanged' : 'updated'}  ${relative(process.cwd(), p) || p}`);
    wrote++;
  }
  if (!wrote) {
    mkdirSync(dirname(fallback), { recursive: true });
    writeFileSync(fallback, `${block}\n`);
    console.log(`no markers found; fragment written to ${relative(process.cwd(), fallback) || fallback}`);
  }
  console.log(`${model.count} purchases, ${satsToString(model.total)} BTC (shown ${commas(satsRound(model.total))}), `
    + `through ${isoDate(model.last)}, ${model.weeks} weeks`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv);
