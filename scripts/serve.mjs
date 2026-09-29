// Zero-dependency static server for the site, shaped like GitHub Pages:
// directory -> index.html, "/who" -> 301 "/who/", gzip for text, 404.html when present.
//
//   node scripts/serve.mjs [--port 8080] [--root .] [--host 127.0.0.1]
//   import { serve } from './serve.mjs'; const s = await serve({ port: 0 }); ... await s.close();

import { createServer } from 'node:http';
import { stat, readFile } from 'node:fs/promises';
import { join, normalize, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.webmanifest': 'application/manifest+json', '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf',
};
const COMPRESS = /^(text\/|application\/(json|xml|manifest\+json)|image\/svg\+xml)/;

const here = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_ROOT = resolve(here, '..');

async function isFile(p) { try { return (await stat(p)).isFile(); } catch { return false; } }
async function isDir(p) { try { return (await stat(p)).isDirectory(); } catch { return false; } }

export function serve({ root = DEFAULT_ROOT, port = 0, host = '127.0.0.1', quiet = true } = {}) {
  root = resolve(root);
  const server = createServer(async (req, res) => {
    let status = 200;
    try {
      const u = new URL(req.url, 'http://x');
      let rel;
      try { rel = decodeURIComponent(u.pathname); } catch { rel = u.pathname; }
      let file = normalize(join(root, rel));
      if (file !== root && !file.startsWith(root + sep)) { status = 403; res.writeHead(403).end('forbidden'); return; }
      if (await isDir(file)) {
        if (!u.pathname.endsWith('/')) {
          status = 301; res.writeHead(301, { location: u.pathname + '/' + u.search }).end(); return;
        }
        file = join(file, 'index.html');
      }
      let body;
      if (await isFile(file)) body = await readFile(file);
      else if (!extname(file) && await isFile(file + '.html')) { file += '.html'; body = await readFile(file); }
      else {
        status = 404;
        const nf = join(root, '404.html');
        if (await isFile(nf)) { file = nf; body = await readFile(nf); }
        else { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 not found'); return; }
      }
      const type = TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
      const head = { 'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' };
      if (COMPRESS.test(type) && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && body.length > 512) {
        body = gzipSync(body, { level: 6 }); head['content-encoding'] = 'gzip'; head.vary = 'Accept-Encoding';
      }
      head['content-length'] = body.length;
      res.writeHead(status, head);
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (e) {
      status = 500;
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('500 ' + e.message);
    } finally {
      if (!quiet) process.stderr.write(`${status} ${req.method} ${req.url}\n`);
    }
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      const a = server.address();
      ok({
        url: `http://${host}:${a.port}/`, port: a.port, root, server,
        close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const s = await serve({ port: +arg('--port', 8080), root: arg('--root', DEFAULT_ROOT), host: arg('--host', '127.0.0.1'), quiet: false });
  process.stderr.write(`serving ${s.root} at ${s.url}\n`);
}
