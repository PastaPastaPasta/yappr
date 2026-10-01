import {
  DPNS_CONTRACT_ID,
  YAPPR_CONTRACT_ID,
  YAPPR_DM_CONTRACT_ID,
  YAPPR_DM_V5_CONTRACT_ID,
  getConfiguredNetwork,
  getContractTopology,
  type AppNetwork,
  type ContractTopology,
} from '@/lib/constants'
import { profileBaseSource } from '@/lib/profile/v10-profile'
import { evoSdkService } from '@/lib/services/evo-sdk-service'
import { PROTOCOL_VERSION, RpcError, type LogLevel } from '../protocol/envelope'
import { ENGINE_BUILD, bundleHash } from '../build-info'
import type { AppLifecycleState } from '../shims/lifecycle'
import { platformInfo, type PlatformInfoDTO } from '../dto/capabilities'

/**
 * Host-specific hooks the API needs. The WebView entry wires the real shims;
 * the Node harness passes nothing.
 */
export interface EngineRuntime {
  lifecycle?: (state: AppLifecycleState) => void | Promise<void>
  connectivity?: (online: boolean) => void
  setLogLevel?: (level: LogLevel) => void
  /** Send an event to the host (`write.status`, `session.changed`, ...). */
  emit?: (event: string, payload: unknown) => void
  /** Resolves once the host has acknowledged every secure-storage batch so far (ENGINE.md §9.1). */
  secureDurable?: () => Promise<void>
}

export interface EngineInfo extends PlatformInfoDTO {
  protocol: number
  variant: string
  bundleHash: string
  evoSdkVersion: string
  builtAt: string
  network: AppNetwork
  topology: ContractTopology
  contracts: {
    social: string
    profile: string
    dpns: string
    dm: string
    dmV5: string
  }
  /** The SDK is connected and the contracts are preloaded. */
  ready: boolean
  /** WebAssembly is available (false under iOS Lockdown Mode). */
  webAssembly: boolean
  /** Wall time of the first successful boot's SDK initialization. */
  bootMs?: number
}

export function createEngineModule(runtime: EngineRuntime) {
  let bootMs: number | undefined
  let booting: Promise<void> | null = null
  let bootAttempted = false

  const info = (): EngineInfo => ({
    protocol: PROTOCOL_VERSION,
    variant: ENGINE_BUILD.variant,
    bundleHash: bundleHash(),
    evoSdkVersion: ENGINE_BUILD.evoSdkVersion,
    builtAt: ENGINE_BUILD.builtAt,
    network: getConfiguredNetwork(),
    topology: getContractTopology(),
    contracts: {
      social: YAPPR_CONTRACT_ID,
      profile: profileBaseSource().contractId,
      dpns: DPNS_CONTRACT_ID,
      dm: YAPPR_DM_CONTRACT_ID,
      dmV5: YAPPR_DM_V5_CONTRACT_ID,
    },
    ready: evoSdkService.isReady(),
    webAssembly: typeof WebAssembly !== 'undefined',
    ...(bootMs !== undefined ? { bootMs } : {}),
    ...platformInfo(),
  })

  return {
    /**
     * Connect the SDK, exactly as the web's SdkProvider does. Storage is
     * already hydrated (before load; see shims/storage). Idempotent:
     * concurrent and repeated calls share one boot, and a failed boot can be
     * retried.
     */
    async boot(): Promise<EngineInfo> {
      if (typeof WebAssembly === 'undefined') {
        throw new RpcError('WebAssembly is unavailable (iOS Lockdown Mode?)', 'NO_WEBASSEMBLY')
      }
      if (!booting) {
        bootAttempted = true
        const started = performance.now()
        booting = evoSdkService
          .initialize({ network: getConfiguredNetwork(), contractId: YAPPR_CONTRACT_ID })
          .then(() => {
            bootMs ??= Math.round(performance.now() - started)
          })
          .catch((error: unknown) => {
            booting = null
            throw error
          })
      }
      await booting
      return info()
    },

    async info(): Promise<EngineInfo> {
      return info()
    },

    /** The host forwards React Native AppState changes here. */
    async lifecycle(state: AppLifecycleState): Promise<void> {
      await runtime.lifecycle?.(state)
    },

    /**
     * The host forwards NetInfo changes here. Coming back online repairs the
     * SDK as web's SdkProvider does: it rebuilds an instance that lost its
     * connection, or finishes a boot that failed while offline.
     */
    async connectivity(online: boolean): Promise<void> {
      runtime.connectivity?.(online)
      if (online && bootAttempted) await evoSdkService.restoreConnection()
    },

    /** Lowest console level forwarded to the host (default `info`; `debug` is costly over the bridge). */
    async setLogLevel(level: LogLevel): Promise<void> {
      runtime.setLogLevel?.(level)
    },
  }
}
