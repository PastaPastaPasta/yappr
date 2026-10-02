import type { EngageStatsDTO } from '@engine/api';

import { engine } from '~/engine';

interface Waiting {
  id: string;
  kind: 'post' | 'reply';
  resolve: (stats: EngageStatsDTO | null) => void;
  reject: (error: unknown) => void;
}

/** `engage.stats` takes up to 100 targets a call. */
const MAX_TARGETS = 100;

let waiting: Waiting[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  const batch = waiting;
  waiting = [];
  timer = null;
  for (let at = 0; at < batch.length; at += MAX_TARGETS) {
    const chunk = batch.slice(at, at + MAX_TARGETS);
    const targets = [...new Map(chunk.map(({ id, kind }) => [id, { id, kind }])).values()];
    engine.api.engage
      .stats(targets)
      .then((stats) => chunk.forEach((w) => w.resolve(stats[w.id] ?? null)))
      .catch((error: unknown) => chunk.forEach((w) => w.reject(error)));
  }
}

/**
 * One target's fresh counts and viewer marks (`engage.stats`). Requests made
 * in the same tick share one call, so a feed of bare reposts reads them all
 * at once.
 */
export function readEngageStats(id: string, kind: 'post' | 'reply'): Promise<EngageStatsDTO | null> {
  return new Promise((resolve, reject) => {
    waiting.push({ id, kind, resolve, reject });
    timer ??= setTimeout(flush, 0);
  });
}
