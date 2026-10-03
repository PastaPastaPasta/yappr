import { render, screen } from '@testing-library/react-native';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { StyleSheet } from 'react-native';
import * as Reanimated from 'react-native-reanimated';

import { WalletGlyph } from '~/features/auth/KeyExchangeParts';

import { NetworkChip } from './NetworkChip';
import { PostSkeleton, Skeleton } from './Skeleton';

type Json = ReturnType<typeof screen.toJSON>;

/** The flattened style of every rendered host view that runs a CSS animation. */
function cssAnimated(json: Json): Record<string, unknown>[] {
  if (!json) return [];
  if (Array.isArray(json)) return json.flatMap((node) => cssAnimated(node));
  const style = StyleSheet.flatten(json.props.style) as Record<string, unknown> | undefined;
  const own = style && 'animationName' in style ? [style] : [];
  return [...own, ...(json.children ?? []).flatMap((child) => (typeof child === 'string' ? [] : cssAnimated(child)))];
}

/** Runs `fn` with the system's Reduce Motion on. */
function withReducedMotion(fn: () => void) {
  const mock = Reanimated as unknown as { useReducedMotion: () => boolean };
  const original = mock.useReducedMotion;
  mock.useReducedMotion = () => true;
  try {
    fn();
  } finally {
    mock.useReducedMotion = original;
  }
}

describe('pulses are CSS keyframe animations (D-L3a-010)', () => {
  it('a skeleton pulses like the web animate-pulse: opacity to 0.5 and back, every 2 s, forever', () => {
    render(<Skeleton width={96} />);
    const [style, ...rest] = cssAnimated(screen.toJSON());
    expect(rest).toHaveLength(0);
    expect(style).toMatchObject({
      animationName: { from: { opacity: 1 }, '50%': { opacity: 0.5 }, to: { opacity: 1 } },
      animationDuration: 2000,
      animationIterationCount: 'infinite',
    });
    expect(String(style?.animationTimingFunction)).toBe('cubic-bezier(0.4, 0, 0.6, 1)');
  });

  it('every bar of a post skeleton pulses, and none under Reduce Motion', () => {
    render(<PostSkeleton />);
    expect(cssAnimated(screen.toJSON())).toHaveLength(10);
    withReducedMotion(() => {
      render(<PostSkeleton />);
      expect(screen.getByTestId('post-skeleton')).toBeTruthy();
      expect(cssAnimated(screen.toJSON())).toHaveLength(0);
    });
  });

  it('the network dot pulses only while the engine connects', () => {
    const { rerender } = render(<NetworkChip network="devnet" state="booting" />);
    expect(cssAnimated(screen.toJSON())).toEqual([
      expect.objectContaining({
        animationName: { from: { opacity: 1 }, to: { opacity: 0.3 } },
        animationDirection: 'alternate',
        animationIterationCount: 'infinite',
      }),
    ]);
    rerender(<NetworkChip network="devnet" state="ready" />);
    expect(cssAnimated(screen.toJSON())).toHaveLength(0);
  });

  it('the wallet glyph breathes only while waiting on the wallet', () => {
    const { rerender } = render(<WalletGlyph pulsing />);
    expect(cssAnimated(screen.toJSON())).toEqual([
      expect.objectContaining({
        animationName: { from: { transform: [{ scale: 1 }] }, to: { transform: [{ scale: 1.08 }] } },
        animationIterationCount: 'infinite',
      }),
    ]);
    rerender(<WalletGlyph pulsing={false} />);
    expect(cssAnimated(screen.toJSON())).toHaveLength(0);
  });
});

/** Every non-test source file under `dir`. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

it('no UI-thread loop runs forever behind useAnimatedStyle; loops are CSS animations (see pulse.ts)', () => {
  const src = join(__dirname, '..');
  const offenders = sources(src).filter((path) => /withRepeat\([\s\S]*?,\s*-1\b/.test(readFileSync(path, 'utf8')));
  expect(offenders.map((path) => relative(src, path))).toEqual([]);
});
