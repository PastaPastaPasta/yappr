import { YAPPR_CONTRACT_ID, YAPPR_PROFILE_CONTRACT_ID, getConfiguredNetwork } from '@/lib/constants'
import { evoSdkService } from '@/lib/services/evo-sdk-service'
import { queryDocuments } from '@/lib/services/sdk-helpers'

/**
 * The profile gate: a signed-in user without a profile document is sent to
 * /profile/create from every route that is not built to host them.
 *
 * The platform-auth controller applies this only on the interactive login path
 * (its `profile-required` intent). `restoreSession()` never consults it and
 * nothing re-runs it on client-side navigation, so `AuthProvider` evaluates the
 * gate whenever the signed-in user or the route changes.
 */

/**
 * Routes that intentionally host a signed-in user with no profile yet, plus the
 * embed route, which renders inside other sites' iframes and must never
 * navigate. `usePathname()` excludes the `basePath`, so these match exactly.
 */
const PROFILE_OPTIONAL_ROUTES = ['/profile/create', '/dpns/register', '/login', '/welcome', '/embed']

export function isProfileOptionalRoute(pathname: string): boolean {
  const normalized = pathname.replace(/\/+$/, '') || '/'
  return PROFILE_OPTIONAL_ROUTES.includes(normalized)
}

async function ownsProfileDocument(dataContractId: string, identityId: string): Promise<boolean> {
  // The gate can run before SdkProvider has configured the SDK.
  await evoSdkService.initialize({ network: getConfiguredNetwork(), contractId: YAPPR_CONTRACT_ID })
  const sdk = await evoSdkService.getSdk()
  const documents = await queryDocuments(sdk, {
    dataContractId,
    documentTypeName: 'profile',
    where: [['$ownerId', '==', identityId]],
    limit: 1,
  })
  return documents.length > 0
}

/**
 * Whether `identityId` owns a unified profile or a legacy one. Unlike the
 * profile services, which turn a failed query into `null`, this rejects when a
 * query fails, so `false` always means both queries succeeded and found nothing.
 */
export async function hasYapprProfile(identityId: string): Promise<boolean> {
  if (await ownsProfileDocument(YAPPR_PROFILE_CONTRACT_ID, identityId)) return true
  return ownsProfileDocument(YAPPR_CONTRACT_ID, identityId)
}

export interface ProfileGateInput {
  identityId: string
  username?: string
  /** The user chose to continue without a username (`yappr_skip_dpns`). */
  skippedUsername: boolean
  pathname: string
}

export interface ProfileGate {
  /** Record a profile the app just created or found, before it is query-visible. */
  rememberProfile(identityId: string): void
  /**
   * Resolves `true` when the user must be sent to /profile/create. Rejects when
   * the lookup fails: the caller must then leave the user where they are.
   */
  shouldRedirect(input: ProfileGateInput): Promise<boolean>
}

/**
 * `lookup` must reject when it cannot tell, rather than report absence, so an
 * outage never redirects a user who has a profile.
 *
 * A profile, once seen, is remembered per identity for the gate's lifetime.
 * Absence is not: every later check asks the network again, which is what lets
 * a user through as soon as their new profile is visible.
 */
export function createProfileGate(lookup: (identityId: string) => Promise<boolean>): ProfileGate {
  const knownProfiles = new Set<string>()

  return {
    rememberProfile(identityId) {
      knownProfiles.add(identityId)
    },
    async shouldRedirect({ identityId, username, skippedUsername, pathname }) {
      // The username gate comes first, as in the controller. `withAuth` sends a
      // user with neither a username nor a skip to /dpns/register: yield to it.
      if (!username && !skippedUsername) return false
      if (isProfileOptionalRoute(pathname)) return false
      if (knownProfiles.has(identityId)) return false

      if (!(await lookup(identityId))) return true
      knownProfiles.add(identityId)
      return false
    },
  }
}
