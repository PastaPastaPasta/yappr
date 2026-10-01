import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import { config } from '~/config';

import type { StorageSnapshot } from './storage/engine-storage';

/**
 * How the hidden WebView loads the engine page (mobile/engine/README.md
 * "Origin and CORS finding"; ENGINE.md §2.3).
 *
 * `inline` (default): engine.inline.html, read from the app bundle (or, in
 * dev, from YAPPR_ENGINE_DEV_URL), loaded with the https base URL below. The
 * origin is stable and secure, and WebKit compiles the wasm in a Worker. The
 * host prepends a CSP and its bootstrap script to the page, which is the only
 * way to run before the engine on Android (react-native-webview runs
 * `injectedJavaScriptBeforeContentLoaded` there from onPageStarted, which
 * does not order it before the page's own scripts).
 *
 * `file`: engine.html + engine.js over file://, with the bootstrap in
 * `injectedJavaScriptBeforeContentLoaded` (reliably first on iOS only).
 */
export const ENGINE_ORIGIN = 'https://engine.yap.pr';

/**
 * The engine renders nothing, loads no subresource and talks only to DAPI,
 * quorum and Insight over https. Scripts are inline (the 15 MB bundle and the
 * bootstrap), hence 'unsafe-inline'; 'unsafe-eval' is for wasm-bindgen's
 * `new Function` and WebAssembly compilation, as on web.
 */
const CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; connect-src https:; worker-src blob:; " +
  "img-src https: data: blob:; base-uri 'none'; form-action 'none'";

export type Simulation = 'no-webassembly' | 'old-webview';

export interface EngineLoad {
  source: { html: string; baseUrl: string } | { uri: string };
  injectedJavaScriptBeforeContentLoaded?: string;
  /** file mode: the directory the page may read. */
  readAccessUrl?: string;
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

/** Insert the CSP and the bootstrap at the top of `<head>`, ahead of the engine's own scripts. */
export function composeInlineHtml(html: string, bootstrap: string): string {
  const head = html.indexOf('<head>');
  if (head < 0) throw new Error('engine.inline.html has no <head>');
  const at = head + '<head>'.length;
  const prelude = `<meta http-equiv="Content-Security-Policy" content="${CSP}"><script>${bootstrap}</script>`;
  return html.slice(0, at) + prelude + html.slice(at);
}

/** The engine directory inside the app (plugins/engine-assets). */
const bundledEngineDir = () => (Platform.OS === 'android' ? 'asset:///engine/' : `${Paths.bundle.uri}engine/`);

/** The 15 MB page, read on every boot (not cached: it would sit in the JS heap for the app's lifetime). */
async function readInlineHtml(): Promise<string> {
  const devUrl = __DEV__ ? config.engine?.devUrl : undefined;
  if (devUrl) {
    // Re-fetched on every boot, so "Restart engine" picks up a rebuilt engine.
    const response = await fetch(`${devUrl.replace(/\/$/, '')}/engine.inline.html`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Engine dev server answered ${response.status}`);
    return response.text();
  }
  return new File(`${bundledEngineDir()}engine.inline.html`).text();
}

export async function loadEnginePage(snapshot: StorageSnapshot, simulate: Simulation | null): Promise<EngineLoad> {
  const bootstrap = bootstrapScript(snapshot, simulate);
  if (config.engine?.load === 'file' && !(__DEV__ && config.engine.devUrl)) {
    const dir = Platform.OS === 'android' ? 'file:///android_asset/engine/' : bundledEngineDir();
    return {
      source: { uri: `${dir}engine.html` },
      injectedJavaScriptBeforeContentLoaded: bootstrap,
      readAccessUrl: dir,
      pageUrl: `${dir}engine.html`,
    };
  }
  const html = await readInlineHtml();
  return { source: { html: composeInlineHtml(html, bootstrap), baseUrl: `${ENGINE_ORIGIN}/` }, pageUrl: `${ENGINE_ORIGIN}/` };
}
