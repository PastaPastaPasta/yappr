/**
 * Watches the SDK's DAPI traffic for Engine diagnostics (PRD SET-08: "DAPI
 * endpoints with last success"). The wasm SDK speaks gRPC-web over `fetch`,
 * so a wrapper around `fetch` sees every DAPI request: the ones whose path
 * names a `org.dash.platform.` service. It only counts them; the request and
 * its response pass through untouched, and nothing about a request but its
 * origin and outcome is kept.
 *
 * An endpoint "answered" when the response is HTTP 2xx and gRPC did not say
 * UNAVAILABLE (14): an application error (not found, invalid argument) still
 * means the node is up. A rejected fetch (no route, TLS, CORS, abort) is a
 * failure.
 */

const DAPI_SERVICE = '/org.dash.platform.'
/** gRPC's UNAVAILABLE: the gateway is up but the node behind it is not. */
const GRPC_UNAVAILABLE = '14'

export interface DapiEndpointDTO {
  /** `https://host:port`. */
  origin: string
  requests: number
  failures: number
  /** Epoch ms of the last answered request, or null. */
  lastOkAt: number | null
  lastErrorAt: number | null
}

export interface DapiStatusDTO {
  /** The configured address pool's size (devnet); 0 when the SDK discovers its nodes (testnet, mainnet). */
  configured: number
  /** Every endpoint the SDK has used, most recently answered first. */
  endpoints: DapiEndpointDTO[]
  /** The last answer from any endpoint, or null. */
  lastOkAt: number | null
}

/** The origin of a DAPI request's URL, or null for any other request. */
export function dapiOrigin(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.pathname.includes(DAPI_SERVICE) ? parsed.origin : null
  } catch {
    return null
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

export function createDapiMonitor(now: () => number = Date.now) {
  const endpoints = new Map<string, DapiEndpointDTO>()

  const record = (origin: string, ok: boolean) => {
    const endpoint = endpoints.get(origin) ?? { origin, requests: 0, failures: 0, lastOkAt: null, lastErrorAt: null }
    endpoint.requests += 1
    if (ok) endpoint.lastOkAt = now()
    else {
      endpoint.failures += 1
      endpoint.lastErrorAt = now()
    }
    endpoints.set(origin, endpoint)
  }

  return {
    record,

    /** `fetch`, counting the DAPI requests it makes. */
    wrap(original: typeof fetch): typeof fetch {
      return async (input, init) => {
        const origin = dapiOrigin(requestUrl(input))
        if (origin === null) return original(input, init)
        try {
          const response = await original(input, init)
          record(origin, response.ok && response.headers.get('grpc-status') !== GRPC_UNAVAILABLE)
          return response
        } catch (error) {
          record(origin, false)
          throw error
        }
      }
    },

    status(configured: number): DapiStatusDTO {
      const list = [...endpoints.values()]
        .map(endpoint => ({ ...endpoint }))
        .sort((a, b) => (b.lastOkAt ?? 0) - (a.lastOkAt ?? 0) || a.origin.localeCompare(b.origin))
      return { configured, endpoints: list, lastOkAt: list[0]?.lastOkAt ?? null }
    },
  }
}

export const dapiMonitor = createDapiMonitor()

/** Wrap the page's `fetch`. Call before the SDK makes its first request. */
export function installDapiMonitor(): void {
  if (typeof globalThis.fetch !== 'function') return
  globalThis.fetch = dapiMonitor.wrap(globalThis.fetch.bind(globalThis))
}
