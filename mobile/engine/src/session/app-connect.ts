import type { AppConnectGrant } from 'platform-auth'
import { appConnectPins, isAppConnectBuild } from '@/lib/app-connect/config'
import { AppConnectLogin, type AppConnectLoginState, type AppConnectUnavailableReason } from '@/lib/app-connect/login-flow'
import { requestRecordsFor } from '@/lib/app-connect/pending-request'
import { appConnectPlatformPort } from '@/lib/app-connect/platform-port'
import { appConnectSessions } from '@/lib/app-connect/session-manager'
import { appConnectCallbackUrl } from '@/lib/app-connect/yappr-request'
import { logger } from '@/lib/logger'
import { dpnsService } from '@/lib/services/dpns-service'
import { RpcError } from '../protocol/envelope'

/**
 * Wallet sign-in through App Connect (docs/APP_CONNECT_PROFILE.md), the
 * engine side of web's `useAppConnectLogin`: lib's `AppConnectLogin` makes
 * the request, polls for answers and verifies each one on chain, and this
 * module reports its state to the host (`session.appConnect` events) and
 * hands the grant the user confirms to the session module.
 *
 * The request (its ephemeral key wrapped under the key ring's device key) is
 * kept in the secure area until it is answered or runs out, so an app killed
 * while the wallet is open resumes it (`start` without `fresh`).
 */

export interface AppConnectCandidateDTO {
  identityId: string
  username: string | null
}

export type AppConnectPhaseDTO =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'unavailable'; reason: AppConnectUnavailableReason }
  /** `requestHash`: what the wallet's return link names (`r=`), hex. */
  | { phase: 'waiting'; uri: string; requestHash: string }
  /** Verified answers; polling goes on, so another account that answers is added. */
  | { phase: 'confirm'; uri: string; requestHash: string; candidates: AppConnectCandidateDTO[] }
  /** No answer within the request's 10 minutes. */
  | { phase: 'timeout'; uri: string; requestHash: string }
  /** Something kept answering the request: start again. */
  | { phase: 'too-many' }

/** `flow` numbers each `start`, so the host can drop a late event of an earlier one. `renew`: only the signed-in account may answer. */
export type AppConnectFlowDTO = AppConnectPhaseDTO & { flow: number; renew: boolean }

/** Where the wallet sends the user back: yap.pr's return page for this app, which opens the app by its scheme. */
export interface AppConnectReturn {
  /** The app's prefix on yap.pr: `/devnet`, or empty. */
  webBasePath: string
  /** The app's URL scheme (`yappr-dev`). */
  scheme: string
}

const WEB_ORIGIN = 'https://yap.pr'
const SCHEMES = /^yappr(?:-dev|-beta)?$/
const BASE_PATH = /^(?:\/[a-z0-9-]+)?$/

/**
 * The wallet's return link. The profile allows only https links on a host
 * the wallet ties to the app, so it is yap.pr's `/connect` page, as on web,
 * with `app=<scheme>`: that page then opens the app instead of signing in on
 * the web. The link is only a nudge to poll; nothing in it is trusted.
 */
export function appConnectReturnUrl(target: AppConnectReturn, requestHashHex: string): string | undefined {
  const url = appConnectCallbackUrl(WEB_ORIGIN, target.webBasePath, requestHashHex)
  if (!url) return undefined
  const parsed = new URL(url)
  parsed.searchParams.set('app', target.scheme)
  return parsed.toString()
}

function checkReturn(target: unknown): AppConnectReturn {
  const { webBasePath, scheme } = (target ?? {}) as Partial<AppConnectReturn>
  if (typeof webBasePath !== 'string' || !BASE_PATH.test(webBasePath) || typeof scheme !== 'string' || !SCHEMES.test(scheme)) {
    throw new RpcError('returnTo must name the app\'s yap.pr prefix and scheme', 'BAD_REQUEST')
  }
  return { webBasePath, scheme }
}

export function createAppConnectFlow(options: { emit(state: AppConnectFlowDTO): void }) {
  let login: AppConnectLogin | null = null
  /** The identity a renewal is for; undefined for a sign-in. */
  let renewFor: string | undefined
  let flow = 0
  let state: AppConnectFlowDTO = { flow, renew: false, phase: 'idle' }
  /** The login state last seen, so a confirm whose names resolve late is dropped once superseded. */
  let latest: AppConnectLoginState | null = null

  function set(next: AppConnectFlowDTO): void {
    state = next
    options.emit(next)
  }

  async function names(candidates: { identityId: string }[]): Promise<AppConnectCandidateDTO[]> {
    return Promise.all(candidates.map(async ({ identityId }) => ({
      identityId,
      username: await dpnsService.resolveUsername(identityId).catch(() => null),
    })))
  }

  function publish(id: number, instance: AppConnectLogin, next: AppConnectLoginState): void {
    if (id !== flow) return
    latest = next
    const base = { flow: id, renew: renewFor !== undefined }
    const requestHash = instance.requestHashHex() ?? ''
    switch (next.phase) {
      case 'confirm':
        names(next.candidates)
          .then((candidates) => {
            if (latest === next) set({ ...base, phase: 'confirm', uri: next.uri, requestHash, candidates })
          })
          .catch((error: unknown) => logger.warn('App Connect: could not read the answering accounts:', error))
        return
      case 'waiting':
      case 'timeout':
        set({ ...base, phase: next.phase, uri: next.uri, requestHash })
        return
      default:
        set({ ...base, ...next })
    }
  }

  /** Stops the running flow; its request stays stored while the wallet may still answer it. */
  function stop(): void {
    login?.dispose()
    login = null
    latest = null
    renewFor = undefined
  }

  /** Ends the flow: the host hears it is idle. */
  function reset(): void {
    stop()
    set({ flow: ++flow, renew: false, phase: 'idle' })
  }

  return {
    state: (): AppConnectFlowDTO => state,

    /** The identity the running flow renews, if it is a renewal. */
    renewing: (): string | undefined => renewFor,

    /**
     * Starts a sign-in (or, with `identityHint`, a renewal only that identity
     * may answer), resuming the stored request of the same kind unless
     * `fresh`. Resolves once the request is ready (or unavailable).
     */
    async start(input: { identityHint?: string; fresh?: boolean; returnTo: unknown }): Promise<AppConnectFlowDTO> {
      if (!isAppConnectBuild()) throw new RpcError('This network signs in with the wallet key exchange', 'NOT_SUPPORTED')
      const returnTo = checkReturn(input.returnTo)
      stop()
      const id = ++flow
      const pins = appConnectPins()
      // An App Connect build without its pinned anchor and group (web: "not-configured").
      if (!pins) {
        set({ flow: id, renew: input.identityHint !== undefined, phase: 'unavailable', reason: 'not-configured' })
        return state
      }
      renewFor = input.identityHint
      const instance = new AppConnectLogin({
        pins,
        network: appConnectSessions.network(),
        port: appConnectPlatformPort,
        // Proved again before every sign-in, so a group widened since boot blocks it.
        trust: () => appConnectSessions.trust({ fresh: true }),
        connectionId: () => appConnectSessions.connectionId(),
        records: requestRecordsFor(input.identityHint),
        origin: WEB_ORIGIN,
        basePath: returnTo.webBasePath,
        callbackUrl: (hash) => appConnectReturnUrl(returnTo, hash),
        onError: (message, error) => logger.warn(message, error),
      })
      login = instance
      instance.subscribe((next) => publish(id, instance, next))
      await instance.start({ identityHint: input.identityHint, fresh: input.fresh })
      return state
    },

    /** Poll now (the app came back, or the wallet's return link). A link for another request changes nothing. */
    pollNow(requestHash?: string): boolean {
      if (!login || (requestHash !== undefined && requestHash !== login.requestHashHex())) return false
      login.pollNow()
      return true
    },

    async checkAgain(): Promise<void> {
      await login?.checkAgain()
    },

    /** "That's not me": forget every answer and the request, and show a new code. */
    async reject(): Promise<void> {
      await login?.reject()
    },

    /** Abandons the flow and forgets its request and any verified answer. */
    cancel(): void {
      login?.finish()
      reset()
    },

    /**
     * Takes the verified grant of `identityId`; the flow ends and forgets
     * everything else. The caller adopts the grant, which wipes its keys.
     */
    accept(identityId: string): AppConnectGrant | null {
      const grant = login?.accept(identityId) ?? null
      reset()
      return grant
    },

    /** Whether a sign-in request is still stored and answerable (the app was killed while the wallet was open). */
    async pending(): Promise<boolean> {
      if (!isAppConnectBuild() || !appConnectPins()) return false
      return (await requestRecordsFor(undefined).load()) !== null
    },
  }
}
