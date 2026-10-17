/**
 * A queue that runs tasks one at a time, each after the previous one has
 * settled; a task that fails does not stop the next. The tab's wallet grant
 * adoptions go through one, since the key ring holds one grant per network.
 */
export function serialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.then(task, task)
    tail = next.catch(() => undefined)
    return next
  }
}
