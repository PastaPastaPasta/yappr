import { useSyncExternalStore } from 'react';
import { Dimensions, Platform, type ScaledSize, type TextProps } from 'react-native';

/**
 * The system font scale (Android) or Dynamic Type size (iOS) changing while
 * the app is open, for making text already on screen measure again at the new
 * size (`Text`). One Dimensions listener for the app, and a re-render only
 * when the scale itself changes, not on every window resize (rotation, split
 * screen).
 */

const listeners = new Set<() => void>();
let watching = false;
let scale = Number.NaN;
/** How many times the font scale has changed since the app started. */
let changes = 0;

function onDimensionsChange({ window }: { window: ScaledSize }) {
  if (window.fontScale === scale) return;
  scale = window.fontScale;
  changes += 1;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  if (!watching) {
    // For the app's lifetime: there is always text on screen.
    watching = true;
    scale = Dimensions.get('window').fontScale;
    Dimensions.addEventListener('change', onDimensionsChange);
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getChanges = () => changes;

/** How many times the font scale has changed while the app was open (re-rendering on each). */
export function useFontScaleChanges(): number {
  return useSyncExternalStore(subscribe, getChanges);
}

/**
 * iOS's Dynamic Type ramps. Android parses `dynamicTypeRamp` into the text's
 * attributes, where it is part of the key React Native caches text sizes
 * under, and otherwise ignores it.
 */
const RAMPS = [
  'caption2',
  'caption1',
  'footnote',
  'subheadline',
  'callout',
  'body',
  'headline',
  'title3',
  'title2',
  'title1',
  'largeTitle',
] as const satisfies readonly NonNullable<TextProps['dynamicTypeRamp']>[];

/**
 * Props that give Android text a new size-cache key after the `changes`th
 * font-scale change, so it is measured afresh: React Native's text-size cache
 * is keyed by the text and its attributes (the font scale among them), not
 * by the view, and the window's relayout as the scale changes can fill it
 * with sizes measured with the old font metrics under the new scale. Such a
 * stale size could match again only ten or more changes later, at the same
 * scale, by when the cache (1,024 sizes, least recently used out first) has
 * most likely dropped it. Nothing before the first change, and nothing on
 * iOS, where the prop changes how text scales.
 */
export function remeasureProps(changes: number): Pick<TextProps, 'dynamicTypeRamp'> {
  if (Platform.OS !== 'android' || changes === 0) return {};
  return { dynamicTypeRamp: RAMPS[(changes - 1) % RAMPS.length] };
}
