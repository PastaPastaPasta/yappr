'use client'

import { logger } from '@/lib/logger';
import React, { createContext, useContext, useEffect, useState } from 'react'
import { appSdkConfig, evoSdkService } from '@/lib/services/evo-sdk-service'

interface SdkContextType {
  // True once the bootstrap has succeeded, and stays true while the service
  // rebuilds its instance after a connection failure: consumers keyed on it
  // must not reload their forms and discard edits. getSdk() waits for the
  // replacement.
  isReady: boolean
  error: string | null
}

const SdkContext = createContext<SdkContextType>({ isReady: false, error: null })

export function SdkProvider({ children }: { children: React.ReactNode }) {
  const [isReady, setIsReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const settle = (task: Promise<void>, what: string) => {
      task.then(() => {
        if (cancelled) return
        setError(null)
        setIsReady(true)
        logger.debug(`SdkProvider: ${what} succeeded, isReady = true`)
      }).catch((err: unknown) => {
        logger.error(`SdkProvider: ${what} failed:`, err)
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to initialize SDK')
      })
    }

    // The app-wide SDK bootstrap. A child's effect runs before this one, so a
    // service read on mount may already have started the same configuration
    // (getSdk() falls back to it); initialize() then joins that attempt.
    const config = appSdkConfig()
    logger.debug(`SdkProvider: Starting EvoSDK initialization for ${config.network}...`)
    settle(evoSdkService.initialize(config), 'initialization')

    // Requests made while offline ban endpoints inside the instance, and the
    // bootstrap itself may have failed; either is repaired once we are back.
    const restore = () => settle(evoSdkService.restoreConnection(), 'connection restore')
    window.addEventListener('online', restore)
    return () => {
      cancelled = true
      window.removeEventListener('online', restore)
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
