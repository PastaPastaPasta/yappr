'use client'

import { logger } from '@/lib/logger';
import React, { createContext, useContext, useEffect, useState } from 'react'
import { evoSdkService } from '@/lib/services/evo-sdk-service'
import { YAPPR_CONTRACT_ID, getConfiguredNetwork } from '@/lib/constants'

interface SdkContextType {
  isReady: boolean
  error: string | null
}

const SdkContext = createContext<SdkContextType>({ isReady: false, error: null })

export function SdkProvider({ children }: { children: React.ReactNode }) {
  const [isReady, setIsReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const initializeSdk = async () => {
      try {
        // This provider is the app-wide SDK bootstrap and usually wins the race
        // against the on-demand callers (DashPlatformClient, platform-auth), so
        // it has to agree with them on the network. Hardcoding it would leave a
        // /devnet build reading testnet through every `useSdk()` consumer until
        // some later caller forced a reinit.
        const network = getConfiguredNetwork()
        logger.info(`SdkProvider: Starting EvoSDK initialization for ${network}...`)

        await evoSdkService.initialize({
          network,
          contractId: YAPPR_CONTRACT_ID
        })

        setIsReady(true)
        logger.info('SdkProvider: EvoSDK initialized successfully, isReady = true')
      } catch (err) {
        logger.error('SdkProvider: Failed to initialize EvoSDK:', err)
        setError(err instanceof Error ? err.message : 'Failed to initialize SDK')
        // Still set isReady to false explicitly
        setIsReady(false)
      }
    }

    // Only initialize in browser
    if (typeof window !== 'undefined') {
      logger.info('SdkProvider: Running in browser, starting initialization...')
      initializeSdk()
    } else {
      logger.info('SdkProvider: Not in browser, skipping initialization')
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