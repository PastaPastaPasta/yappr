'use client'

import { useState } from 'react'
import toast from 'react-hot-toast'
import { NoSymbolIcon, ArrowUturnLeftIcon, FireIcon } from '@heroicons/react/24/outline'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/auth-context'
import { tokenService } from '@/lib/services/token-service'

/**
 * Owner-only YAPP moderation: freeze (suspend), unfreeze (reinstate), and
 * destroyFrozen (slash the staked balance). Rendered only for the token
 * authority identity (gated in the settings page).
 */
export function ModerationSettings() {
  const { user } = useAuth()
  const [targetId, setTargetId] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<null | 'freeze' | 'unfreeze' | 'destroyFrozen'>(null)

  const run = async (action: 'freeze' | 'unfreeze' | 'destroyFrozen') => {
    if (!user) return
    const id = targetId.trim()
    if (!id) {
      toast.error('Enter the identity ID to moderate')
      return
    }
    if (action === 'destroyFrozen' && !window.confirm(
      `Permanently burn ${id}'s YAPP balance? This slashes their stake and cannot be undone. The account must already be frozen.`
    )) return

    setBusy(action)
    const fn = action === 'freeze' ? tokenService.freeze
      : action === 'unfreeze' ? tokenService.unfreeze
      : tokenService.destroyFrozen
    const result = await fn.call(tokenService, user.identityId, id, note.trim() || undefined)
    setBusy(null)

    if (result.success) {
      toast.success(
        action === 'freeze' ? 'Identity frozen (suspended)'
          : action === 'unfreeze' ? 'Identity unfrozen (reinstated)'
          : 'Frozen balance destroyed (slashed)'
      )
    } else {
      toast.error(result.error || 'Action failed')
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>YAPP Moderation</CardTitle>
        <CardDescription>
          Freeze suspends an account (blocks posting and transfers immediately). Slash permanently
          burns a frozen account&apos;s YAPP stake. Use unfreeze to reinstate.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Identity ID</label>
          <input
            type="text"
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            placeholder="Base58 identity ID to moderate"
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-yappr-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Public note (optional)</label>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Reason recorded on-chain"
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 text-sm focus:outline-none focus:ring-2 focus:ring-yappr-500"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy !== null} onClick={() => run('freeze')} className="gap-2">
            <NoSymbolIcon className="h-4 w-4" /> {busy === 'freeze' ? 'Freezing…' : 'Freeze'}
          </Button>
          <Button variant="outline" disabled={busy !== null} onClick={() => run('unfreeze')} className="gap-2">
            <ArrowUturnLeftIcon className="h-4 w-4" /> {busy === 'unfreeze' ? 'Unfreezing…' : 'Unfreeze'}
          </Button>
          <Button variant="destructive" disabled={busy !== null} onClick={() => run('destroyFrozen')} className="gap-2">
            <FireIcon className="h-4 w-4" /> {busy === 'destroyFrozen' ? 'Slashing…' : 'Slash'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
