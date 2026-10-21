#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** GitHub Pages always serves the site's root 404, even for another deployment. */
export function staticNotFound(basePath = '') {
  if (basePath && !/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(basePath)) throw new Error('Invalid deployment prefix')
  const home = `${basePath}/`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Page not found · Yappr</title>

<style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif;background:#fff;color:#111827}body{margin:0;min-height:100vh;display:grid;place-items:center}main{max-width:32rem;padding:2rem;text-align:center}p{color:#4b5563;line-height:1.6}nav{display:flex;gap:1rem;justify-content:center;margin-top:2rem}a{padding:.75rem 1.25rem;border-radius:2rem;background:#0369a1;color:#fff;font-weight:600;text-decoration:none}a:focus-visible{outline:3px solid #0369a1;outline-offset:4px}@media(prefers-color-scheme:dark){:root{background:#171717;color:#fff}p{color:#a3a3a3}a:focus-visible{outline-color:#38bdf8}}
</style></head><body><main><p>404</p><h1>This page doesn’t exist</h1><p>The link may be broken, or the page may have moved.</p><nav aria-label="Recovery"><a id="home" href="${home}">Go home</a><a id="explore" href="${home}explore/">Explore</a></nav></main>
<script>
(function () {
  var match = location.pathname.match(/^\\/(devnet|testing|staging-old|staging)(?:\\/|$)/);
  var prefix = match ? '/' + match[1] : ${JSON.stringify(basePath)};
  if (prefix !== ${JSON.stringify(basePath)} && location.pathname !== prefix + '/404.html') location.replace(prefix + '/404.html');
  if (match) {
    document.getElementById('home').href = '/' + match[1] + '/';
    document.getElementById('explore').href = '/' + match[1] + '/explore/';
  }
})();
</script></body></html>`
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = resolve(process.argv[2] || 'out')
  mkdirSync(directory, { recursive: true })
  // Next loads env files inside its own process. Its manifest records the prefix actually exported.
  const manifest = resolve(directory, '../.next/routes-manifest.json')
  const basePath = process.argv[3] ?? (existsSync(manifest)
    ? JSON.parse(readFileSync(manifest, 'utf8')).basePath
    : process.env.BASE_PATH) ?? ''
  writeFileSync(resolve(directory, '404.html'), staticNotFound(basePath))
}
