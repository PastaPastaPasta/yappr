import { create } from 'zustand'
import type { AuthUser } from '@/contexts/auth-context'
import type { ElectionStatus } from '@/lib/services/moderation-election-service'
import { moderatedContract } from '@/lib/moderated-contracts'

/** The /staging social v20 team as recorded in #963 / #1002. */
const STAGING_SOCIAL = '63JuBhMjZKyBVJzj7ubCmGEacPsa8VtvgQomMsVrd36D'
const STAGING_LEADER = 'CcgaYFrJW44g1ANN9CzG37LnS76YxWnWa1iB4Qn98uYB'
const STAGING_MEMBERS = ['31Q7gwikN11NcaTaeTDfLdeJVALajvKvAJxcnd8cACTM', 'EJ4ngg7CQ4ryovsw5Fwetprx9im1eno7GocBLiHoU8i', '8DteaK5n267ss12hdkMaEftwyWgoMBzvQRggTNDy4rPq']
const SUBMITTED_CHARTER = 'DnC4TbUgxNATMyfVABH2BA7cQxQUesYbsXDdyRBjFMjZ'
const ELECTED_CHARTER = 'AxVKwL4HAhWYtwdr7qadTtuwUJ14N9iYSczpsH8o7G7C'

// Public scalar 1 (compressed): pairs with the fixture's login WIF. Never use with an actual identity or funds.
const SCALAR_ONE_PUBLIC_KEY = Uint8Array.from(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'.match(/../g)!.map((byte) => parseInt(byte, 16))
)

const params = new URLSearchParams(window.location.search)
export const seatedTeam = params.get('seated') === '1'

function signedIn(identityId: string): AuthUser {
  return { identityId, balance: 1, publicKeys: [] }
}

interface FixtureAuth {
  user: AuthUser | null
  epoch: number
  granted: Array<{ identityId: string | null; name: string }>
}

const useFixtureAuth = create<FixtureAuth>(() => ({ user: signedIn('fixture-alice'), epoch: 1, granted: [] }))

export const fixtureAuth = {
  signOut: () => useFixtureAuth.setState((state) => ({ user: null, epoch: state.epoch + 1 })),
  switchTo: (identityId: string) => useFixtureAuth.setState((state) => ({ user: signedIn(identityId), epoch: state.epoch + 1 })),
  granted: () => useFixtureAuth.getState().granted,
}

const controller = {
  sessionEpoch: () => useFixtureAuth.getState().epoch,
  getState: () => ({ user: useFixtureAuth.getState().user }),
}

function updateDPNSUsername(name: string) {
  useFixtureAuth.setState((state) => ({
    user: state.user && { ...state.user, dpnsUsername: name },
    granted: [...state.granted, { identityId: state.user?.identityId ?? null, name }],
  }))
}

export function useAuth() {
  const user = useFixtureAuth((state) => state.user)
  return { user, controller, updateDPNSUsername }
}

export function useSdk() {
  return { isReady: true, error: null }
}

type Results = Array<{ label: string; success: boolean; isContested: boolean }>
let settleBatch: ((results: Results) => void) | null = null

/** Resolves the batch the wizard sent with `results`, as the chain would answer it. */
export function settleRegistration(results: Results): boolean {
  if (!settleBatch) return false
  settleBatch(results)
  settleBatch = null
  return true
}

export const dpnsMock = {
  getUsernameValidationError: () => null,
  clearCache: () => undefined,
  findIdentityByName: async () => undefined,
  resolveUsername: async () => null,
  registerUsernamesSequentially: () => new Promise<Results>((resolve) => { settleBatch = resolve }),
}

export const identityMock = {
  getIdentity: async () => ({ publicKeys: [{ id: 1, type: 0, purpose: 0, securityLevel: 2, data: SCALAR_ONE_PUBLIC_KEY }] }),
}

export const electionMock = {
  async getStatus(): Promise<ElectionStatus> {
    const declaration = moderatedContract('social').elected()
    if (!declaration) throw new Error('The fixture build must elect social moderators')
    return {
      targetContractId: STAGING_SOCIAL,
      declaration: { ...declaration, interim: 'notYetUsable' },
      failures: [],
      seatedReasons: [],
      electionOpensAtMs: null,
      chainTimeMs: null,
      seated: seatedTeam
        ? { leaderId: STAGING_LEADER, members: STAGING_MEMBERS, electedCharterId: ELECTED_CHARTER, submittedCharterId: SUBMITTED_CHARTER }
        : null,
      contest: null,
      proposals: [],
    }
  },
}

const pushed: string[] = []
export const router = {
  pushed,
  push: (href: string) => { pushed.push(href) },
  replace: (href: string) => { pushed.push(href) },
  back: () => undefined,
  forward: () => undefined,
  refresh: () => undefined,
  prefetch: async () => undefined,
}
export function useRouter() {
  return router
}
export function useSearchParams() {
  return new URLSearchParams(window.location.search)
}
export function usePathname() {
  return window.location.pathname
}
