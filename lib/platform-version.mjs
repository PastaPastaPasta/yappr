/**
 * The protocol version to build and serialize documents and contracts under:
 * the one the connected network runs (`sdk.version()`, learned from proved
 * responses), never wasm-dpp2's `PlatformVersion.latest()` / `current()`, which
 * are the newest version the SDK knows (15 on 5.1) even on a protocol-14
 * network. Until its first proved read the SDK reports its starting version
 * (14), so a caller that must match a newer network reads something first.
 * Shared by the app and the Node tooling. Types: platform-version.d.mts.
 */
export function networkPlatformVersion(PlatformVersion, sdk) {
  return new PlatformVersion(sdk.version())
}
