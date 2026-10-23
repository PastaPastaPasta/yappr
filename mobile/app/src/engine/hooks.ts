import { router, usePathname } from 'expo-router';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { DEFAULT_IPFS_GATEWAYS, type IpfsGateway } from '~/ui/media-url';

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

/**
 * The engine's ordered IPFS gateway list (`engine.info().ipfsGateways`), for
 * MediaUrlProvider. The last list it reported stays while the engine restarts
 * (`info` is empty then), so the images already on screen aren't reloaded
 * through another gateway and back.
 */
export function useIpfsGateways(): readonly IpfsGateway[] {
  const { info } = useEngineStatus();
  const reported = info?.ipfsGateways;
  const [known, setKnown] = useState<readonly IpfsGateway[]>(DEFAULT_IPFS_GATEWAYS);
  if (reported && reported.length > 0 && reported !== known) setKnown(reported);
  return known;
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
