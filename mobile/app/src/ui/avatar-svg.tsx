import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * Where DiceBear SVG comes from. The app never bundles DiceBear (ENGINE.md):
 * the engine renders a recipe to markup (`profiles.avatarSvg`). The engine
 * host provides that; the gallery and tests provide fixtures.
 */
export type AvatarSvgResolver = (identityId: string, style: string, seed: string) => Promise<string | null>;

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

/** Rendered markup by `style:seed`, shared by every avatar for the app's lifetime. */
const cache = new Map<string, string>();

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
    resolve(identityId, style, seed)
      .then((svg) => {
        if (!svg) return;
        cache.set(key, svg);
        if (current) setLoaded({ key, svg });
      })
      .catch(() => {
        // The avatar stays the placeholder circle; nothing to surface.
      });
    return () => {
      current = false;
    };
  }, [key, style, seed, identityId, resolve]);

  if (!key) return undefined;
  return cache.get(key) ?? (loaded?.key === key ? loaded.svg : undefined);
}
