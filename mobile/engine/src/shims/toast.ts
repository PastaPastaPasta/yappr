/**
 * `react-hot-toast` for the engine (aliased in build.mjs and vitest.config.ts):
 * lib's toasts (lib/compose/publish-thread.ts) become `engine.notice` events,
 * and the host shows them natively. The engine renders nothing.
 */

export interface EngineNotice {
  level: 'info' | 'error'
  message: string
}

let sink: ((notice: EngineNotice) => void) | null = null
let counter = 0

/** Where notices go; the API wires this to `engine.notice`. */
export function setNoticeSink(next: ((notice: EngineNotice) => void) | null): void {
  sink = next
}

function notify(level: EngineNotice['level'], message: unknown): string {
  // Only plain strings cross: a JSX message has nothing the host could show.
  if (typeof message === 'string') sink?.({ level, message })
  counter += 1
  return `engine-notice-${counter}`
}

const info = (message: unknown) => notify('info', message)

/**
 * lib calls only `toast()`, `.success` and `.error` today. The rest of
 * react-hot-toast's surface is kept so a future lib call (`toast.loading`,
 * `toast.dismiss`, ...) degrades to a notice or a no-op instead of throwing
 * inside a write.
 */
const toast = Object.assign(info, {
  success: info,
  error: (message: unknown) => notify('error', message),
  loading: info,
  custom: info,
  dismiss: (): void => undefined,
  remove: (): void => undefined,
})

export { toast }
export default toast
