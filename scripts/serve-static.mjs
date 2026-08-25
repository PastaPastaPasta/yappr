/**
 * Serves the static export in `out/` the way GitHub Pages does, for local runs
 * and for Playwright's `webServer`. Node port of the older `serve.py` — no
 * Python and no dependencies in CI.
 *
 * The WASM SDK needs cross-origin isolation headers, which `headers()` in
 * next.config.js cannot provide under `output: 'export'`, so they are set here.
 * `credentialless` (rather than `require-corp`) keeps third-party images and
 * avatars loadable without CORP headers on their side.
 *
 * Run:  node scripts/serve-static.mjs [--port 3000] [--base /testing]
 *
 * `--base ''` serves the production-shaped export at the root.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'out');

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function parseArgs(argv) {
  const args = { port: 3000, base: '/testing' };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--port': args.port = Number(argv[++i]); break;
      case '--base': args.base = argv[++i] ?? ''; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!Number.isInteger(args.port) || args.port <= 0 || args.port > 65535) {
    throw new Error(`Invalid --port: ${args.port}`);
  }
  // Normalise to either '' or '/segment' (no trailing slash).
  args.base = args.base.replace(/\/+$/, '');
  if (args.base && !args.base.startsWith('/')) args.base = `/${args.base}`;
  return args;
}

/**
 * Maps a request path to a file inside `out/`, honouring the mount base and the
 * `trailingSlash` export layout (a directory resolves to its `index.html`).
 *
 * @returns The absolute file path, or null when nothing matches.
 */
function resolveFile(urlPath, base) {
  let relativePath;
  try {
    relativePath = decodeURIComponent(urlPath);
  } catch {
    return null; // malformed percent-encoding — treat as "not found", never throw
  }
  if (base) {
    if (relativePath === base) relativePath = '/';
    else if (relativePath.startsWith(`${base}/`)) relativePath = relativePath.slice(base.length);
    else return null;
  }

  const candidate = resolve(OUT_DIR, `.${normalize(relativePath)}`);
  // Refuse anything that escapes out/ via traversal.
  if (candidate !== OUT_DIR && !candidate.startsWith(OUT_DIR + sep)) return null;

  if (existsSync(candidate)) {
    if (!statSync(candidate).isDirectory()) return candidate;
    const index = join(candidate, 'index.html');
    if (existsSync(index)) return index;
    return null;
  }

  // Next emits `<route>.html` alongside `<route>/index.html` for some routes.
  const asHtml = `${candidate}.html`;
  return existsSync(asHtml) ? asHtml : null;
}

function send(res, statusCode, filePath) {
  const headers = {
    'Content-Type': MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'Cross-Origin-Embedder-Policy': 'credentialless',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cache-Control': 'no-cache',
  };
  res.writeHead(statusCode, headers);
  const stream = createReadStream(filePath);
  // A read failure after the header is out can't be turned into an error page,
  // but it must not become an unhandled 'error' event that kills the server.
  stream.on('error', (e) => {
    console.error(`failed to read ${filePath}: ${e.message}`);
    res.destroy();
  });
  stream.pipe(res);
}

const args = (() => {
  try {
    return parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    console.error('Usage: node scripts/serve-static.mjs [--port 3000] [--base /testing]');
    process.exit(1);
  }
})();

if (!existsSync(OUT_DIR)) {
  console.error(`No static export at ${OUT_DIR} — run \`npm run build:testing\` first.`);
  process.exit(1);
}

const notFoundPage = join(OUT_DIR, '404.html');

const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }

  const urlPath = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`).pathname;
  const filePath = resolveFile(urlPath, args.base);

  if (filePath) {
    send(res, 200, filePath);
  } else if (existsSync(notFoundPage)) {
    send(res, 404, notFoundPage);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found\n');
  }
});

server.listen(args.port, () => {
  console.log(`serving ${OUT_DIR} at http://localhost:${args.port}${args.base || ''}/`);
});
