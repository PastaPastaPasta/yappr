/** A complete key list and the hydrated items of its first `loaded` keys. */
export interface HydratedPages<K, V> {
  keys: K[]
  /** How many keys, from the start, have been hydrated. */
  loaded: number
  /** The hydrated items, in key order; hydration may drop keys (deleted posts). */
  items: V[]
}

/**
 * `pages` without the keys `keepKey` rejects and the items `keepItem`
 * rejects, with `loaded` still counting only hydrated keys, so the next page
 * starts where it should.
 */
export function dropFromPages<K, V>(
  pages: HydratedPages<K, V>,
  keepKey: (key: K) => boolean,
  keepItem: (item: V) => boolean
): HydratedPages<K, V> {
  return {
    keys: pages.keys.filter(keepKey),
    loaded: pages.keys.slice(0, pages.loaded).filter(keepKey).length,
    items: pages.items.filter(keepItem),
  }
}

/**
 * `pages` with the hydrated `slice` appended. `loaded` moves to just past the
 * slice's last key still in the list, so keys dropped while the slice was
 * hydrating (`dropFromPages`) neither skip a key nor overrun the list.
 */
export function appendPage<K, V>(pages: HydratedPages<K, V>, slice: readonly K[], items: readonly V[]): HydratedPages<K, V> {
  const inSlice = new Set(slice)
  let end = pages.loaded
  pages.keys.forEach((key, index) => {
    if (inSlice.has(key)) end = Math.max(end, index + 1)
  })
  return { ...pages, loaded: end, items: [...pages.items, ...items] }
}
