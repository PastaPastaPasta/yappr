let generation = 0

/** Moves on with every change of the signed-in identity: sign-in, sign-out, account switch and restore. */
export function bumpSessionGeneration(): void {
  generation += 1
}

export function sessionGeneration(): number {
  return generation
}

/** True while no session change has happened since this was called. */
export function sessionGuard(): () => boolean {
  const started = generation
  return () => generation === started
}
