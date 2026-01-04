'use client'

import { cacheManager } from '@/lib/cache-manager'
import { ArrowPathIcon } from '@heroicons/react/24/outline'

export function DevelopmentBanner() {
  const handleClearCache = () => {
    // Clear application cache
    cacheManager.clearAll()
    
    // Clear browser storage
    if (typeof window !== 'undefined') {
      // Clear localStorage (except auth and encrypted credential data)
      const keysToKeep = [
        'dash_identity_id',
        'dash_public_address',
        'yappr_session',
        'yappr_encrypted_credentials'
      ]
      const savedData: Record<string, string> = {}

      // Save auth data by exact key
      keysToKeep.forEach(key => {
        const value = localStorage.getItem(key)
        if (value) savedData[key] = value
      })

      // Clear all localStorage
      localStorage.clear()

      // Restore auth data
      Object.entries(savedData).forEach(([key, value]) => {
        localStorage.setItem(key, value)
      })

      // Clear sessionStorage
      sessionStorage.clear()

      // Reload the page
      window.location.reload()
    }
  }

  return (
    <div className="bg-amber-500 text-black px-4 py-2 text-sm fixed top-0 left-0 right-0 z-50">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        <p className="text-center flex-1">
          <span className="font-bold">TESTNET</span>
          {' '}
          <span className="opacity-80">|</span>
          {' '}
          <span className="font-medium">Running on Dash Platform Testnet. Data may be reset.</span>
        </p>

        <button
          onClick={handleClearCache}
          className="ml-4 flex items-center gap-1 px-3 py-1 bg-black/10 hover:bg-black/20 rounded-md transition-colors"
          title="Clear cache and reload"
        >
          <ArrowPathIcon className="h-4 w-4" />
          <span>Clear Cache</span>
        </button>
      </div>
    </div>
  )
}