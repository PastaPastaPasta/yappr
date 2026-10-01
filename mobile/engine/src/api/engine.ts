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
import { PROTOCOL_VERSION } from '../protocol/envelope'
import { ENGINE_BUILD, bundleHash } from '../build-info'
import type { EngineRuntime } from '../runtime'
import type { AppLifecycleState } from '../shims/lifecycle'

export interface EngineInfo {
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
  /** Wall time of the first boot's SDK initialization, once it finished. */
  bootMs?: number
}

export function createEngineModule(runtime: EngineRuntime) {
  let bootMs: number | undefined
  let booting: Promise<void> | null = null

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
        throw Object.assign(new Error('WebAssembly is unavailable (iOS Lockdown Mode?)'), { code: 'NO_WEBASSEMBLY' })
      }
      if (!booting) {
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
      runtime.lifecycle?.(state)
    },

    /** The host forwards NetInfo changes here; `online` lets the SDK rebuild a dead instance. */
    async connectivity(online: boolean): Promise<void> {
      runtime.connectivity?.(online)
      if (online && booting) await evoSdkService.restoreConnection()
    },
  }
}
