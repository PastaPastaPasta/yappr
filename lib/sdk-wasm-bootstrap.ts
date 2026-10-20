import { STATIC_ROUTES } from './static-routes'
import { preloadSdkWasm, sdkWasmUrl } from './web-wasm-preload'

const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c')

/**
 * The inline head script that starts the SDK WASM download while the HTML is
 * still parsing. Every route but the static pages reads through the SDK, and
 * on a slow phone the download is most of the wait: starting it at hydration
 * instead costs seconds.
 */
export function sdkWasmBootstrap(basePath: string, url: string, cacheName: string): string {
  const skip = STATIC_ROUTES.flatMap(route => [`${basePath}${route}`, `${basePath}${route}/`])
  // The gzip URL goes in; the browser picks its file (sdkWasmUrl) the way init() does.
  return `if(!${json(skip)}.includes(location.pathname))window.__yapprSdkWasm??=(${preloadSdkWasm.toString()})((${sdkWasmUrl.toString()})(${json(url)}),${json(cacheName)});`
}
