import { SITES } from './config.mjs';

export async function fetchText(url, signal) {
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000), headers: { 'cache-control': 'no-cache' } });
  if (response.status !== 200) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

// Parse webpack's static lazy-chunk filename table as data, never execute it.
export function lazyChunks(source) {
  const resolver = /\.u=function\([^)]*\)\{([\s\S]*?)\},[\w$]+\.miniCssF/.exec(source)?.[1] ?? '';
  const literals = [...resolver.matchAll(/"(static\/chunks\/[\w./-]+\.js)"/g)].map(match => match[1]);
  const hashed = [...resolver.matchAll(/(?:[,{])(\d+):"([a-f0-9]{16})"/g)].map(match => `static/chunks/${match[1]}.${match[2]}.js`);
  return [...new Set([...literals, ...hashed])];
}

export async function smokeSite(expected) {
  const signal = AbortSignal.timeout(60000);
  const html = await fetchText(expected.url, signal);
  const build = /(?:\\?"buildId\\?"\s*:\s*\\?")([^"\\]+)/.exec(html)?.[1];
  if (!expected.buildId) throw new Error('Missing deployment buildId expectation');
  if (build !== expected.buildId) throw new Error(`buildId ${build ?? 'missing'}; expected ${expected.buildId} (${expected.commit})`);
  const scripts = [...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map(match => new URL(match[1].replaceAll('&amp;', '&'), expected.url));
  const base = new URL(expected.url);
  if (!scripts.length) throw new Error('No JavaScript bundles in page');
  // The independently built mirror has its own chunk hashes. Discover its
  // lazy chunks from its webpack runtime; Pages uses the recorded export.
  const bundled = (expected.name === 'mirror' ? [] : expected.bundlePaths ?? []).map(path => new URL(path, base));
  if (bundled.some(url => url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname}_next/static/chunks/`) || !url.pathname.endsWith('.js'))) throw new Error('Invalid deployment bundle path');
  const urls = [...new Set([...scripts, ...bundled].filter(url => url.origin === base.origin && url.pathname.startsWith(`${base.pathname}_next/`)).map(url => url.href))];
  if (!urls.length) throw new Error('No Next.js bundles loaded by page');
  const missing = new Set((expected.config?.pins ?? []).map(pin => pin.id));
  for (let i = 0; i < urls.length;) {
    const batch = urls.slice(i, i + 6);
    const chunks = await Promise.all(batch.map(url => fetchText(url, signal)));
    i += batch.length;
    if (expected.name === 'mirror') for (let j = 0; j < batch.length; j++) {
      if (!new URL(batch[j]).pathname.split('/').at(-1).startsWith('webpack-')) continue;
      for (const path of lazyChunks(chunks[j])) {
        const url = new URL(`${base.pathname}_next/${path}`, base).href;
        if (!urls.includes(url)) urls.push(url);
      }
    }
    for (const id of missing) if (chunks.some(chunk => chunk.includes(id))) missing.delete(id);
  }
  if (missing.size) throw new Error(`Bundle missing configured contract ids: ${[...missing].join(', ')}`);
  return `HTTP 200; buildId ${build}; ${urls.length} bundles; ${expected.config?.pins?.length ?? 0} contract ids${expected.config?.skip ? `; NOTICE ${expected.config.skip}` : ''}`;
}

export async function siteChecks(manifest, record) {
  for (const site of SITES) {
    await record(`site/${site.name}`, async () => {
      const expected = manifest?.sites?.find(entry => entry.name === site.name);
      if (!expected || expected.url !== site.url) throw new Error('Missing trusted deployment expectation; see docs/MONITORING.md');
      return smokeSite(expected);
    });
  }
}
