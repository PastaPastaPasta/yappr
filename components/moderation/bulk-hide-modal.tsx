'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { Modal, ModalTitle } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/auth-context'
import { useModerationAuthorization } from '@/hooks/use-moderation-authorization'
import { useBulkHideModal, useBulkModeratedMarks } from '@/hooks/use-bulk-hide-modal'
import { ModerationKeyNotice } from '@/components/moderation/moderation-key-notice'
import { labelOptions, relativeTime, type LabelOption } from '@/lib/moderation-labels'
import { HIDE_FEE_CREDITS, UNHIDE_FEE_CREDITS, bulkCostLine, closedKeySheet, idsWithin, runBulk, type BulkItem, type BulkMode, type BulkProgress, type BulkRange, type BulkSummary } from '@/lib/moderation-bulk'
import { bulkHideService } from '@/lib/services/bulk-hide-service'
import { dpnsService } from '@/lib/services/dpns-service'
import { MOD_HIDDEN, moderationService, type ModerationReasonInput } from '@/lib/services/moderation-service'
import { cn } from '@/lib/utils'
import { CharterReasonPicker, useSeatedReasons } from './charter-reason-picker'

const INPUT = 'w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 text-sm focus:outline-none focus:ring-2 focus:ring-yappr-500'
const CHIP = 'px-3 py-1 rounded-full border text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed'

type ListState =
  | { status: 'loading'; count: number }
  | { status: 'ready'; items: BulkItem[]; truncated: boolean }
  | { status: 'failed' }

const RANGES: ReadonlyArray<{ range: BulkRange; text: string }> = [
  { range: 'day', text: 'Last 24 hours' },
  { range: 'week', text: 'Last 7 days' },
  { range: 'all', text: 'All' },
]

const NO_COUNTS: Record<BulkMode, number | null> = { hide: null, unhide: null }

/** How long after a run the lists are read again, so a node a block behind does not show what just changed. */
const SETTLE_MS = 4000

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/** "Hiding 37 of 100…" during a run, then what happened. */
function bulkStatusLine(mode: BulkMode, state: BulkProgress | BulkSummary): string {
  if (!('stopped' in state)) {
    const at = Math.min(state.total, state.done + state.failures.length + (state.current ? 1 : 0))
    return `${mode === 'hide' ? 'Hiding' : 'Unhiding'} ${Math.max(at, 1).toLocaleString()} of ${state.total.toLocaleString()}…`
  }
  const done = `${mode === 'hide' ? 'Hid' : 'Unhid'} ${state.done.toLocaleString()} of ${plural(state.total, 'post')}.`
  if (state.stopped === 'cancelled') return `Stopped. ${done}`
  if (state.stopped === 'fatal') return `${done} ${state.error ?? ''}`.trim()
  return done
}

/**
 * Hide many of one account's posts and replies at once, or unhide them
 * (social v18). Opened from the Restrict dialog ("Also hide this account's
 * earlier posts"), from a post's menu or from the profile's moderator row.
 *
 * It lists what the account has showing, read from the chain, newest first,
 * every page of it. The moderator picks by time or one by one, gives one
 * reason for all, sees the cost, and confirms once. Each hide is its own
 * transition, signed one after another with one key entry
 * (`moderationService.openBatch`); the progress counts only what came back
 * proved. Closing it stops after the one under way, and opening it again
 * reads the chain afresh, so whatever is still showing is what is left.
 */
export function BulkHideModal() {
  const { user, controller } = useAuth()
  const { isOpen, target, close } = useBulkHideModal()
  const recordMarks = useBulkModeratedMarks((state) => state.record)
  const canAuthorize = useModerationAuthorization(isOpen)
  const seatedReasons = useSeatedReasons(isOpen, 'social')
  const [mode, setMode] = useState<BulkMode>('hide')
  const [list, setList] = useState<ListState>({ status: 'loading', count: 0 })
  /** How many each tab lists, once read: the open tab's from its list, the other's from a read of its own. */
  const [counts, setCounts] = useState<Record<BulkMode, number | null>>(NO_COUNTS)
  /** Moves on after a run, so both tabs are read again. */
  const [readEpoch, setReadEpoch] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [label, setLabel] = useState<number | null>(null)
  const [reasonDocumentId, setReasonDocumentId] = useState('')
  const [note, setNote] = useState('')
  const [progress, setProgress] = useState<BulkProgress | null>(null)
  const [summary, setSummary] = useState<BulkSummary | null>(null)
  const [running, setRunning] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [authorName, setAuthorName] = useState<string | null>(null)
  const stopRef = useRef(false)
  const readRef = useRef(0)
  /** Moves on with every opening and closing: a run started under another ignores itself. */
  const openingRef = useRef(0)
  const authorId = target?.authorId ?? ''

  useEffect(() => {
    openingRef.current++
    if (!isOpen || !target) return
    setRunning(false)
    setStopping(false)
    setMode('hide')
    setSelected(new Set())
    setLabel(target.label ?? null)
    setReasonDocumentId('')
    setNote(target.note ?? '')
    setProgress(null)
    setSummary(null)
    setCounts(NO_COUNTS)
    setAuthorName(target.authorName ?? null)
    if (!target.authorName) {
      // Only for this opening: a lookup that answers after the dialog was opened for someone else is dropped.
      const opening = openingRef.current
      dpnsService.resolveUsername(target.authorId).then((name) => {
        if (openingRef.current === opening && name) setAuthorName(`@${name.replace(/\.dash$/, '')}`)
      }).catch(() => { /* the dialog says "this account" */ })
    }
  }, [isOpen, target])

  /** Reads `which`'s lane afresh from the chain. A later read wins over an earlier one still out. */
  const load = useCallback((which: BulkMode) => {
    if (!authorId) return
    const read = ++readRef.current
    setList({ status: 'loading', count: 0 })
    bulkHideService.readAll(authorId, which, (count) => {
      if (readRef.current === read) setList({ status: 'loading', count })
    }).then(({ items, truncated }) => {
      if (readRef.current !== read) return
      setList({ status: 'ready', items, truncated })
      setCounts((current) => ({ ...current, [which]: items.length }))
      // What is no longer listed (done, or changed by someone else) drops out of the selection.
      setSelected((current) => new Set(items.filter((item) => current.has(item.id)).map((item) => item.id)))
    }).catch(() => {
      if (readRef.current === read) setList({ status: 'failed' })
    })
  }, [authorId])

  useEffect(() => {
    if (isOpen && authorId) load(mode)
  }, [isOpen, authorId, mode, load, readEpoch])

  // The other tab's count, so "Hidden (5)" is known before it is opened.
  useEffect(() => {
    if (!isOpen || !authorId) return
    const other: BulkMode = mode === 'hide' ? 'unhide' : 'hide'
    let cancelled = false
    bulkHideService.count(authorId, other).then((count) => {
      if (!cancelled) setCounts((current) => ({ ...current, [other]: count }))
    }).catch(() => { /* the tab shows no count */ })
    return () => {
      cancelled = true
    }
  }, [isOpen, authorId, mode, readEpoch])

  const options: readonly LabelOption[] = useMemo(
    () => (seatedReasons.required ? labelOptions(seatedReasons.reasons) : labelOptions(null)),
    [seatedReasons.required, seatedReasons.reasons]
  )

  if (!target) return null

  const items = list.status === 'ready' ? list.items : []
  const chosen = options.find((option) => option.label === label) ?? null
  const charterReasonId = mode === 'hide' ? chosen?.reasonDocumentId ?? '' : reasonDocumentId
  const selectedItems = items.filter((item) => selected.has(item.id))
  const name = authorName ?? 'this account'
  const reasonReady = !seatedReasons.loading && !seatedReasons.failed
    && (mode === 'unhide' || chosen !== null)
    && (!seatedReasons.required || charterReasonId !== '')
  const canRun = canAuthorize && !running && reasonReady && !!user

  const switchMode = (next: BulkMode) => {
    if (running || next === mode) return
    setMode(next)
    setSelected(new Set())
    setProgress(null)
    setSummary(null)
  }

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const reasonFor = (item: BulkItem): ModerationReasonInput => ({
    text: mode === 'hide'
      ? [chosen?.text, note.trim()].filter(Boolean).join(': ') || 'Hidden by the moderators'
      : note.trim() || 'Visible again',
    documents: [{ documentTypeName: item.kind, documentId: item.id }],
    ...(seatedReasons.required && charterReasonId ? { reasonDocumentId: charterReasonId } : {}),
  })

  const run = async (batchItems: BulkItem[]) => {
    if (!user || batchItems.length === 0) return
    const moderatorId = user.identityId
    // A run outlives its dialog only to finish the transition under way: once
    // it was closed (or opened again for someone else) it updates nothing.
    // It belongs to the sign-in it began in: any sign-out or sign-in since
    // (even back into the same account) moves the session epoch, and the run
    // signs nothing more with the key it holds.
    const opening = openingRef.current
    const epoch = controller.sessionEpoch()
    const sameOpening = () => openingRef.current === opening
    const sameSession = () => controller.sessionEpoch() === epoch && controller.getState().user?.identityId === moderatorId
    const current = () => sameOpening() && sameSession()
    /** After a run ends: false when nothing more is this run's to show (and a run whose sign-in ended closes the dialog). */
    const stillShown = () => {
      if (!sameOpening()) return false
      if (sameSession()) return true
      setRunning(false)
      setProgress(null)
      close()
      return false
    }
    stopRef.current = false
    setStopping(false)
    setRunning(true)
    setSummary(null)
    setProgress({ total: batchItems.length, done: 0, current: null, failures: [] })
    const opened = await moderationService.openBatch(moderatorId)
    if (!stillShown()) return
    if ('refused' in opened) {
      setRunning(false)
      setProgress(null)
      if (!closedKeySheet(opened.refused.errorCode)) toast.error(opened.refused.error || 'That did not go through. Try again.')
      return
    }
    const { batch } = opened
    const hideLabel = chosen?.label ?? 0
    const result = await runBulk(batchItems, {
      apply: (item) => mode === 'hide'
        ? batch.hide(item.kind, item.id, { label: hideLabel, reason: reasonFor(item) })
        : batch.unhide(item.kind, item.id, reasonFor(item)),
      pending: (pendingItems) => bulkHideService.pending(pendingItems, mode),
      // The cards already on screen show the change as soon as it is proved.
      onDone: (item) => recordMarks(item.id, mode === 'hide' ? { mod: MOD_HIDDEN, modLabel: hideLabel, moderatedBy: moderatorId, moderatedAt: Date.now() } : null),
      onProgress: (next) => {
        if (current()) setProgress(next)
      },
      cancelled: () => stopRef.current || !current(),
    })
    if (!stillShown()) return
    setSummary(result)
    setProgress(null)
    setRunning(false)
    setStopping(false)
    // Read what is left from the chain: done ones drop out, and what failed
    // or was never sent stays selected. Each change came back proved, but a
    // read can reach a node a block behind, so give the network a moment
    // first; the list reads as loading meanwhile, so nothing stale is offered.
    setSelected(new Set(batchItems.map((item) => item.id)))
    readRef.current++
    setList({ status: 'loading', count: 0 })
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
    if (current()) setReadEpoch((epoch) => epoch + 1)
  }

  const start = (batchItems: BulkItem[]) => {
    run(batchItems).catch(() => {
      setRunning(false)
      toast.error('That did not go through. Try again.')
    })
  }

  const stop = () => {
    stopRef.current = true
    setStopping(true)
  }

  const verb = mode === 'hide' ? 'Hide' : 'Unhide'
  const percent = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0
  // Failures still to do: once the lists are read again, one that landed after all drops out.
  const listed = new Set(items.map((item) => item.id))
  const failures = list.status === 'ready' ? (summary?.failures ?? []).filter((failure) => listed.has(failure.item.id)) : []

  return (
    <Modal open={isOpen} onOpenChange={(open) => !open && close()} className="w-[560px] max-w-[94vw] max-h-[90vh] overflow-y-auto">
      <ModalTitle>
        {mode === 'hide' ? <EyeSlashIcon className="h-6 w-6 text-amber-600" /> : <EyeIcon className="h-6 w-6 text-amber-600" />}
        {mode === 'hide' ? `Hide posts by ${name}` : `Unhide posts by ${name}`}
      </ModalTitle>
      <Dialog.Description className="text-sm text-gray-600 dark:text-gray-400 mb-3">
        {mode === 'hide'
          ? 'Pick the posts and replies to hide. They leave feeds, search and the profile for everyone. Nothing is deleted, and any moderator can unhide them.'
          : 'Pick the hidden posts and replies to show again.'}
      </Dialog.Description>
      <ModerationKeyNotice authorized={canAuthorize} />

      <div role="tablist" aria-label="Which posts" className="flex gap-1 mb-3 p-1 rounded-lg bg-gray-100 dark:bg-neutral-800">
        {(['hide', 'unhide'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={mode === tab}
            disabled={running}
            data-testid={`bulk-hide-tab-${tab}`}
            onClick={() => switchMode(tab)}
            className={cn(
              'flex-1 px-3 py-1.5 rounded-md text-sm font-medium transition-colors disabled:cursor-not-allowed',
              mode === tab ? 'bg-white dark:bg-neutral-900 shadow-sm text-gray-900 dark:text-gray-100' : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'
            )}
          >
            {tab === 'hide' ? 'Showing' : 'Hidden'}
            {counts[tab] !== null && <span className="tabular-nums"> ({counts[tab]?.toLocaleString()})</span>}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className="text-xs text-gray-500 dark:text-gray-400">Select:</span>
        {RANGES.map(({ range, text }) => (
          <button
            key={range}
            type="button"
            disabled={running || items.length === 0}
            data-testid={`bulk-hide-select-${range}`}
            onClick={() => setSelected(idsWithin(items, range))}
            className={cn(CHIP, 'border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800')}
          >
            {text}
          </button>
        ))}
        <button
          type="button"
          disabled={running || selectedItems.length === 0}
          onClick={() => setSelected(new Set())}
          className={cn(CHIP, 'border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800')}
        >
          None
        </button>
        <span className="ml-auto text-xs text-gray-600 dark:text-gray-400 tabular-nums" data-testid="bulk-hide-selected-count">
          {selectedItems.length.toLocaleString()} of {items.length.toLocaleString()} selected
        </span>
      </div>

      <div className="h-64 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-800 mb-3" data-testid="bulk-hide-list">
        {list.status === 'loading' && (
          <p className="p-4 text-sm text-gray-500">
            {list.count > 0 ? `Reading their posts… ${list.count.toLocaleString()} so far` : 'Reading their posts…'}
          </p>
        )}
        {list.status === 'failed' && (
          <div className="p-4 text-sm text-gray-600 dark:text-gray-400">
            Couldn&apos;t read their posts.{' '}
            <button type="button" className="text-yappr-600 hover:underline" onClick={() => load(mode)}>Try again</button>
          </div>
        )}
        {list.status === 'ready' && items.length === 0 && (
          <p className="p-4 text-sm text-gray-500">
            {mode === 'hide' ? `Nothing by ${name} is showing.` : `Nothing by ${name} is hidden.`}
          </p>
        )}
        {items.length > 0 && (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {items.map((item) => (
              <li key={item.id}>
                <label className={cn('flex items-start gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50 dark:hover:bg-neutral-800', running && 'cursor-not-allowed')}>
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 rounded border-gray-300 text-yappr-600 focus:ring-yappr-500"
                    checked={selected.has(item.id)}
                    disabled={running}
                    onChange={() => toggle(item.id)}
                    data-testid={`bulk-hide-item-${item.id}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs text-gray-500 dark:text-gray-400">
                      {item.kind === 'reply' ? 'Reply' : 'Post'} · {relativeTime(item.createdAt)}
                    </span>
                    <span className="block text-sm text-gray-800 dark:text-gray-200 line-clamp-2 break-words">
                      {item.preview || <span className="italic text-gray-500">No text</span>}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {list.status === 'ready' && list.truncated && (
          <p className="p-3 text-xs text-gray-500">Showing their newest {items.length.toLocaleString()}. Hide these, then open this again for the rest.</p>
        )}
      </div>

      {/* The reason row keeps its height in both tabs, so switching tabs moves nothing. */}
      <div className="h-20 mb-1">
        {seatedReasons.failed ? (
          <p role="alert" className="text-xs text-red-500">Could not read the moderation team&apos;s charter. Close and try again.</p>
        ) : mode === 'hide' ? (
          <>
            <label htmlFor="bulk-hide-reason" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Reason, for all of them (public)
            </label>
            <select
              id="bulk-hide-reason"
              value={label ?? ''}
              disabled={seatedReasons.loading || running}
              onChange={(e) => setLabel(e.target.value ? Number(e.target.value) : null)}
              className={INPUT}
            >
              <option value="">{seatedReasons.loading ? 'Reading the charter…' : 'Choose a reason…'}</option>
              {options.map((option) => <option key={option.label} value={option.label}>{option.text}</option>)}
            </select>
          </>
        ) : seatedReasons.loading ? (
          <p className="text-sm text-gray-500">Reading the charter…</p>
        ) : (
          <CharterReasonPicker id="bulk-hide-charter-reason" state={seatedReasons} value={reasonDocumentId} onChange={setReasonDocumentId} />
        )}
      </div>
      <label htmlFor="bulk-hide-note" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
        Note (optional, public)
      </label>
      <input
        id="bulk-hide-note"
        type="text"
        value={note}
        maxLength={500}
        disabled={running}
        onChange={(e) => setNote(e.target.value)}
        className={`${INPUT} mb-3`}
      />

      {/* One fixed-height status area, so nothing below it moves: the progress during a run; otherwise the last outcome, the cost of what is selected, and any failures. */}
      <div className="h-28 mb-3 text-sm flex flex-col" aria-live="polite" data-testid="bulk-hide-status">
        {running && progress ? (
          <>
            <p className="text-gray-700 dark:text-gray-300 tabular-nums">
              {stopping ? 'Stopping after this one…' : bulkStatusLine(mode, progress)}
            </p>
            <div className="mt-2 h-2 shrink-0 rounded-full bg-gray-200 dark:bg-gray-800 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
              <div className="h-full bg-yappr-500 transition-[width] duration-300" style={{ width: `${percent}%` }} />
            </div>
          </>
        ) : (
          <>
            {summary && <p className="text-gray-700 dark:text-gray-300 tabular-nums">{bulkStatusLine(mode, summary)}</p>}
            <p className="text-gray-600 dark:text-gray-400">{bulkCostLine(selectedItems.length, mode === 'hide' ? HIDE_FEE_CREDITS : UNHIDE_FEE_CREDITS)}</p>
            {failures.length > 0 && (
              <div className="mt-2 min-h-0 flex-1 flex flex-col" data-testid="bulk-hide-failures">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-medium text-red-600 dark:text-red-400">{plural(failures.length, 'post')} didn&apos;t go through</p>
                  <Button size="sm" variant="outline" disabled={!canRun} onClick={() => start(failures.map((failure) => failure.item))} data-testid="bulk-hide-retry">Try again</Button>
                </div>
                <ul className="mt-1 min-h-0 flex-1 overflow-y-auto text-xs text-gray-600 dark:text-gray-400 space-y-0.5">
                  {failures.map(({ item, error }) => (
                    <li key={item.id} className="truncate">{item.preview || (item.kind === 'reply' ? 'Reply' : 'Post')}: {error}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {running ? (
          <Button onClick={stop} variant="outline" disabled={stopping} className="w-full" data-testid="bulk-hide-stop">
            {stopping ? 'Stopping after this one…' : 'Stop'}
          </Button>
        ) : (
          <Button onClick={() => start(selectedItems)} disabled={!canRun || selectedItems.length === 0} className="w-full" data-testid="bulk-hide-confirm">
            {selectedItems.length > 0 ? `${verb} ${plural(selectedItems.length, 'post')}` : `${verb} posts`}
          </Button>
        )}
        <Button onClick={close} variant="ghost" className="w-full">Close</Button>
        <p className="text-xs text-center text-gray-500 dark:text-gray-400">
          You can close this at any time. What&apos;s done stays done, and opening it again picks up the rest.
        </p>
      </div>
    </Modal>
  )
}
