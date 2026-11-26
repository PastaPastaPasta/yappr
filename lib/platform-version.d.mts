export declare function networkPlatformVersion<V>(
  PlatformVersion: new (version: number) => V,
  sdk: { version(): number },
): V
