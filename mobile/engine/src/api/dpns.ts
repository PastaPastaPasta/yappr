import { hasAppConnectSession } from '@/lib/auth/signing-keys'
import { keyNetwork } from '@/lib/constants'
import { KeyPurpose, SecurityLevel } from '@/lib/crypto/identity-keys'
import { matchIdentityKey } from '@/lib/crypto/keys'
import { getPrivateKey } from '@/lib/secure-storage'
import { BalanceTooLowError, ContestFundChangedError, creditsNeeded } from '@/lib/dpns/registration-quote'
import { DpnsNameTakenError, DpnsNotSentError } from '@/lib/services/dpns-registration'
import { dpnsService } from '@/lib/services/dpns-service'
import { getEvoSdk } from '@/lib/services/evo-sdk-service'
import { identityService } from '@/lib/services/identity-service'
import { readFailure, requireViewer, viewerId } from '../dto/hydrate'
import { RpcError } from '../protocol/envelope'
import { relationProbe, signer } from '../writes/handler-kit'
import { NotSentError, type TicketStore } from '../writes/tickets'
import type { WriteTicket } from '../writes/types'
import type { DpnsAvailabilityDTO } from './dto'

interface RegisterArgs {
  label: string
  /** The vote deposit the user approved for a contested name, in credits (a decimal string: args persist as JSON). */
  contestFund?: string
}

/** How this account registers a username: here, signed with its own key, or in its Dash wallet. */
export type DpnsRegistrationDTO = 'native' | 'wallet'

const walletRefusal = () => new RpcError('Register usernames in your Dash wallet.', 'NOT_SUPPORTED')

const normalize = (label: string) => String(label).trim().toLowerCase().replace(/^@/, '').replace(/\.dash$/, '')

/**
 * DPNS registration (web's `/dpns/register` wizard). Only an unbound CRITICAL
 * or HIGH authentication key may sign it: a wallet sign-in's keys are bound
 * to Yappr's contracts, so that account registers in its wallet instead, as
 * web's `WalletUsernameGuide` says.
 */
export function createDpnsModule(
  tickets: TicketStore,
  controller: { refreshUsername(): Promise<void> },
  /** `secureDurable`: the registration journal (salt, signed steps) lives in secure storage, written through asynchronously. */
  options: { secureDurable?: () => Promise<void> } = {},
) {
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

  /** Whether `label` is free, and for a contested one the deposit its vote takes now (as `identityId` would register it). */
  async function availability(label: string, identityId: string): Promise<DpnsAvailabilityDTO> {
    const invalid = (problem: string): DpnsAvailabilityDTO => ({ label, available: false, contested: false, contestFundCredits: null, invalid: problem })
    const problem = dpnsService.getUsernameValidationError(label)
    if (problem) return invalid(problem)
    try {
      const sdk = await getEvoSdk()
      if (!(await sdk.dpns.isValidUsername(label))) return invalid('That username is not valid')
      const [available, contested] = await Promise.all([sdk.dpns.isNameAvailable(label), sdk.dpns.isContestedUsername(label)])
      const fund = available && contested ? (await dpnsService.quoteName(label, identityId)).contestFund : null
      return { label, available, contested, contestFundCredits: fund?.credits ?? null, invalid: null }
    } catch (error) {
      // Never "taken": a read that failed says nothing about the name.
      throw readFailure(error)
    }
  }

  /** Why `label` can't be registered by this account now (an engine-coded refusal), or null. Rejects when a read fails. */
  async function preflight(identityId: string, label: string): Promise<RpcError | null> {
    if (await registration(identityId) !== 'native') return walletRefusal()
    const check = await availability(label, identityId)
    if (check.invalid) return new RpcError(check.invalid, 'BAD_REQUEST')
    if (!check.available) {
      // Taken by this account already (a registration whose answer was lost): the run says so.
      dpnsService.clearCache(label)
      if ((await dpnsService.findIdentityByName(label)) === identityId) return null
      return new RpcError(`${label} is already taken.`, 'BAD_REQUEST')
    }
    // The deposit and the fees still to pay (a preorder this device already sent is not paid again).
    const quote = await dpnsService.quoteName(label, identityId)
    const identity = await identityService.getIdentity(identityId, { fresh: true })
    if (!identity) throw new Error('The identity could not be read')
    return BigInt(identity.balance) < creditsNeeded(quote)
      ? new RpcError('Your balance is too low for this username. Pick a name of 20 or more characters, or one with a digit from 2 to 9.', 'BAD_REQUEST')
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
    async run({ label, contestFund }, ctx) {
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
        // A step already sent for this name (an earlier attempt, before a restart) is settled and
        // reused, never paid again; one still unsettled leaves the ticket unconfirmed.
        const outcome = await dpnsService.registerUsername(label, identityId, privateKey, {
          contestFund: contestFund ? BigInt(contestFund) : null,
          durable: options.secureDurable,
        })
        return { state: outcome.state === 'pending' ? 'unconfirmed' : 'confirmed' }
      } catch (error) {
        if (error instanceof DpnsNotSentError) {
          // A deposit that changed since the user saw it, or a balance short of it: nothing sent, and
          // the host shows the sentence (the name's check runs again, with the new amount).
          if (error.cause instanceof ContestFundChangedError || error.cause instanceof BalanceTooLowError) {
            return { state: 'failed', error: new RpcError(error.cause.message, 'BAD_REQUEST') }
          }
          if (error.cause instanceof DpnsNameTakenError) return { state: 'failed', error: new RpcError(`${label} is already taken.`, 'BAD_REQUEST') }
          // Otherwise lib stopped before anything of this attempt was sent (failed, may retry).
          throw new NotSentError(error.cause)
        }
        return { state: 'failed', error }
      }
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
      return availability(normalize(label), requireViewer('Checking a username'))
    },

    /**
     * Register `label`. `contestFundCredits` is the vote deposit the host showed for a contested name
     * (`check`'s `contestFundCredits`): the most it pays, and nothing is signed when it changed.
     */
    async register(label: string, contestFundCredits: bigint | null = null): Promise<WriteTicket> {
      const identityId = requireViewer('Registering a username')
      const normalized = normalize(label)
      if (!normalized) throw new RpcError('Enter a username', 'BAD_REQUEST')
      const args: RegisterArgs = contestFundCredits === null ? { label: normalized } : { label: normalized, contestFund: contestFundCredits.toString() }
      return tickets.submit<RegisterArgs>({ op: 'dpns.register', args, target: { identityId } })
    },

    /** Read the account's usernames again (one registered in the wallet); the session reports a change. */
    async refreshUsernames(): Promise<void> {
      requireViewer('Usernames')
      await controller.refreshUsername()
    },
  }
}
