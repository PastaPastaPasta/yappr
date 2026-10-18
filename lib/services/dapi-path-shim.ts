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
 * - the origin is configured explicitly, or uses HTTPS on a standard DAPI port (443 or 1443);
 * - the path starts with `//org.dash.platform.`.
 * It collapses that leading `//` to `/`. Every other request, including the
 * quorum-service prefetch and any request to another host, goes through
 * untouched. A rewritten request is rebuilt with its body read into a buffer
 * (see `retarget`), and is otherwise the same request on the single-slash path.
 *
 * Also enforce the SDK's request deadline in the browser. wasm_channel ignores
 * the transport timeout setting: grpc-timeout can bound server processing but
 * cannot abort a stalled fetch. The signal stays active through response-body
 * consumption so a stalled gRPC stream also fails over through the SDK.
 *
 * Remove these workarounds once the WASM transport handles paths and deadlines.
 */

const DOUBLE_SLASH_PREFIX = '//org.dash.platform.';

export const DAPI_REQUEST_TIMEOUT_MS = 8_000;

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

/** Only gRPC requests on configured origins or the standard discovered DAPI ports. */
function dapiUrl(url: string, origins: ReadonlySet<string>): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const dapiOrigin = origins.has(parsed.origin) || (parsed.protocol === 'https:' && (parsed.port === '1443' || parsed.port === ''));
  if (!dapiOrigin || !/^\/{1,2}org\.dash\.platform\./.test(parsed.pathname)) return null;
  return parsed;
}

/** Collapse the doubled path on a DAPI request; leave other paths alone. */
export function rewriteDapiUrl(url: string, origins: ReadonlySet<string>): string | null {
  const parsed = dapiUrl(url, origins);
  if (!parsed?.pathname.startsWith(DOUBLE_SLASH_PREFIX)) return null;
  return `${parsed.origin}${parsed.pathname.slice(1)}${parsed.search}${parsed.hash}`;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Honor per-method overrides, including the SDK's longer confirmation streams. */
function requestTimeout(input: RequestInfo | URL, init?: RequestInit): number {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const timeout = headers.get('grpc-timeout')?.match(/^(\d{1,8})([HMSmun])$/);
  if (!timeout) return DAPI_REQUEST_TIMEOUT_MS;
  const units: Record<string, number> = { H: 3_600_000, M: 60_000, S: 1_000, m: 1, u: 0.001, n: 0.000001 };
  const ms = Math.ceil(Number(timeout[1]) * units[timeout[2]]);
  return ms > 0 && ms <= 2_147_483_647 ? ms : DAPI_REQUEST_TIMEOUT_MS;
}

/** Supported mobile WebViews predate AbortSignal.timeout/any. */
function withDeadline(ms: number, caller?: AbortSignal | null): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('DAPI request timed out', 'TimeoutError')), ms);
  const cancel = () => controller.abort(caller?.reason);
  controller.signal.addEventListener('abort', () => {
    clearTimeout(timer);
    caller?.removeEventListener('abort', cancel);
  }, { once: true });
  if (caller?.aborted) cancel();
  else caller?.addEventListener('abort', cancel, { once: true });
  return controller.signal;
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
 * Installs path normalization and a request deadline. Call before the SDK connects. It is
 * idempotent: later calls only add their origins to the installed wrapper. A
 * no-op when `fetch` is missing. Discovered HTTPS nodes on ports 443 and 1443 are always covered.
 */
export function installDapiPathShim(addresses: readonly string[] = []): void {
  if (typeof globalThis.fetch !== 'function') return;
  const origins = addresses.map(originOf).filter((origin): origin is string => origin !== null);

  const installed = (globalThis.fetch as ShimmedFetch)[SHIM_ORIGINS];
  if (installed) {
    for (const origin of origins) installed.add(origin);
    return;
  }

  const rewritten = new Set(origins);
  const original = globalThis.fetch.bind(globalThis);
  const wrapped: ShimmedFetch = async (input, init) => {
    const url = requestUrl(input);
    if (!dapiUrl(url, rewritten)) return original(input, init);
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = withDeadline(requestTimeout(input, init), callerSignal);
    const fixed = rewriteDapiUrl(url, rewritten);
    const target = fixed === null ? input : input instanceof Request ? await retarget(input, fixed) : fixed;
    return original(target, { ...init, signal });
  };
  wrapped[SHIM_ORIGINS] = rewritten;
  globalThis.fetch = wrapped;
}
