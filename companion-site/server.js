// Companion teaching site for the A2A spike — a static site, independent of the application.
// Serves ./public on http://localhost:4440 (bound to 127.0.0.1 only). No API keys, no model calls,
// no backend of the application needed. If port 4440 is taken it says so and exits: it never picks
// another port or stops whatever is using it.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 4440;
const HOST = '127.0.0.1';
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
  const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  // Every page is the single index.html (the site routes with #/… addresses); files are served as-is.
  const rel = path === '/' ? 'index.html' : path.slice(1);
  const file = normalize(join(ROOT, rel));
  if (!file.startsWith(ROOT + sep) && file !== join(ROOT, 'index.html')) { res.writeHead(403).end(); return; }
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use on ${HOST}. The companion site needs exactly this port; free it (or stop what uses it) and run again. Nothing was changed.`);
  else console.error(`Could not start the companion site: ${err.message}`);
  process.exit(1);
});
server.listen(PORT, HOST, () => console.log(`A2A spike companion site: http://localhost:${PORT}  (Ctrl+C to stop)`));
