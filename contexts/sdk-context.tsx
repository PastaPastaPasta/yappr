'use client'

import { logger } from '@/lib/logger';
import React, { createContext, useContext, useEffect, useState } from 'react'
import { evoSdkService } from '@/lib/services/evo-sdk-service'
import { YAPPR_CONTRACT_ID, getConfiguredNetwork } from '@/lib/constants'

interface SdkContextType {
  // Bootstrap readiness stays true across connection recovery so consumers do
  // not reload forms and overwrite edits. getSdk() waits for the replacement.
  isReady: boolean
  error: string | null
}

const SdkContext = createContext<SdkContextType>({ isReady: false, error: null })

export function SdkProvider({ children }: { children: React.ReactNode }) {
  const [isReady, setIsReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let generation = 0
    const initializeSdk = async (reconnect = false) => {
      const requestGeneration = ++generation
      try {
        // This provider is the app-wide SDK bootstrap and usually wins the race
        // against the on-demand callers (services, platform-auth), so
        // it has to agree with them on the network. Hardcoding it would leave a
        // /devnet build reading testnet through every `useSdk()` consumer until
        // some later caller forced a reinit.
        const network = getConfiguredNetwork()
        logger.debug(`SdkProvider: Starting EvoSDK initialization for ${network}...`)

        if (reconnect) {
          await evoSdkService.reconnect()
        } else {
          await evoSdkService.initialize({
            network,
            contractId: YAPPR_CONTRACT_ID
          })
        }

        if (cancelled || requestGeneration !== generation) return
        setError(null)
        setIsReady(true)
        logger.debug('SdkProvider: EvoSDK initialized successfully, isReady = true')
      } catch (err) {
        logger.error('SdkProvider: Failed to initialize EvoSDK:', err)
        if (cancelled || requestGeneration !== generation) return
        setError(err instanceof Error ? err.message : 'Failed to initialize SDK')
      }
    }

    const reconnectSdk = () => {
      initializeSdk(true).catch((err) => logger.error('SdkProvider: reconnection failed:', err))
    }

    // Only initialize in browser
    if (typeof window !== 'undefined') {
      logger.debug('SdkProvider: Running in browser, starting initialization...')
      window.addEventListener('online', reconnectSdk)
      initializeSdk().catch((err) => logger.error('SdkProvider: initialization failed:', err))
    } else {
      logger.debug('SdkProvider: Not in browser, skipping initialization')
    }
    return () => {
      cancelled = true
      if (typeof window !== 'undefined') window.removeEventListener('online', reconnectSdk)
    }
  }, [])

  return (
    <SdkContext.Provider value={{ isReady, error }}>
      {children}
    </SdkContext.Provider>
  )
}

export function useSdk() {
  const context = useContext(SdkContext)
  if (!context) {
    throw new Error('useSdk must be used within SdkProvider')
  }
  return context
}
