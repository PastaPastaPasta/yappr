import { create } from 'zustand';

/** NSFW profiles the reader chose to view; for this app session only (PRD PROF-10). */
const useAcknowledged = create<{ ids: ReadonlySet<string> }>()(() => ({ ids: new Set<string>() }));

export function useNsfwAcknowledged(identityId: string): [boolean, () => void] {
  const acknowledged = useAcknowledged((s) => s.ids.has(identityId));
  const acknowledge = () =>
    useAcknowledged.setState(({ ids }) => ({ ids: new Set(ids).add(identityId) }));
  return [acknowledged, acknowledge];
}
