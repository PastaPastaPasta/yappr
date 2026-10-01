import type { EngineApi } from '@engine/api';
import type { Remote } from '@engine/rpc/client';
import { queryOptions, type QueryKey } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useRef, useSyncExternalStore } from 'react';

import { config } from '~/config';

import { engine, engineSupervisor, type Engine } from './index';
import type { EngineStatus } from './supervisor';

/** The engine facade: `useEngine().api.feed.forYou({})`. */
export function useEngine(): Engine {
  return engine;
}

/** Supervisor state, versions and timings; re-renders on every change. */
export function useEngineStatus(): EngineStatus {
  return useSyncExternalStore(engineSupervisor.subscribeStatus, engineSupervisor.getStatus);
}

/** Subscribe to an engine event (ENGINE.md §8) for the component's lifetime. */
export function useEngineEvent(event: string, handler: (payload: unknown) => void): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => engine.on(event, (payload) => latest.current(payload)), [event]);
}

/**
 * TanStack Query options for an engine read. Keys are namespaced by network,
 * so a cache can never serve another network's data:
 *
 *   useQuery(engineQuery(['feed', 'forYou'], (api) => api.feed.forYou({})))
 *
 * Calls made before the engine is ready wait in the supervisor's queue; a
 * read interrupted by an engine restart is replayed once.
 */
export function engineQuery<T>(key: QueryKey, read: (api: Remote<EngineApi>) => Promise<T>) {
  return queryOptions({
    queryKey: ['engine', config.network, ...key],
    queryFn: () => read(engine.api),
  });
}

/**
 * Root layout: when the engine cannot run on this device, show why (the
 * Lockdown screen on iOS, the WebView update screen on Android).
 */
export function useUnsupportedEngineRoute(): void {
  const { state, unsupported } = useEngineStatus();
  useEffect(() => {
    if (state !== 'unsupported' || !unsupported) return;
    router.push(unsupported === 'lockdown' ? '/lockdown' : '/webview-update');
  }, [state, unsupported]);
}

/** Back to wherever the user was (saved content), or Home for a cold deep link. */
function leaveEngineScreen(): void {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

/**
 * The Lockdown and WebView update screens: leave them, and leave by
 * themselves once "Try again" brings the engine up.
 */
export function useLeaveWhenEngineRecovers(): () => void {
  const { state } = useEngineStatus();
  const wasUnsupported = useRef(false);
  useEffect(() => {
    if (state === 'unsupported') wasUnsupported.current = true;
    else if (wasUnsupported.current && (state === 'ready' || state === 'degraded')) leaveEngineScreen();
  }, [state]);
  return leaveEngineScreen;
}
