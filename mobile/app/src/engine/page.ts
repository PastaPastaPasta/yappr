import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import { config } from '~/config';

import cspPolicy from './csp.json';

import type { StorageSnapshot } from './storage/engine-storage';

/**
 * How the hidden WebView loads the engine (mobile/engine/README.md "How the
 * wasm loads"; ENGINE.md §2.3): engine.js, then its sidecar scripts (the
 * SDK's WASM and the avatar styles), all read by the WebView straight from
 * the app bundle, so none of their 15 MB crosses the React Native bridge. The
 * host's CSP and bootstrap script come first.
 *
 * - iOS: `index.html` (engine.html plus the CSP, written by the engine-assets
 *   plugin) by file URL, with read access to its directory. The bootstrap is
 *   a document-start user script (`injectedJavaScriptBeforeContentLoaded`).
 * - Android: a small loader page whose base is the APK's engine assets
 *   directory, with the CSP and bootstrap inline: react-native-webview runs
 *   `injectedJavaScriptBeforeContentLoaded` from onPageStarted there, racing
 *   the page. (`loadDataWithBaseURL` also silently yields an empty page for
 *   data over about 15 MB, which rules out inlining the engine.)
 * - Dev (`YAPPR_ENGINE_DEV_URL`): Android's loader page with the dev server as
 *   its base; iOS fetches engine.inline.html and loads it with an https base,
 *   as it does from a dev client built before the split (no index.html).
 */
const IOS_ENGINE_DIR = `${Paths.bundle.uri}engine/`;
const IOS_DEV_PAGE_URL = 'https://engine.yap.pr/';
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
 * https. Its scripts are beside the page ('self' and file:) or inline;
 * 'unsafe-eval' is for wasm-bindgen's `new Function` and WebAssembly
 * compilation, as on web. Shared with the engine-assets plugin, which writes
 * it into the iOS page.
 */
const CSP = cspPolicy.policy;

export type Simulation = 'no-webassembly' | 'old-webview';

export interface EngineLoad {
  source: { html: string; baseUrl: string } | { uri: string };
  /** Android: the loader page reads the engine's scripts from the app's assets. */
  allowFileAccess: boolean;
  /** iOS: the directory the page may read (its scripts). */
  allowingReadAccessToURL?: string;
  /** iOS: the bootstrap, when the page is a file rather than composed HTML. */
  injectedJavaScriptBeforeContentLoaded?: string;
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

/**
 * The scripts the loader page runs, in order: the bundle, then its sidecars
 * (mobile/engine src/sidecar.ts), the SDK's WASM and the avatar styles. The
 * engine says hello while they, fetched in parallel, are still being read.
 */
const LOADER_SCRIPTS = ['engine.js', 'engine.wasm.js', 'engine.avatars.js'];

/** A page that loads the engine's scripts from its base URL, after the CSP and the bootstrap (engine.html, plus those). */
export function composeLoaderHtml(bootstrap: string, bundleHash: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">${prelude(bootstrap)}` +
    `<script>globalThis.__YAPPR_ENGINE_BUNDLE_HASH__=${JSON.stringify(bundleHash)};` +
    // A reload would re-run the engine on a stale snapshot; the supervisor restarts it instead.
    "if((performance.getEntriesByType('navigation')[0]||{}).type!=='reload'){" +
    // Inserted scripts run in insertion order only with async off; all three still download at once.
    `${JSON.stringify(LOADER_SCRIPTS)}.forEach(function(n){var s=document.createElement('script');` +
    's.src=n;s.async=false;document.head.appendChild(s)})}</script>' +
    '</head><body></body></html>'
  );
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
  const pageUrl = `${IOS_ENGINE_DIR}index.html`;
  if (devUrl || !new File(pageUrl).exists) {
    // Dev: re-fetched on every boot, so "Restart engine" picks up a rebuilt engine. No index.html:
    // a dev client built before the engine was split, which bundles only the inline page.
    const inline = devUrl
      ? await (await fetchDev('engine.inline.html')).text()
      : await new File(`${IOS_ENGINE_DIR}engine.inline.html`).text();
    const html = composeInlineHtml(inline, bootstrap);
    return { source: { html, baseUrl: IOS_DEV_PAGE_URL }, allowFileAccess: false, pageUrl: IOS_DEV_PAGE_URL };
  }
  return {
    source: { uri: pageUrl },
    allowFileAccess: false,
    allowingReadAccessToURL: IOS_ENGINE_DIR,
    injectedJavaScriptBeforeContentLoaded: bootstrap,
    pageUrl,
  };
}
