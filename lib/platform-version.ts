/**
 * The protocol version to build and decode Platform objects under: the one
 * the connected network runs (`sdk.version()`, learned from proved responses),
 * never `PlatformVersion.latest()` / `current()`, which are the newest version
 * the SDK knows (15 on 5.1) even on a protocol-14 network.
 */
export function networkPlatformVersion<V>(
  PlatformVersion: new (version: number) => V,
  sdk: { version(): number },
): V {
  return new PlatformVersion(sdk.version());
}
