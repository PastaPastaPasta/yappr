import type { SyntheticEvent } from 'react'

/** For controls inside a clickable card: keep the click from reaching the card. */
export function stopPropagation(e: SyntheticEvent): void {
  e.stopPropagation()
}
