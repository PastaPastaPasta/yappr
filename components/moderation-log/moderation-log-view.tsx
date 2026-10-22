'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeftIcon, ChevronRightIcon, ClipboardDocumentListIcon } from '@heroicons/react/24/outline'
import { PageHeader, PageShell } from '@/components/layout/page-shell'
import { Button } from '@/components/ui/button'
import { ScrollTabs } from '@/components/ui/scroll-tabs'
import { useSdk } from '@/contexts/sdk-context'
import { logger } from '@/lib/logger'
import type { LaneCursor } from '@/lib/moderation-lanes'
import { dpnsService } from '@/lib/services/dpns-service'
import {
  ModerationLogReader,
  actionText,
  availableLogContracts,
  reasonText,
  type LogContract,
  type LogRow,
} from '@/lib/services/moderation-log-service'

/**
 * A row's reason as words (`reasonText`: the charter, read once per session,
 * or the warning's own text). Null while it is read, and when nothing
 * resolves it: never a bare number.
 */
function useRowReason(contract: LogContract, row: Pick<LogRow, 'reasonCode' | 'reasonText'>): string | null {
  const [reason, setReason] = useState<string | null>(row.reasonText)
  const { reasonCode, reasonText: text } = row
  useEffect(() => {
    let cancelled = false
    reasonText(contract, { reasonCode, reasonText: text }).then((resolved) => {
      if (!cancelled) setReason(resolved)
    }).catch((error: unknown) => logger.warn('ModerationLog: could not word a reason', error))
    return () => {
      cancelled = true
    }
  }, [contract, reasonCode, text])
  return reason
}

const CONTRACT_LABELS: Record<LogContract, string> = { social: 'Social', blog: 'Blogs', storefront: 'Stores' }
/** One row's height. Skeleton rows and real rows share it, so the list does not jump when the page loads. */
const ROW_CLASS = 'block min-h-[88px] border-b border-gray-200 px-4 py-3 dark:border-gray-800'
const SKELETON_ROWS = 6

const formatLogTime = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const shortId = (id: string) => (id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-6)}` : id)

type Names = ReadonlyMap<string, string | null>

/** `@name`, or a shortened id while the name is unknown. */
function nameOf(id: string, names: Names): string {
  const name = names.get(id)
  return name ? `@${name}` : shortId(id)
}

/** Who did it and to whom, as one line. A warning stores no moderator. */
function whoText(row: LogRow, names: Names): string {
  const by = row.action === 'warned' ? 'the team' : row.moderatorId ? nameOf(row.moderatorId, names) : null
  const subject = row.subjectId ? nameOf(row.subjectId, names) : null
  const target = row.action === 'hidden' || row.action === 'legalHold' ? 'Author' : 'Account'
  return [by ? `By ${by}` : null, subject ? `${target} ${subject}` : null].filter(Boolean).join(' · ')
}

function LogRowItem({ contract, row, names }: { contract: LogContract; row: LogRow; names: Names }) {
  const reason = useRowReason(contract, row)
  const body = (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="font-semibold text-gray-900 dark:text-white">{actionText(row)}</p>
          <time dateTime={new Date(row.at).toISOString()} className="shrink-0 text-xs text-gray-500">{formatLogTime(row.at)}</time>
        </div>
        <p className="truncate text-sm text-gray-600 dark:text-gray-400">{whoText(row, names)}</p>
        <p className="truncate text-sm text-gray-500">{reason ?? (row.reasonCode === null && !row.reasonText ? 'No reason given' : ' ')}</p>
      </div>
      {row.href && <ChevronRightIcon className="h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />}
    </div>
  )
  // Only a row that goes somewhere looks like it does.
  return row.href
    ? <Link href={row.href} data-testid="moderation-log-row" className={`${ROW_CLASS} transition-colors hover:bg-gray-50 dark:hover:bg-gray-900/60`}>{body}</Link>
    : <div data-testid="moderation-log-row" className={ROW_CLASS}>{body}</div>
}

function SkeletonRows() {
  return (
    <div aria-hidden="true" data-testid="moderation-log-skeleton">
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <div key={index} className={`${ROW_CLASS} animate-pulse`}>
          <div className="flex justify-between gap-3">
            <div className="h-5 w-40 rounded bg-gray-200 dark:bg-gray-800" />
            <div className="h-4 w-24 rounded bg-gray-200 dark:bg-gray-800" />
          </div>
          <div className="mt-1.5 h-4 w-3/5 rounded bg-gray-200 dark:bg-gray-800" />
          <div className="mt-1.5 h-4 w-2/5 rounded bg-gray-200 dark:bg-gray-800" />
        </div>
      ))}
    </div>
  )
}

interface LogState {
  rows: LogRow[]
  cursors: LaneCursor[]
  more: boolean
  /** First page in flight. */
  loading: boolean
  /** A later page in flight. */
  loadingMore: boolean
  failed: boolean
}

/** One contract's log: the first page on mount, the next on "Load more", names filled in as they resolve. */
function ContractLog({ contract }: { contract: LogContract }) {
  const { isReady: sdkReady, error: sdkError } = useSdk()
  const reader = useMemo(() => new ModerationLogReader(contract), [contract])
  const [state, setState] = useState<LogState>({ rows: [], cursors: [], more: false, loading: true, loadingMore: false, failed: false })
  const [names, setNames] = useState<Names>(new Map())
  // The newest request wins: a retry or a contract switch must not be overwritten by a slow older answer.
  const request = useRef(0)
  // False once the view is gone, so a read that outlives it sets nothing.
  const alive = useRef(false)

  const load = useCallback((from: LaneCursor[] | null) => {
    const mine = ++request.current
    setState((s) => ({ ...s, loading: from === null, loadingMore: from !== null, failed: false }))
    reader.page(from ?? reader.initialCursors()).then((page) => {
      if (mine !== request.current || !alive.current) return
      setState((s) => {
        const known = new Set(from === null ? [] : s.rows.map((row) => row.key))
        const fresh = page.rows.filter((row) => !known.has(row.key))
        return { rows: from === null ? fresh : [...s.rows, ...fresh], cursors: page.cursors, more: page.more, loading: false, loadingMore: false, failed: false }
      })
    }).catch((error: unknown) => {
      logger.error(`ModerationLog(${contract}): could not read the log`, error)
      if (mine === request.current && alive.current) setState((s) => ({ ...s, loading: false, loadingMore: false, failed: true }))
    })
  }, [reader, contract])

  useEffect(() => {
    if (!sdkReady) return
    alive.current = true
    load(null)
    return () => {
      alive.current = false
    }
  }, [sdkReady, reader, load])

  useEffect(() => {
    const wanted = state.rows.flatMap((row) => [row.moderatorId, row.subjectId]).filter((id): id is string => !!id && !names.has(id))
    if (wanted.length === 0) return
    let cancelled = false
    dpnsService.resolveUsernamesBatch(wanted).then((resolved) => {
      if (!cancelled) setNames((current) => new Map([...current, ...resolved]))
    }).catch((error: unknown) => logger.warn('ModerationLog: could not resolve names', error))
    return () => {
      cancelled = true
    }
  }, [state.rows, names])

  const stuck = !sdkReady && sdkError !== null
  const retry = () => load(state.rows.length > 0 && !state.loading ? state.cursors : null)

  return (
    <div data-testid="moderation-log">
      <p className="border-b border-gray-200 px-4 py-3 text-sm text-gray-600 dark:border-gray-800 dark:text-gray-400">
        Posts and replies moderators have hidden, and accounts they&apos;ve restricted or warned, newest first. Unhidden items drop off the list.
      </p>
      {!stuck && (state.loading || !sdkReady) && state.rows.length === 0 && <SkeletonRows />}
      {state.rows.map((row) => <LogRowItem key={row.key} contract={contract} row={row} names={names} />)}
      {sdkReady && !state.loading && !state.failed && state.rows.length === 0 && (
        <p data-testid="moderation-log-empty" className="px-4 py-10 text-center text-gray-500">Nothing here yet.</p>
      )}
      {(state.failed || stuck) && (
        <div role="alert" className="m-4 flex items-center justify-between gap-3 rounded-lg border border-red-200 p-3 text-sm text-red-700 dark:border-red-900 dark:text-red-300">
          <span>Couldn&apos;t load the log.</span>
          <Button variant="outline" size="sm" onClick={retry} disabled={stuck}>Try again</Button>
        </div>
      )}
      {state.more && !state.failed && (
        <div className="flex justify-center p-4">
          <Button variant="outline" onClick={() => load(state.cursors)} disabled={state.loadingMore} data-testid="moderation-log-more">
            {state.loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * The moderation log (`/moderation-log`, built only with
 * `NEXT_PUBLIC_MODERATION_LOG=1`; docs/ARCHIVE_FRONTEND.md): one tab per
 * contract this build can read the log of (`?contract=social|blog|storefront`).
 * On a build whose contracts predate the log, it says so.
 */
export function ModerationLogView() {
  const router = useRouter()
  const params = useSearchParams()
  const available = useMemo(availableLogContracts, [])
  const requested = params.get('contract')
  const contract = available.find((candidate) => candidate === requested) ?? available[0] ?? null

  return (
    <PageShell>
      <PageHeader borderless={available.length > 1}>
        <div className="flex items-center gap-4 p-4">
          <Link href="/" aria-label="Back to Yappr" className="-ml-2 rounded-full p-2 transition-colors hover:bg-gray-100 dark:hover:bg-gray-900">
            <ArrowLeftIcon className="h-5 w-5" />
          </Link>
          <h1 className="flex items-center gap-2 text-xl font-bold">
            <ClipboardDocumentListIcon className="h-5 w-5 text-yappr-500" aria-hidden="true" />
            Moderation log
          </h1>
        </div>
        {available.length > 1 && contract && (
          <ScrollTabs
            ariaLabel="Moderation log"
            testIdPrefix="moderation-log-tab"
            tabs={available.map((key) => ({ key, label: CONTRACT_LABELS[key] }))}
            active={contract}
            onSelect={(key) => router.replace(`/moderation-log?contract=${key}`)}
          />
        )}
      </PageHeader>
      {contract
        ? <ContractLog key={contract} contract={contract} />
        : <p data-testid="moderation-log-unavailable" className="px-4 py-10 text-center text-gray-500">The moderation log isn&apos;t available for this network.</p>}
    </PageShell>
  )
}
