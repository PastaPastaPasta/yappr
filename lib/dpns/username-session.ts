/**
 * What a DPNS registration does to the session's username, and whether a
 * page sends the user to username setup. Pure, with storage passed in
 * (scripts/contest-deposit.test.mjs). A contested name that succeeds has only
 * joined its vote: it is never the session's username. A user with none that
 * gets such a name goes on without one, as "Skip for now" does, from the
 * moment it succeeds, whatever the wizard shows afterwards.
 */
type RegistrationResult = { label: string; success: boolean; isContested: boolean }

/**
 * The name a registration batch grants the user now: the first non-contested
 * success. A contested one has only joined its vote, so it never becomes the
 * session's username (nor replaces one the user owns); null leaves it as is.
 */
export function grantedUsername(results: ReadonlyArray<RegistrationResult>): string | null {
  return results.find((result) => result.success && !result.isContested)?.label ?? null
}

/**
 * Record a batch's outcome: returns the name it grants (to save as the
 * session's username), and sets the skip marker under `skipKey` when it only
 * joined votes for a user with no username.
 */
export function recordRegistration(
  results: ReadonlyArray<RegistrationResult>,
  currentUsername: string | null | undefined,
  store: Pick<Storage, 'setItem'>,
  skipKey: string
): string | null {
  const granted = grantedUsername(results)
  if (!granted && !currentUsername && results.some((result) => result.success && result.isContested)) {
    store.setItem(skipKey, 'true')
  }
  return granted
}

/** Whether a page guarded by `withAuth` sends this user to username setup. */
export function needsUsernameSetup(
  user: { dpnsUsername?: string | null } | null | undefined,
  options: { allowWithoutDPNS?: boolean; optional?: boolean } | undefined,
  store: Pick<Storage, 'getItem'> | null,
  skipKey: string
): boolean {
  if (!user || options?.optional || options?.allowWithoutDPNS || user.dpnsUsername) return false
  return store?.getItem(skipKey) !== 'true'
}
