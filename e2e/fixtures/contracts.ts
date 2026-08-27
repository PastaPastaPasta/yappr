import { join } from 'node:path'

/**
 * What the build under test is supposed to be pointed at.
 *
 * `lib/constants.ts` falls back to the PRODUCTION contract IDs whenever the
 * `NEXT_PUBLIC_*_CONTRACT_ID` env vars are absent, and `playwright.config.ts`
 * deliberately does not build — it only serves whatever is already in `out/`.
 * So a plain `npm run build` (instead of `npm run build:testing`) produces an
 * artifact that looks identical but writes to production. The write specs gate
 * on this before signing anything.
 *
 * `E2E_ENV_FILE` selects which deployment's env file to compare against, so the
 * same gate covers `/testing` on testnet and `/devnet` on moutai:
 *
 *   npm run build:devnet
 *   E2E_BASE_PATH=/devnet E2E_ENV_FILE=.env.devnet npx playwright test
 */
const DEFAULT_ENV_FILE = '.env.testing'

async function envValues(): Promise<Record<string, string | undefined>> {
  const { readEnvFile, REPO_ROOT } = await import('../../scripts/derive-identities.mjs')
  const file = process.env.E2E_ENV_FILE?.trim() || DEFAULT_ENV_FILE
  return readEnvFile(join(REPO_ROOT, file)) as Record<string, string | undefined>
}

export async function expectedSocialContractId(): Promise<string> {
  const values = await envValues()
  return process.env.NEXT_PUBLIC_YAPPR_CONTRACT_ID ?? values.NEXT_PUBLIC_YAPPR_CONTRACT_ID ?? ''
}

/**
 * The interaction topology the build is supposed to have been compiled with.
 *
 * A contract id alone does not prove the client will talk to it correctly: the v2
 * and v3 topologies name different doctypes and fields, so a v2 bundle pointed at
 * the v3 contract queries things that do not exist — and fails in ways that look
 * like flaky reads rather than a misconfigured build. `/about` prints the
 * compiled-in value, which is what the specs assert.
 *
 * Defaults to `v2`, matching `DEFAULT_CONTRACT_TOPOLOGY` in `lib/constants.ts`.
 */
export async function expectedTopology(): Promise<string> {
  const values = await envValues()
  return process.env.NEXT_PUBLIC_CONTRACT_TOPOLOGY ?? values.NEXT_PUBLIC_CONTRACT_TOPOLOGY ?? 'v2'
}
