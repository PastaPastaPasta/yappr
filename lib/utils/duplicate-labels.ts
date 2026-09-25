/**
 * Canonical labels that appear more than once in `labels`, compared after
 * `normalise`. Labels that normalise to an empty string are ignored, so blank
 * rows never form a duplicate group.
 */
export function findDuplicateLabels(
  labels: readonly string[],
  normalise: (label: string) => string
): Set<string> {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const label of labels) {
    const canonical = normalise(label)
    if (!canonical) continue
    if (seen.has(canonical)) duplicates.add(canonical)
    seen.add(canonical)
  }
  return duplicates
}
