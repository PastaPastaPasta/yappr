import { SupersededSignInError, clearSensitiveBytes, type AppConnectGrant, type AppConnectSession, type KeyRingLoginOptions, type PlatformAuthResult } from 'platform-auth'
import { serialQueue } from './serial-queue'

/** The parts of the auth controller a wallet sign-in drives. */
export interface WalletSignInController {
  sessionEpoch(): number
  getState(): { user: { identityId: string } | null }
  loginWithKeyRing(identityId: string, options: KeyRingLoginOptions): Promise<PlatformAuthResult>
}

/** The parts of the App Connect session manager a wallet sign-in drives. */
export interface WalletSignInSessions {
  adopt(grant: AppConnectGrant): Promise<AppConnectSession>
  discard(session: AppConnectSession): Promise<void>
  current(identityId: string): AppConnectSession | null
}

/** Overwrites every private key a grant carries. */
export function wipeGrant(grant: AppConnectGrant): void {
  for (const key of [...grant.authKeys, ...grant.encryptionKeys]) clearSensitiveBytes(key.privateKey)
}

/**
 * Wallet sign-ins and renewals for one tab, bound to the session they began
 * on (the controller's session epoch when the user accepted the grant).
 *
 * They run one at a time, since the key ring holds one grant per network.
 * Any sign-in or sign-out that lands meanwhile, including an earlier wallet
 * sign-in queued ahead, supersedes a queued one: it rejects with
 * `SupersededSignInError` before its grant can replace the ring of the
 * session that won, and wipes its keys.
 *
 * `settled` resolves once a sign-out still under way (after a wallet revoke)
 * has finished, so that one does not count against a sign-in started after it.
 */
export function createWalletSignIn({ controller, sessions, settled }: {
  controller: WalletSignInController
  sessions: WalletSignInSessions
  settled: () => Promise<void>
}) {
  const queue = serialQueue()

  /**
   * Stores the grant as this tab's key ring and signs its identity in.
   * `began`: the epoch the sign-in began on when that was before this call
   * (a passkey sign-in, before its picker); a sign-in or sign-out since then,
   * even one that settles while this waits, supersedes it.
   */
  async function signIn(grant: AppConnectGrant, began?: number): Promise<PlatformAuthResult> {
    await settled()
    const since = began ?? controller.sessionEpoch()
    return queue(async () => {
      if (controller.sessionEpoch() !== since) {
        wipeGrant(grant)
        throw new SupersededSignInError()
      }
      const session = await sessions.adopt(grant)
      try {
        return await controller.loginWithKeyRing(session.identityId, {
          since,
          stillCurrent: () => sessions.current(session.identityId) !== null,
        })
      } catch (error) {
        // The grant may be the very one a winning sign-in for this identity now uses
        // (adopt hands back the newer stored grant): only another identity's session drops it.
        if (controller.getState().user?.identityId !== session.identityId) await sessions.discard(session)
        throw error
      }
    })
  }

  /** Replaces the signed-in identity's grant with a renewed one from the same identity. */
  async function renew(grant: AppConnectGrant): Promise<void> {
    await settled()
    const since = controller.sessionEpoch()
    const stillOwner = () => controller.sessionEpoch() === since && controller.getState().user?.identityId === grant.identityId
    if (!stillOwner()) {
      wipeGrant(grant)
      throw new Error('The renewal came from another account')
    }
    await queue(async () => {
      if (!stillOwner()) {
        wipeGrant(grant)
        throw new SupersededSignInError()
      }
      const session = await sessions.adopt(grant)
      // Another session won while the grant was stored: it must not keep this ring.
      if (!stillOwner()) {
        if (controller.getState().user?.identityId !== session.identityId) await sessions.discard(session)
        throw new SupersededSignInError()
      }
    })
  }

  return { signIn, renew }
}
