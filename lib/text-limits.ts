/** JSON Schema counts code points; maxBytes counts the UTF-8 representation. */
export interface TextLimits { maxLength?: number; maxBytes?: number | null }
export const textBytes = (text: string): number => new TextEncoder().encode(text).length
export function fitsText(text: string, limits: TextLimits): boolean {
  return (limits.maxLength === undefined || [...text].length <= limits.maxLength)
    && (limits.maxBytes == null || textBytes(text) <= limits.maxBytes)
}
export function limitText(text: string, limits: TextLimits): string {
  let result = ''
  let bytes = 0
  let count = 0
  for (const char of text) {
    const size = textBytes(char)
    if ((limits.maxLength !== undefined && count >= limits.maxLength)
      || (limits.maxBytes != null && bytes + size > limits.maxBytes)) break
    result += char
    bytes += size
    count++
  }
  return result
}

/** Reject an oversized edit without deleting existing text; allow an old oversized draft to shrink. */
export function acceptsTextChange(current: string, next: string, limits: TextLimits): boolean {
  return fitsText(next, limits) || ([...next].length <= [...current].length && textBytes(next) <= textBytes(current)
    && ([...next].length < [...current].length || textBytes(next) < textBytes(current)))
}

/** Keep the old prefix and suffix; trim only newly inserted code points. */
export function fitTextChange(current: string, next: string, fits: (value: string) => boolean): string {
  if (fits(next)) return next
  if (!fits(current)) {
    return [...next].length <= [...current].length && textBytes(next) <= textBytes(current)
      && ([...next].length < [...current].length || textBytes(next) < textBytes(current)) ? next : current
  }
  const before = [...current]
  const after = [...next]
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let end = 0
  while (end < before.length - start && end < after.length - start
    && before[before.length - 1 - end] === after[after.length - 1 - end]) end++
  const prefix = after.slice(0, start).join('')
  const suffix = end ? after.slice(-end).join('') : ''
  const inserted = after.slice(start, after.length - end)
  let low = 0
  let high = inserted.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (fits(prefix + inserted.slice(0, mid).join('') + suffix)) low = mid
    else high = mid - 1
  }
  return prefix + inserted.slice(0, low).join('') + suffix
}
