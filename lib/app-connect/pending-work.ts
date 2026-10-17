/**
 * Counts operations still under way. Each `start()` returns its own release,
 * which counts once however often it is called, so an operation that ends
 * early never releases one still running beside it.
 */
export function pendingWork(): { start: () => () => void; readonly busy: boolean } {
  let running = 0
  return {
    start() {
      running += 1
      let released = false
      return () => {
        if (released) return
        released = true
        running -= 1
      }
    },
    get busy() {
      return running > 0
    },
  }
}
