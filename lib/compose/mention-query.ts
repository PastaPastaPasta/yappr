/** The @mention currently being typed, bounded by the textarea cursor. */
export function detectActiveMention(
  content: string,
  cursorPos: number
): { mention: string; start: number; end: number } | null {
  const match = /(?:^|\s)@([a-zA-Z0-9_-]*)$/.exec(content.slice(0, cursorPos))
  if (!match) return null
  return {
    mention: match[1],
    start: cursorPos - match[1].length - 1,
    end: cursorPos,
  }
}
