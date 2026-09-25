import { WasmSdk } from '@dashevo/evo-sdk'

/**
 * The label DPNS compares on: homograph-safe, so case, o/0 and i/l/1 all fold
 * together. Uses the WASM export from the same SDK that sets isReady, so pass
 * that flag in. Before the SDK is ready, or if the export throws, fall back to
 * a case-insensitive comparison rather than crash the caller.
 */
export function canonicalDpnsLabel(label: string, isSdkReady: boolean): string {
  const trimmed = label.trim()
  if (!isSdkReady) return trimmed.toLowerCase()
  try {
    return WasmSdk.dpnsConvertToHomographSafe(trimmed)
  } catch {
    return trimmed.toLowerCase()
  }
}
