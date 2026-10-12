'use client'

import { useCallback, useEffect, useState } from 'react'
import { logger } from '@/lib/logger'
import { useAuth } from '@/contexts/auth-context'
import { CREDITS_PER_DASH } from '@/lib/constants'
import { appConnectPins } from '@/lib/app-connect/config'
import { walletKeyRows, type WalletKeyRow } from '@/lib/app-connect/wallet-keys'
import { appConnectPlatformPort } from '@/lib/app-connect/platform-port'
import { appConnectSessions, useAppConnectStatus } from '@/lib/app-connect/session-manager'
import { useRenewModal } from '@/hooks/use-renew-modal'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

function formatDash(credits: bigint): string {
  const dash = Number(credits) / CREDITS_PER_DASH
  return dash >= 0.01 ? dash.toFixed(2) : dash.toFixed(4)
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

const SCOPE_COPY = {
  yappr: 'Post, like, follow and message',
  'dash-profile': 'Edit your Dash profile',
} as const

/**
 * Settings → Privacy & Security on App Connect builds: what the user's
 * wallets let Yappr do, read from chain, with this browser's keys marked.
 * Yappr cannot revoke keys itself; that happens in the wallet.
 */
export function WalletConnectionsSettings() {
  const { user } = useAuth()
  const openRenew = useRenewModal((state) => state.open)
  const sessionIdentity = useAppConnectStatus((state) => state.identityId)
  const [rows, setRows] = useState<WalletKeyRow[] | null>(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    const pins = appConnectPins()
    if (!user || !pins) return
    setFailed(false)
    try {
      const identity = await appConnectPlatformPort.getIdentityFresh(user.identityId)
      const keys = identity?.publicKeys ?? []
      const budgeted = keys.filter((key) => key.totalBudget !== undefined && key.disabledAt === undefined).map((key) => key.id)
      const budgets = budgeted.length > 0
        ? await appConnectPlatformPort.remainingBudgets(user.identityId, budgeted)
        : new Map<number, bigint | undefined>()
      const session = appConnectSessions.current(user.identityId)
      const thisDevice = new Set(session?.authKeys.map((key) => key.keyId) ?? [])
      setRows(walletKeyRows(keys, budgets, pins.groupId, thisDevice))
    } catch (error) {
      logger.warn('Could not load wallet connections:', error)
      setFailed(true)
    }
  }, [user])

  useEffect(() => {
    load().catch((error: unknown) => logger.warn('Could not load wallet connections:', error))
  }, [load])

  if (!user) return null
  const signedInWithWallet = sessionIdentity === user.identityId

  return (
    <Card>
      <CardHeader>
        <CardTitle>Wallet connections</CardTitle>
        <CardDescription>
          What your Dash wallets let Yappr do for this account. To stop a connection, revoke Yappr in your wallet;
          signing out only removes it from this browser.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3" data-testid="wallet-connections">
        {rows === null && !failed && <Spinner size="sm" />}
        {failed && (
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-gray-600 dark:text-gray-400">Couldn&apos;t load your wallet connections.</p>
            <Button variant="outline" size="sm" onClick={() => { load().catch(() => undefined) }}>Try again</Button>
          </div>
        )}
        {rows?.length === 0 && (
          <p className="text-sm text-gray-600 dark:text-gray-400">No wallet is connected to Yappr for this account.</p>
        )}
        {rows?.map((row) => (
          <div key={row.keyId} className="rounded-xl ring-1 ring-gray-200 dark:ring-neutral-700 p-3 text-sm" data-testid="wallet-connection-row">
            <div className="flex items-center justify-between gap-2">
              <p className="font-medium text-gray-900 dark:text-white">{SCOPE_COPY[row.scope]}</p>
              {row.thisDevice && (
                <span className="px-2 py-0.5 rounded-full text-xs bg-yappr-100 text-yappr-700 dark:bg-yappr-900/30 dark:text-yappr-300">This browser</span>
              )}
            </div>
            <p className="text-gray-600 dark:text-gray-400 mt-1">
              {row.totalBudget === undefined
                ? 'No spending limit'
                : row.remaining !== undefined
                  ? `${formatDash(row.remaining)} of ${formatDash(row.totalBudget)} DASH left`
                  : `Up to ${formatDash(row.totalBudget)} DASH`}
              {row.expiresAt !== undefined && ` · until ${formatDate(row.expiresAt)}`}
            </p>
          </div>
        ))}
        {signedInWithWallet && (
          <Button variant="outline" onClick={() => openRenew()}>Renew in your wallet</Button>
        )}
      </CardContent>
    </Card>
  )
}
