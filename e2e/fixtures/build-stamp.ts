import type { APIRequestContext } from '@playwright/test'
import { appUrl } from './app'

/**
 * The Next.js build id is embedded in the RSC flight payload inside every
 * exported page, with the quotes escaped. next.config.js sets it from
 * `git rev-parse --short HEAD` — the same source as
 * `NEXT_PUBLIC_GIT_COMMIT_HASH`, which the settings page renders.
 */
const BUILD_ID_PATTERN = /\\?"buildId\\?":\\?"([^"\\]+)/

export async function readBuildId(request: APIRequestContext): Promise<string | undefined> {
  const response = await request.get(appUrl('/'))
  if (!response.ok()) return undefined
  return (await response.text()).match(BUILD_ID_PATTERN)?.[1]
}
