import { join } from 'node:path'

/**
 * The contract IDs the `/testing` build is supposed to be pointed at.
 *
 * `lib/constants.ts` falls back to the PRODUCTION contract IDs whenever the
 * `NEXT_PUBLIC_*_CONTRACT_ID` env vars are absent, and `playwright.config.ts`
 * deliberately does not build — it only serves whatever is already in `out/`.
 * So a plain `npm run build` (instead of `npm run build:testing`) produces an
 * artifact that looks identical but writes to production. The write specs gate
 * on this before signing anything.
 */
export async function expectedSocialContractId(): Promise<string> {
  const { readEnvFile, REPO_ROOT } = await import('../../scripts/derive-identities.mjs')
  const values = readEnvFile(join(REPO_ROOT, '.env.testing')) as Record<string, string | undefined>

  return process.env.NEXT_PUBLIC_YAPPR_CONTRACT_ID ?? values.NEXT_PUBLIC_YAPPR_CONTRACT_ID ?? ''
}
