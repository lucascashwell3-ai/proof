// DATproof checks for the verify script. Deliberately independent of scripts/build-datproof.mjs,
// so a bug in the builder can't hide itself.
//
//   csvTotal(dir)   -> { rows, total, totalExact, through }
//     rows: btc_buy rows with a btc value; total: their exact sum as a Number (totalExact: as a
//     decimal string); through: latest filing date, YYYY-MM-DD.
//   pageTotal(page) -> { shown, dataTotal, through, throughText }
//     page: a Playwright Page, or an HTML string. shown: the big number as displayed, commas removed;
//     dataTotal: its data-total attribute as a Number; through: the <time datetime>; throughText: the
//     visible date text.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c;
    } else if (c === '"') q = true;
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

export function csvTotal(dir) {
  let rows = 0, sats = 0n, through = '';
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.csv')).sort()) {
    for (const r of parseCSV(readFileSync(join(dir, f), 'utf8'))) {
      if (r.type !== 'btc_buy' || !r.btc.trim()) continue;
      const [i, d = ''] = r.btc.trim().split('.');
      sats += BigInt(i) * 100000000n + BigInt(d.padEnd(8, '0').slice(0, 8));
      rows++;
      if (r.date > through) through = r.date;
    }
  }
  const frac = (sats % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
  const totalExact = frac ? `${sats / 100000000n}.${frac}` : `${sats / 100000000n}`;
  return { rows, total: Number(totalExact), totalExact, through };
}

export async function pageTotal(page) {
  let got;
  if (typeof page === 'string') {
    const num = /<p class="dp-num" data-total="([^"]*)">([\s\S]*?)<\/p>/.exec(page);
    const time = /<time datetime="([^"]*)">([^<]*)<\/time>/.exec(page.slice(num ? num.index : 0));
    got = {
      text: num ? num[2].replace(/<[^>]+>/g, '') : '',
      data: num ? num[1] : '',
      dt: time ? time[1] : '',
      tt: time ? time[2] : '',
    };
  } else {
    got = await page.evaluate(() => {
      const n = document.querySelector('.dp-num');
      const t = document.querySelector('.dp-sub time');
      return {
        text: n ? n.textContent : '',
        data: n ? n.getAttribute('data-total') : '',
        dt: t ? t.getAttribute('datetime') : '',
        tt: t ? t.textContent : '',
      };
    });
  }
  return {
    shown: Number(got.text.replace(/[,\s]/g, '')),
    dataTotal: Number(got.data),
    through: got.dt,
    throughText: got.tt.trim(),
  };
}
