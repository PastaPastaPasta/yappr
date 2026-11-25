import type { APIRequestContext } from '@playwright/test'
import { appUrl } from './app'

/**
 * app/layout.tsx embeds `{"buildId":"…"}` in every exported page (the
 * `yappr-build` JSON script). next.config.js sets the build id from
 * `git rev-parse --short HEAD`, the same source as
 * `NEXT_PUBLIC_GIT_COMMIT_HASH`, which the settings page renders.
 */
const BUILD_ID_PATTERN = /\\?"buildId\\?":\\?"([^"\\]+)/

export async function readBuildId(request: APIRequestContext): Promise<string | undefined> {
  const response = await request.get(appUrl('/'))
  if (!response.ok()) return undefined
  return (await response.text()).match(BUILD_ID_PATTERN)?.[1]
}
