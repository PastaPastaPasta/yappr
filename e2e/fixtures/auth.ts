/**
 * Programmatic login for the write specs.
 *
 * The app restores a session purely from browser storage (see
 * `vendor/platform-auth/src/core/controller.ts` → `restoreSession`), so there is
 * no need to drive the login modal: seeding two localStorage keys before the
 * first navigation is enough, and it keeps every test's credits budget for the
 * writes we actually want to exercise.
 *
 * Key material is derived from `E2E_SEED_PHRASE` via `scripts/derive-identities.mjs`
 * — the same derivation the provisioning scripts used, so the WIFs match the
 * public keys registered on the bot identities. Nothing here ever logs a WIF.
 */
import { test as base, expect } from '@playwright/test'
import { scopedKey } from './app'

export type BotIdentity = {
  /** Index into the provisioned pool (already wrapped into range). */
  index: number
  identityId: string
  /** AUTHENTICATION/HIGH WIF — writes require AUTHENTICATION at CRITICAL or HIGH. */
  wif: string
}

/** `write` specs self-skip when the seed is absent (fork PRs, contributors without the secret). */
export const hasSeedPhrase = Boolean(process.env.E2E_SEED_PHRASE?.trim())

export const NO_SEED_REASON =
  'E2E_SEED_PHRASE is not set — skipping the write path (no bot identity to sign state transitions with)'

/** `KEY_ROLES[2]` in scripts/derive-identities.mjs is AUTHENTICATION/HIGH. */
const AUTH_HIGH_KEY_INDEX = 2

type DeriveModule = {
  deriveIdentityKeys: (index: number) => Array<{ keyIndex: number; wif: string }>
  loadIdentityIds: () => string[]
}

let cachedIdentity: BotIdentity | undefined

/**
 * Picks the bot identity for this run: `E2E_IDENTITY_INDEX` modulo the number of
 * identities that are actually provisioned. The pool in `.env.testing` is
 * currently smaller than the index CI may hand us, so the wrap is load-bearing.
 */
export async function resolveBotIdentity(): Promise<BotIdentity> {
  if (cachedIdentity) return cachedIdentity

  const { deriveIdentityKeys, loadIdentityIds } = (await import(
    '../../scripts/derive-identities.mjs'
  )) as DeriveModule

  const pool = loadIdentityIds()
  if (pool.length === 0) {
    throw new Error('E2E_IDENTITY_IDS is empty — no bot identities are provisioned in .env.testing')
  }

  const requested = Number(process.env.E2E_IDENTITY_INDEX ?? 0)
  const index = (Number.isFinite(requested) ? Math.abs(Math.trunc(requested)) : 0) % pool.length

  const key = deriveIdentityKeys(index).find((k) => k.keyIndex === AUTH_HIGH_KEY_INDEX)
  if (!key) throw new Error(`Derivation produced no AUTHENTICATION/HIGH key for identity ${index}`)

  cachedIdentity = { index, identityId: pool[index], wif: key.wif }
  return cachedIdentity
}

export const test = base.extend<{ bot: BotIdentity }>({
  bot: async ({}, use) => {
    await use(await resolveBotIdentity())
  },

  context: async ({ context, bot }, use) => {
    // Runs before any page script on every navigation, so the private key stays
    // seeded for the whole run — if it ever went missing mid-session the app
    // would drop the session and pop the login modal.
    await context.addInitScript(
      ({ sessionKey, privateKeyKey, skipDpnsKey, identityId, wif }) => {
        if (!window.localStorage.getItem(sessionKey)) {
          window.localStorage.setItem(
            sessionKey,
            JSON.stringify({
              user: { identityId, balance: 0, publicKeys: [] },
              timestamp: Date.now(),
            })
          )
        }
        // The secure store JSON-encodes its values, so the WIF is double-quoted.
        window.localStorage.setItem(privateKeyKey, JSON.stringify(wif))
        // The bots own DPNS names, so this is belt-and-braces against the
        // `withAuth` DPNS gate redirecting to /dpns/register mid-test.
        window.sessionStorage.setItem(skipDpnsKey, 'true')
      },
      {
        sessionKey: scopedKey('yappr_session'),
        privateKeyKey: scopedKey(`yappr_secure_pk_${bot.identityId}`),
        skipDpnsKey: scopedKey('yappr_skip_dpns'),
        identityId: bot.identityId,
        wif: bot.wif,
      }
    )

    await use(context)
  },
})

export { expect }
