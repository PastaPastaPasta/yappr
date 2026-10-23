'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { SettingsSwitch } from '@/components/settings/settings-switch'
import { Spinner } from '@/components/ui/spinner'
import { useAuth } from '@/contexts/auth-context'
import { syncModeratorViewer, useModeratorView, useModeratorViewStore } from '@/hooks/use-moderator-view'
import { cn } from '@/lib/utils'

/** Where the moderators' list of hidden content and restricted accounts lives. */
export const HIDDEN_CONTENT_HREF = '/moderation?view=hidden'

/**
 * Keeps the moderator view in step with the signed-in identity: takes it
 * once the session is restored and reads its seats, and reloads the page
 * when a moderator session with the view on signs out or changes (or one
 * that turned it on signs back in). Renders nothing. Mounted once, in the app
 * shell.
 */
export function ModeratorViewController() {
  const { user, isAuthRestoring } = useAuth()
  const identityId = user?.identityId ?? null
  useEffect(() => (isAuthRestoring ? undefined : syncModeratorViewer(identityId)), [identityId, isAuthRestoring])
  return null
}

/**
 * What a held page shows while the moderator view is applied (the session
 * restored and the seats read), with a way out should that take long.
 */
export function ModeratorViewHold() {
  const abandonHold = useModeratorViewStore((state) => state.abandonHold)
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4" data-testid="moderator-view-hold">
      <Spinner size="md" />
      <p className="text-sm text-gray-500">Opening moderator view…</p>
      <button type="button" onClick={abandonHold} className="text-sm font-medium text-yappr-600 hover:underline dark:text-yappr-400">
        Continue without it
      </button>
    </div>
  )
}

/**
 * The slim notice shown while the view is on, floating above the page (it
 * takes no room in it), with a way to turn it off. It stays under the mobile
 * menu sheet and its backdrop (z-40), which it would otherwise cover, Sign out
 * included.
 */
export function ModeratorViewBar() {
  const { active, setEnabled } = useModeratorView()
  if (!active) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-30 flex justify-center px-4 md:bottom-4">
      <div
        role="status"
        data-testid="moderator-view-bar"
        className="pointer-events-auto flex items-center gap-3 rounded-full bg-amber-100 py-1.5 pl-3 pr-1.5 text-xs font-medium text-amber-900 shadow-md ring-1 ring-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-900"
      >
        <EyeIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>Moderator view: showing hidden and restricted content</span>
        <button
          type="button"
          onClick={() => setEnabled(false)}
          className="rounded-full px-2.5 py-1 font-semibold hover:bg-amber-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:hover:bg-amber-900"
        >
          Turn off
        </button>
      </div>
    </div>
  )
}

/** A small switch for a social feed's header; nothing for anyone who is not a seated social moderator. */
export function ModeratorViewChip({ className }: { className?: string }) {
  const { seated, active, setEnabled } = useModeratorView()
  if (!seated.includes('social')) return null
  const Icon = active ? EyeIcon : EyeSlashIcon
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      data-testid="moderator-view-chip"
      onClick={() => setEnabled(!active)}
      title={active ? 'Hide hidden and restricted content' : 'Show hidden and restricted content'}
      className={cn(
        'flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors',
        active
          ? 'bg-amber-100 text-amber-900 hover:bg-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:hover:bg-amber-900'
          : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-900 dark:text-gray-400 dark:hover:bg-gray-800',
        className
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      Moderator view
    </button>
  )
}

/** The account menu's entries: the switch and the list of hidden content. Nothing for anyone who is not a seated moderator. */
export function ModeratorViewMenuItems() {
  const { seated, active, setEnabled } = useModeratorView()
  if (seated.length === 0) return null
  const itemClass = 'px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-900 cursor-pointer outline-none flex items-center gap-2'
  return (
    <>
      <DropdownMenu.CheckboxItem
        data-testid="moderator-view-menu-toggle"
        checked={active}
        onCheckedChange={setEnabled}
        onSelect={(event) => event.preventDefault()}
        className={cn(itemClass, 'justify-between gap-4')}
      >
        <span className="flex items-center gap-2">
          <EyeIcon className="h-4 w-4" aria-hidden="true" />
          Show hidden &amp; restricted
        </span>
        <span
          aria-hidden="true"
          className={cn('relative h-4 w-7 shrink-0 rounded-full transition-colors', active ? 'bg-yappr-500' : 'bg-gray-300 dark:bg-gray-700')}
        >
          <span className={cn('absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform', active ? 'translate-x-3.5' : 'translate-x-0.5')} />
        </span>
      </DropdownMenu.CheckboxItem>
      <DropdownMenu.Item asChild className={itemClass}>
        <Link href={HIDDEN_CONTENT_HREF}>
          <EyeSlashIcon className="h-4 w-4" aria-hidden="true" />
          Hidden &amp; restricted
        </Link>
      </DropdownMenu.Item>
      <DropdownMenu.Separator className="my-1 h-px bg-gray-200 dark:bg-gray-800" />
    </>
  )
}

/** Settings → Moderation: the switch, and the way to the list of hidden content. Nothing for anyone who is not a seated moderator. */
export function ModeratorViewSettings() {
  const { seated, active, setEnabled } = useModeratorView()
  if (seated.length === 0) return null
  return (
    <Card data-testid="moderator-view-settings">
      <CardHeader>
        <CardTitle>Moderator view</CardTitle>
        <CardDescription>
          See what the team has hidden and what restricted accounts have posted, labelled, wherever it would appear. Only you see it, and only in this tab.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex items-center justify-between gap-4">
          <span className="text-sm font-medium">Show hidden &amp; restricted</span>
          <SettingsSwitch checked={active} onCheckedChange={setEnabled} aria-label="Show hidden and restricted content" />
        </label>
        <Link href={HIDDEN_CONTENT_HREF} className="inline-block text-sm font-medium text-yappr-600 hover:underline dark:text-yappr-400">
          Recently hidden and restricted
        </Link>
      </CardContent>
    </Card>
  )
}
