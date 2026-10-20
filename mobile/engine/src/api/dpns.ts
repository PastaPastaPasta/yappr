import { hasAppConnectSession } from '@/lib/auth/signing-keys'
import { keyNetwork } from '@/lib/constants'
import { KeyPurpose, SecurityLevel } from '@/lib/crypto/identity-keys'
import { matchIdentityKey } from '@/lib/crypto/keys'
import { getPrivateKey } from '@/lib/secure-storage'
import { dpnsService, minimumContestFundCredits } from '@/lib/services/dpns-service'
import { getEvoSdk } from '@/lib/services/evo-sdk-service'
import { identityService } from '@/lib/services/identity-service'
import { readFailure, requireViewer } from '../dto/hydrate'
import { RpcError } from '../protocol/envelope'
import { relationProbe, signer } from '../writes/handler-kit'
import type { TicketStore } from '../writes/tickets'
import type { WriteTicket } from '../writes/types'
import type { DpnsAvailabilityDTO } from './dto'

interface RegisterArgs { label: string }

/** How this account registers a username: here, signed with its own key, or in its Dash wallet. */
export type DpnsRegistrationDTO = 'native' | 'wallet'

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

  tickets.register<RegisterArgs>('dpns.register', {
    persistArgs: true,
    async run({ label }, ctx) {
      const identityId = signer(ctx)
      // Refusals before anything is sent carry an engine code, so the host shows them.
      const privateKey = getPrivateKey(identityId)
      if (!privateKey || await registration(identityId) !== 'native') {
        return { state: 'failed', error: new RpcError('Register usernames in your Dash wallet.', 'NOT_SUPPORTED') }
      }
      const check = await availability(label)
      if (check.invalid) return { state: 'failed', error: new RpcError(check.invalid, 'BAD_REQUEST') }
      if (!check.available) return { state: 'failed', error: new RpcError(`${label} is already taken.`, 'BAD_REQUEST') }
      if (check.contestFundCredits !== null) {
        const balance = BigInt((await identityService.getIdentity(identityId, { fresh: true }))?.balance ?? 0)
        if (balance < check.contestFundCredits) {
          return { state: 'failed', error: new RpcError('Your balance is too low for a contested name. Pick a name of 20 or more characters, or one with a digit from 2 to 9.', 'BAD_REQUEST') }
        }
      }
      try {
        await dpnsService.registerUsername(label, identityId, privateKey)
      } catch (error) {
        return { state: 'failed', error }
      }
      await controller.refreshUsername().catch(() => undefined)
      return { state: 'confirmed' }
    },
    probe: relationProbe<RegisterArgs>(async ({ viewer, args }) => {
      if (!args) throw new Error('The username is not known')
      dpnsService.clearCache(args.label)
      return (await dpnsService.findIdentityByName(args.label)) === viewer
    }, true),
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
