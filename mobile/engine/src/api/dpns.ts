import { hasAppConnectSession } from '@/lib/auth/signing-keys'
import { keyNetwork } from '@/lib/constants'
import { KeyPurpose, SecurityLevel } from '@/lib/crypto/identity-keys'
import { matchIdentityKey } from '@/lib/crypto/keys'
import { getPrivateKey } from '@/lib/secure-storage'
import { DpnsNotSentError, dpnsService, minimumContestFundCredits } from '@/lib/services/dpns-service'
import { getEvoSdk } from '@/lib/services/evo-sdk-service'
import { identityService } from '@/lib/services/identity-service'
import { readFailure, requireViewer, viewerId } from '../dto/hydrate'
import { RpcError } from '../protocol/envelope'
import { relationProbe, signer } from '../writes/handler-kit'
import { NotSentError, type TicketStore } from '../writes/tickets'
import type { WriteTicket } from '../writes/types'
import type { DpnsAvailabilityDTO } from './dto'

interface RegisterArgs { label: string }

/** How this account registers a username: here, signed with its own key, or in its Dash wallet. */
export type DpnsRegistrationDTO = 'native' | 'wallet'

const walletRefusal = () => new RpcError('Register usernames in your Dash wallet.', 'NOT_SUPPORTED')

const normalize = (label: string) => String(label).trim().toLowerCase().replace(/^@/, '').replace(/\.dash$/, '')

/** The fund a contested name pays into its masternode vote, at the network's protocol version. */
async function contestFund(): Promise<bigint> {
  const sdk = await getEvoSdk()
  const version = await sdk.epoch.current().then(epoch => epoch.protocolVersion, () => null)
  return minimumContestFundCredits(version)
}

/**
 * DPNS registration (web's `/dpns/register` wizard). Only an unbound CRITICAL
 * or HIGH authentication key may sign it: a wallet sign-in's keys are bound
 * to Yappr's contracts, so that account registers in its wallet instead, as
 * web's `WalletUsernameGuide` says.
 */
export function createDpnsModule(tickets: TicketStore, controller: { refreshUsername(): Promise<void> }) {
  async function registration(identityId: string): Promise<DpnsRegistrationDTO> {
    if (hasAppConnectSession(identityId)) return 'wallet'
    const wif = getPrivateKey(identityId)
    if (!wif) return 'wallet'
    let identity
    try {
      identity = await identityService.getIdentity(identityId)
    } catch (error) {
      throw readFailure(error)
    }
    if (!identity) throw new RpcError('The identity was not found', 'IDENTITY_NOT_FOUND')
    const match = matchIdentityKey(wif, identity.publicKeys, {
      network: keyNetwork(),
      purpose: KeyPurpose.AUTHENTICATION,
      allowedSecurityLevels: [SecurityLevel.CRITICAL, SecurityLevel.HIGH],
    })
    return match.ok && !match.key.contractBounds ? 'native' : 'wallet'
  }

  async function availability(label: string): Promise<DpnsAvailabilityDTO> {
    const invalid = (problem: string): DpnsAvailabilityDTO => ({ label, available: false, contested: false, contestFundCredits: null, invalid: problem })
    const problem = dpnsService.getUsernameValidationError(label)
    if (problem) return invalid(problem)
    try {
      const sdk = await getEvoSdk()
      if (!(await sdk.dpns.isValidUsername(label))) return invalid('That username is not valid')
      const [available, contested] = await Promise.all([sdk.dpns.isNameAvailable(label), sdk.dpns.isContestedUsername(label)])
      return { label, available, contested, contestFundCredits: contested ? await contestFund() : null, invalid: null }
    } catch (error) {
      // Never "taken": a read that failed says nothing about the name.
      throw readFailure(error)
    }
  }

  /** Why `label` can't be registered by this account now (an engine-coded refusal), or null. Rejects when a read fails. */
  async function preflight(identityId: string, label: string): Promise<RpcError | null> {
    if (await registration(identityId) !== 'native') return walletRefusal()
    const check = await availability(label)
    if (check.invalid) return new RpcError(check.invalid, 'BAD_REQUEST')
    if (!check.available) return new RpcError(`${label} is already taken.`, 'BAD_REQUEST')
    if (check.contestFundCredits === null) return null
    const identity = await identityService.getIdentity(identityId, { fresh: true })
    if (!identity) throw new Error('The identity could not be read')
    return BigInt(identity.balance) < check.contestFundCredits
      ? new RpcError('Your balance is too low for a contested name. Pick a name of 20 or more characters, or one with a digit from 2 to 9.', 'BAD_REQUEST')
      : null
  }

  // A registration confirmed by its call or by a later check: the session reads its names again
  // (and reports the new one), as long as that account is still the one signed in.
  tickets.observe(ticket => {
    if (ticket.op === 'dpns.register' && ticket.state === 'confirmed' && ticket.identityId && ticket.identityId === viewerId()) {
      controller.refreshUsername().catch(() => undefined)
    }
  })

  tickets.register<RegisterArgs>('dpns.register', {
    persistArgs: true,
    async run({ label }, ctx) {
      const identityId = signer(ctx)
      // Refusals before anything is sent carry an engine code, so the host shows them; a read that
      // failed then sent nothing (failed, not "may have landed").
      const refusal = await preflight(identityId, label).catch((error: unknown) => {
        throw new NotSentError(readFailure(error))
      })
      if (refusal) return { state: 'failed', error: refusal }
      const privateKey = getPrivateKey(identityId)
      if (!privateKey) return { state: 'failed', error: walletRefusal() }
      try {
        await dpnsService.registerUsername(label, identityId, privateKey)
      } catch (error) {
        // lib failed before it asked the SDK to register: nothing was sent or paid (failed, may retry).
        if (error instanceof DpnsNotSentError) throw new NotSentError(error.cause)
        return { state: 'failed', error }
      }
      return { state: 'confirmed' }
    },
    probe: async (ticket, args, kit) => {
      if (!args) return { state: 'unknown', error: new Error('The username is not known') }
      try {
        dpnsService.clearCache(args.label)
        if ((await dpnsService.findIdentityByName(args.label)) === ticket.identityId) return { state: 'applied' }
        // A contested name joins a vote and has no domain until it is awarded: its absence proves
        // nothing, and a retry would pay a second preorder. Never offer one.
        if (await (await getEvoSdk()).dpns.isContestedUsername(args.label)) {
          return { state: 'unknown', error: new Error('A contested name is decided by its vote') }
        }
      } catch (error) {
        return { state: 'unknown', error }
      }
      return relationProbe<RegisterArgs>(async ({ viewer }) => (await dpnsService.findIdentityByName(args.label)) === viewer, true)(ticket, args, kit)
    },
  })

  return {
    /** How the signed-in account registers a username (`native` here, `wallet` in its Dash wallet). */
    async registration(): Promise<DpnsRegistrationDTO> {
      return registration(requireViewer('Registering a username'))
    },

    /** Whether `label` is a valid, free DPNS name, and whether it goes to a masternode vote. Rejects when unreadable. */
    async check(label: string): Promise<DpnsAvailabilityDTO> {
      return availability(normalize(label))
    },

    async register(label: string): Promise<WriteTicket> {
      const identityId = requireViewer('Registering a username')
      const normalized = normalize(label)
      if (!normalized) throw new RpcError('Enter a username', 'BAD_REQUEST')
      return tickets.submit<RegisterArgs>({ op: 'dpns.register', args: { label: normalized }, target: { identityId } })
    },

    /** Read the account's usernames again (one registered in the wallet); the session reports a change. */
    async refreshUsernames(): Promise<void> {
      requireViewer('Usernames')
      await controller.refreshUsername()
    },
  }
}
