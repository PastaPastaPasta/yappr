import { router, usePathname } from 'expo-router';
import { useEffect, useRef, useSyncExternalStore } from 'react';

import { DEFAULT_IPFS_GATEWAY } from '~/ui/media-url';

import { engine, engineSupervisor, type Engine } from './index';
import type { EngineStatus } from './supervisor';

/** The engine facade: `useEngine().api.feed.home({ tab: 'forYou' })`. */
export function useEngine(): Engine {
  return engine;
}

/** Supervisor state, versions and timings; re-renders on every change. */
export function useEngineStatus(): EngineStatus {
  return useSyncExternalStore(engineSupervisor.subscribeStatus, engineSupervisor.getStatus);
}

/** The engine's first path-style IPFS gateway (`engine.info().ipfsGateways`), for MediaUrlProvider. */
export function useIpfsGateway(): string {
  const { info } = useEngineStatus();
  const gateway = info?.ipfsGateways?.find((g) => g.format === 'path');
  return gateway ? `https://${gateway.domain}/ipfs/` : DEFAULT_IPFS_GATEWAY;
}

/** DiceBear markup for AvatarSvgProvider, rendered by the engine (`profiles.avatarSvg`). */
export const resolveAvatarSvg = (identityId: string, style: string, seed: string) =>
  engine.api.profiles.avatarSvg(identityId, style, seed);

/**
 * Root layout: when the engine cannot run on this device, show why (the
 * Lockdown screen on iOS, the WebView update screen on Android).
 */
export function useUnsupportedEngineRoute(): void {
  const { state, unsupported } = useEngineStatus();
  const pathname = usePathname();
  // Once until the engine comes up: leaving the screen ("Browse saved posts") is the user's choice, and a
  // foreground retry that ends unsupported again leaves them browsing (the banner leads back).
  const routed = useRef(false);
  useEffect(() => {
    if (state === 'ready' || state === 'degraded') routed.current = false;
    if (state !== 'unsupported' || !unsupported) return;
    if (routed.current) return;
    routed.current = true;
    const route = unsupported === 'lockdown' ? '/lockdown' : '/webview-update';
    if (pathname !== route) router.push(route);
  }, [state, unsupported, pathname]);
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
