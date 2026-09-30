/**
 * Works around a latent SDK bug: the wasm SDK's gRPC-web requests carry a
 * double slash in their path.
 *
 * rs-dapi-client's `wasm_channel.rs` has built the client's base URL from
 * `uri.to_string()` since the wasm SDK was introduced (platform#2405). That
 * string ends in a slash (`https://68.67.122.224:1443/`). tonic-web-wasm-client
 * 0.9.1 (`call.rs`) then appends the method path, which starts with its own
 * slash, using `base_url.push_str(uri)`. Every DAPI call therefore goes to
 * `https://68.67.122.224:1443//org.dash.platform.dapi.v0.Platform/getStatus`.
 *
 * A gateway that merges slashes (envoy `merge_slashes`) answers it anyway.
 * One that does not answers 404 with an empty body, and the SDK reports that
 * as a "malformed response". Some bonsia devnet nodes have done this.
 *
 * The shim wraps `globalThis.fetch` and rewrites only requests that match both
 * of these:
 * - the origin is one of the configured DAPI addresses;
 * - the path starts with `//org.dash.platform.`.
 * It collapses that leading `//` to `/`. Every other request, including the
 * quorum-service prefetch and any request to another host, goes through
 * untouched. A rewritten request is rebuilt with its body read into a buffer
 * (see `retarget`), and is otherwise the same request on the single-slash path.
 *
 * Remove the shim once platform fixes the SDK to stop emitting the double
 * slash.
 */

const DOUBLE_SLASH_PREFIX = '//org.dash.platform.';

/** Marks the installed wrapper and holds the origins it rewrites. */
const SHIM_ORIGINS = Symbol.for('yappr.dapiPathShim.origins');

type ShimmedFetch = typeof fetch & { [SHIM_ORIGINS]?: Set<string> };

/** The origin of an address such as `https://68.67.122.224:1443`, or null if it is not a URL. */
function originOf(address: string): string | null {
  try {
    return new URL(address).origin;
  } catch {
    return null;
  }
}

/**
 * The single-slash form of `url` when it is a DAPI request to one of `origins`
 * with the doubled path. Otherwise null, meaning the request is left alone.
 */
export function rewriteDapiUrl(url: string, origins: ReadonlySet<string>): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!origins.has(parsed.origin) || !parsed.pathname.startsWith(DOUBLE_SLASH_PREFIX)) return null;
  return `${parsed.origin}${parsed.pathname.slice(1)}${parsed.search}${parsed.hash}`;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * `request` on a new URL. The body is read into a buffer and passed
 * explicitly. `new Request(url, request)` would take it from `request.body`,
 * which Firefox and Safari do not implement: the copy would go out empty. In
 * Chromium it would become a streaming upload, which needs HTTP/2. The gRPC-web
 * bodies here are small, single messages.
 */
async function retarget(request: Request, url: string): Promise<Request> {
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  return new Request(url, {
    method: request.method,
    headers: request.headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
    mode: request.mode,
    credentials: request.credentials,
    cache: request.cache,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    integrity: request.integrity,
    keepalive: request.keepalive,
    signal: request.signal,
  });
}

/**
 * Installs the rewrite for `addresses`. Call it before the SDK connects. It is
 * idempotent: later calls only add their origins to the installed wrapper. A
 * no-op when `fetch` is missing or no address parses.
 */
export function installDapiPathShim(addresses: readonly string[]): void {
  if (typeof globalThis.fetch !== 'function') return;
  const origins = addresses.map(originOf).filter((origin): origin is string => origin !== null);
  if (origins.length === 0) return;

  const installed = (globalThis.fetch as ShimmedFetch)[SHIM_ORIGINS];
  if (installed) {
    for (const origin of origins) installed.add(origin);
    return;
  }

  const rewritten = new Set(origins);
  const original = globalThis.fetch.bind(globalThis);
  const wrapped: ShimmedFetch = async (input, init) => {
    const fixed = rewriteDapiUrl(requestUrl(input), rewritten);
    if (fixed === null) return original(input, init);
    if (!(input instanceof Request)) return original(fixed, init);
    return original(await retarget(input, fixed), init);
  };
  wrapped[SHIM_ORIGINS] = rewritten;
  globalThis.fetch = wrapped;
}
