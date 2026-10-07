import { logger } from '@/lib/logger'

/** How often a closed gate rereads the team: the moderation service caches it for as long. */
export const MODERATED_TYPE_RECHECK_MS = 60_000

/**
 * Watch whether a moderated document type can be written, for as long as a
 * screen that writes it is shown. `read` answers it (false while a
 * `notYetUsable` contract has no seated team); `onChange` gets every answer.
 * The gate reads once at once, again every `intervalMs` while it is closed
 * (the first team may be seated at any time), and again on `focus` or
 * `visibilitychange` (to visible) from any of `targets` (the window and the
 * document). A read that fails changes nothing, and a closed gate keeps
 * polling through it. Returns the function that stops it.
 */
export function watchModeratedTypeOpen(
  read: () => Promise<boolean>,
  onChange: (open: boolean) => void,
  { intervalMs = MODERATED_TYPE_RECHECK_MS, targets = [] }: { intervalMs?: number; targets?: readonly EventTarget[] } = {}
): () => void {
  let stopped = false
  let reading = false
  let lastOpen: boolean | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const check = () => {
    if (stopped || reading) return
    if (timer) clearTimeout(timer)
    timer = null
    reading = true
    read().then((open) => {
      if (stopped) return
      lastOpen = open
      onChange(open)
      if (!open) timer = setTimeout(check, intervalMs)
    }).catch((error: unknown) => {
      logger.warn('watchModeratedTypeOpen: could not read the moderation team', error)
      if (!stopped && lastOpen === false) timer = setTimeout(check, intervalMs)
    }).finally(() => {
      reading = false
    })
  }
  const onVisible = () => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') check()
  }

  check()
  for (const target of targets) {
    target.addEventListener('focus', check)
    target.addEventListener('visibilitychange', onVisible)
  }
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    for (const target of targets) {
      target.removeEventListener('focus', check)
      target.removeEventListener('visibilitychange', onVisible)
    }
  }
}
