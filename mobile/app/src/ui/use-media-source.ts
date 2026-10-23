import { useCallback, useEffect, useRef, useState } from 'react';

import { useMediaUrls, type ImageSize } from './media-url';

/** How long one source may stay silent before the next one is tried (UX_SPEC 2.4.6). */
export const MEDIA_SOURCE_TIMEOUT_MS = 8000;

interface Attempt {
  /** The candidate list this state belongs to, and its identity. */
  list: readonly string[];
  key: string;
  /** Index of the candidate being loaded; the list's length or more means every one failed. */
  index: number;
  loaded: boolean;
}

const start = (list: readonly string[], key: string): Attempt => ({ list, key, index: 0, loaded: false });

/** The state for a changed list: kept where the URL being shown is still in it, else started over. */
function carryOver(previous: Attempt, list: readonly string[], key: string): Attempt {
  const shown = previous.list[previous.index];
  const index = shown === undefined ? -1 : list.indexOf(shown);
  return index === -1 ? start(list, key) : { list, key, index, loaded: previous.loaded };
}

export interface MediaSource {
  /** The URL to hand to the image; undefined once every candidate failed (or there are none). */
  uri: string | undefined;
  /** The image painted. */
  loaded: boolean;
  /** Every candidate errored or timed out. */
  failed: boolean;
  /** There was something to try, so Retry means something. */
  retryable: boolean;
  onLoad: () => void;
  /** Download progress: a source that keeps receiving bytes is not stalled. */
  onProgress: () => void;
  onError: () => void;
  /** Start again from the first candidate. */
  retry: () => void;
}

/**
 * Walks an ordered list of image URLs (`useMediaUrls().candidates`): the next
 * one after an error, or after `MEDIA_SOURCE_TIMEOUT_MS` without a byte (a
 * source that is still downloading keeps its turn), then the failed state,
 * from which `retry` starts over. A list of one has nothing to fall back to,
 * so it waits for the image's own error. One hook for the post grid and the
 * full-screen viewer, so both fall back the same way.
 */
export function useMediaSource(candidates: readonly string[]): MediaSource {
  const key = candidates.join('\n');
  const count = candidates.length;
  const [attempt, setAttempt] = useState(() => start(candidates, key));
  // A new list (another item, or the engine's gateways arriving) keeps the source in view when it
  // is still listed, and starts over otherwise.
  const current = attempt.key === key ? attempt : carryOver(attempt, candidates, key);
  if (attempt.key !== key) setAttempt(current);

  const { index, loaded } = current;
  const failed = index >= count;
  const watched = count > 1 && !failed && !loaded;
  // When a byte last arrived for the source being watched; read by its timer, never rendered.
  const activeAt = useRef(0);

  // Only the attempt that is still running may move things on: a late event from the
  // source that was replaced says nothing about the new one.
  const next = useCallback(
    (from: number) =>
      setAttempt((s) => (s.key === key && s.index === from && !s.loaded ? { ...s, index: from + 1 } : s)),
    [key],
  );

  useEffect(() => {
    if (!watched) return;
    activeAt.current = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      const idle = Date.now() - activeAt.current;
      if (idle >= MEDIA_SOURCE_TIMEOUT_MS) next(index);
      else timer = setTimeout(check, MEDIA_SOURCE_TIMEOUT_MS - idle);
    };
    timer = setTimeout(check, MEDIA_SOURCE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [watched, index, next]);

  const onLoad = useCallback(
    () => setAttempt((s) => (s.key === key && s.index === index && !s.loaded ? { ...s, loaded: true } : s)),
    [key, index],
  );
  const onProgress = useCallback(() => {
    activeAt.current = Date.now();
  }, []);
  const onError = useCallback(() => next(index), [next, index]);
  const retry = useCallback(() => setAttempt((s) => start(s.list, s.key)), []);

  return {
    uri: failed ? undefined : candidates[index],
    loaded,
    failed,
    retryable: count > 0,
    onLoad,
    onProgress,
    onError,
    retry,
  };
}

/** `useMediaSource` for one stored media URL, resolved through the provider's gateways. */
export function useMediaUrlSource(url: string | null | undefined, size?: ImageSize): MediaSource {
  const { candidates } = useMediaUrls();
  return useMediaSource(candidates(url, size));
}
