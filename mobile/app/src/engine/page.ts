import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import { config } from '~/config';

import type { StorageSnapshot } from './storage/engine-storage';

/**
 * How the hidden WebView loads the engine (mobile/engine/README.md "Origin and
 * CORS finding"; ENGINE.md §2.3). Either way the host's CSP and bootstrap
 * script come first in the page, ahead of the engine: the only ordering that
 * holds on Android, where react-native-webview runs
 * `injectedJavaScriptBeforeContentLoaded` from onPageStarted, racing the page.
 *
 * - iOS: engine.inline.html (the bundle inlined) with an https base URL, so
 *   the origin is stable and secure and WebKit compiles the wasm in a Worker.
 * - Android: a small loader page whose base is the APK's engine assets
 *   directory, loading engine.js from there. Android System WebView's
 *   `loadDataWithBaseURL` silently yields an empty page for data over about
 *   15 MB (WebView 124: 14.9 MB loads, 15.3 MB does not), which the inlined
 *   bundle has outgrown.
 */
const IOS_PAGE_URL = 'https://engine.yap.pr/';
const ANDROID_ASSETS_URL = 'file:///android_asset/engine/';

/** Dev only: read the engine from YAPPR_ENGINE_DEV_URL instead of the app bundle. */
const devUrl = __DEV__ ? config.engine?.devUrl?.replace(/\/?$/, '/') : undefined;

/** Dev server reads, never from a cache (Android's HTTP cache ignores `cache: 'no-store'`). */
async function fetchDev(name: string): Promise<Response> {
  const response = await fetch(`${devUrl}${name}?t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Engine dev server answered ${response.status} for ${name}`);
  return response;
}

/**
 * The engine renders nothing and talks only to DAPI, quorum and Insight over
 * https. Its scripts are inline or engine.js beside the page ('self' and
 * file:); 'unsafe-eval' is for wasm-bindgen's `new Function` and WebAssembly
 * compilation, as on web.
 */
const CSP =
  `default-src 'none'; script-src ${Platform.OS === 'android' ? "'self' file:" : ''} 'unsafe-inline' 'unsafe-eval'; ` +
  "connect-src https:; worker-src blob:; img-src https: data: blob:; base-uri 'none'; form-action 'none'";

export type Simulation = 'no-webassembly' | 'old-webview';

export interface EngineLoad {
  source: { html: string; baseUrl: string };
  /** Android: the loader page reads engine.js from the app's assets. */
  allowFileAccess: boolean;
  /** Where the page lives; navigation anywhere else is refused, and messages from elsewhere ignored. */
  pageUrl: string;
}

/**
 * Runs before the engine bundle: hands it the storage snapshot (read by
 * mobile/engine src/shims/storage.ts `takeInjectedSnapshot`), then reports
 * the WebView's capabilities so an unusable WebView is caught even when the
 * bundle cannot parse. `simulate` exercises the Lockdown and outdated-WebView
 * paths on devices that are neither.
 */
export function bootstrapScript(snapshot: StorageSnapshot, simulate: Simulation | null): string {
  // Safe inside <script>: no `<` survives, and JSON is valid JS.
  const json = JSON.stringify(snapshot).replace(/</g, '\\u003c');
  const userAgent =
    simulate === 'old-webview' ? "navigator.userAgent.replace(/Chrome\\/\\d+/, 'Chrome/90')" : 'navigator.userAgent';
  return [
    `window.__YAPPR_ENGINE_STORAGE__=${json};`,
    simulate === 'no-webassembly' ? 'delete window.WebAssembly;' : '',
    '(function(){try{window.ReactNativeWebView.postMessage(JSON.stringify({',
    `t:'host-caps',userAgent:${userAgent},webAssembly:typeof WebAssembly==='object',`,
    'secureContext:!!window.isSecureContext,subtleCrypto:!!(window.crypto&&window.crypto.subtle),',
    "worker:typeof Worker==='function',decompressionStream:typeof DecompressionStream==='function'",
    '}))}catch(e){}})();true;',
  ].join('');
}

const prelude = (bootstrap: string) =>
  `<meta http-equiv="Content-Security-Policy" content="${CSP}"><script>${bootstrap}</script>`;

/** Insert the CSP and the bootstrap at the top of `<head>`, ahead of the engine's own scripts. */
export function composeInlineHtml(html: string, bootstrap: string): string {
  const head = html.indexOf('<head>');
  if (head < 0) throw new Error('engine.inline.html has no <head>');
  const at = head + '<head>'.length;
  return html.slice(0, at) + prelude(bootstrap) + html.slice(at);
}

/** A page that loads engine.js from its base URL, after the CSP and the bootstrap (engine.html, plus those). */
export function composeLoaderHtml(bootstrap: string, bundleHash: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">${prelude(bootstrap)}` +
    `<script>globalThis.__YAPPR_ENGINE_BUNDLE_HASH__=${JSON.stringify(bundleHash)};` +
    // A reload would re-run the engine on a stale snapshot; the supervisor restarts it instead.
    "if((performance.getEntriesByType('navigation')[0]||{}).type!=='reload'){" +
    "var s=document.createElement('script');s.src='engine.js';document.head.appendChild(s)}</script>" +
    '</head><body></body></html>'
  );
}

/** iOS: the 15 MB page, read on every boot rather than kept in the JS heap between boots. */
async function readInlineHtml(): Promise<string> {
  if (devUrl) {
    // Re-fetched on every boot, so "Restart engine" picks up a rebuilt engine.
    return (await fetchDev('engine.inline.html')).text();
  }
  return new File(`${Paths.bundle.uri}engine/engine.inline.html`).text();
}

/** Android: the bundle hash for the loader page (the dev server's engine may differ from the build's). */
async function bundleHash(): Promise<string> {
  if (!devUrl) return config.engine?.bundleHash ?? 'unknown';
  return ((await (await fetchDev('manifest.json')).json()) as { sha256: string }).sha256;
}

export async function loadEnginePage(snapshot: StorageSnapshot, simulate: Simulation | null): Promise<EngineLoad> {
  const bootstrap = bootstrapScript(snapshot, simulate);
  if (Platform.OS === 'android') {
    const baseUrl = devUrl ?? ANDROID_ASSETS_URL;
    return {
      source: { html: composeLoaderHtml(bootstrap, await bundleHash()), baseUrl },
      allowFileAccess: !devUrl,
      pageUrl: baseUrl,
    };
  }
  const html = composeInlineHtml(await readInlineHtml(), bootstrap);
  return { source: { html, baseUrl: IOS_PAGE_URL }, allowFileAccess: false, pageUrl: IOS_PAGE_URL };
}
