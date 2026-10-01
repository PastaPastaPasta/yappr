import type { AppLifecycleState } from './shims/lifecycle'

/**
 * Host-specific hooks the API needs. The WebView entry wires the real shims;
 * the Node harness passes nothing.
 */
export interface EngineRuntime {
  lifecycle?: (state: AppLifecycleState) => void
  connectivity?: (online: boolean) => void
}
