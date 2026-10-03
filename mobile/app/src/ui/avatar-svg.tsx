import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * Where DiceBear SVG comes from. The app never bundles DiceBear (ENGINE.md):
 * the engine renders a recipe to markup (`profiles.avatarSvg`). The engine
 * host provides that; the gallery and tests provide fixtures.
 */
export type AvatarSvgResolver = (
  identityId: string,
  style: string,
  seed: string,
) => string | null | Promise<string | null>;

const ResolverContext = createContext<AvatarSvgResolver | null>(null);

export function AvatarSvgProvider({
  resolve,
  children,
}: {
  resolve: AvatarSvgResolver;
  children: ReactNode;
}) {
  return <ResolverContext.Provider value={resolve}>{children}</ResolverContext.Provider>;
}

/**
 * DiceBear's `<metadata>` (title, creator, licence) never renders, and its
 * `viewboxMask` with a 0 radius is a rect covering the whole viewBox: an
 * identity mask, since the avatar's viewport clips to the viewBox anyway.
 * react-native-svg still parses the one into every avatar's tree, and makes
 * the other two more native views per avatar, drawn through offscreen layers
 * on Android. Exact DiceBear output only; anything else passes through
 * untouched.
 */
const METADATA = /<metadata[\s>][\s\S]*?<\/metadata>/g;
const VIEWBOX = /^\s*<svg\b[^>]*\sviewBox="([^"]+)"/;
const IDENTITY_MASK =
  /<mask id="viewboxMask"><rect width="([\d.]+)" height="([\d.]+)" rx="0" ry="0" x="([-\d.]+)" y="([-\d.]+)" fill="#fff" ?\/><\/mask>/;

/** `svg` without what never changes a pixel (see above): less to keep, parse and draw. */
export function slimDicebearSvg(svg: string): string {
  let out = svg.replace(METADATA, '');
  const mask = IDENTITY_MASK.exec(out);
  const viewBox = VIEWBOX.exec(out)?.[1]?.trim().split(/[\s,]+/).map(Number);
  if (mask && viewBox?.length === 4) {
    const [, width, height, x, y] = mask.map(Number);
    if (x === viewBox[0] && y === viewBox[1] && width === viewBox[2] && height === viewBox[3]) {
      out = out.replace(mask[0], '').replaceAll(' mask="url(#viewboxMask)"', '');
    }
  }
  return out;
}

/** Recipes kept rendered; the web keeps 500 (lib/services/avatar-generator). */
export const AVATAR_SVG_CACHE_MAX = 300;

/** Rendered markup by `style:seed`, shared by every avatar, least recently used first. */
const cache = new Map<string, string>();

function cached(key: string): string | undefined {
  const svg = cache.get(key);
  if (svg !== undefined) {
    cache.delete(key);
    cache.set(key, svg);
  }
  return svg;
}

function remember(key: string, svg: string) {
  cache.delete(key);
  cache.set(key, svg);
  for (const oldest of cache.keys()) {
    if (cache.size <= AVATAR_SVG_CACHE_MAX) break;
    cache.delete(oldest);
  }
}

/**
 * The SVG for a DiceBear recipe: cached at once, else resolved through the
 * provider. `undefined` while loading, with no recipe, or with no provider.
 */
export function useDicebearSvg(
  identityId: string | undefined,
  recipe: { style: string; seed: string } | null | undefined,
): string | undefined {
  const resolve = useContext(ResolverContext);
  const style = recipe?.style;
  const seed = recipe?.seed;
  const key = style && seed ? `${style}:${seed}` : undefined;
  const [loaded, setLoaded] = useState<{ key: string; svg: string }>();

  useEffect(() => {
    if (!key || !style || !seed || !identityId || !resolve || cache.has(key)) return undefined;
    let current = true;
    const apply = (raw: string | null) => {
      if (!raw) return;
      const svg = slimDicebearSvg(raw);
      remember(key, svg);
      if (current) setLoaded({ key, svg });
    };
    // A synchronous resolver (fixtures) applies inside this effect, with no extra tick.
    const out = resolve(identityId, style, seed);
    if (typeof out === 'string' || out === null) apply(out);
    else
      out.then(apply).catch(() => {
        // The avatar stays the placeholder circle; nothing to surface.
      });
    return () => {
      current = false;
    };
  }, [key, style, seed, identityId, resolve]);

  if (!key) return undefined;
  return cached(key) ?? (loaded?.key === key ? loaded.svg : undefined);
}
