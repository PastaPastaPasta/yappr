'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ClipboardDocumentIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useSdk } from '@/contexts/sdk-context'
import { useCopy } from '@/hooks/use-copy'
import { logger } from '@/lib/logger'
import { cn } from '@/lib/utils'
import { createElectionStatusLoader } from '@/lib/election-status-loader'
import { moderationElectionService, type CharterProposal, type CharterReason, type ElectionStatus } from '@/lib/services/moderation-election-service'
import { dpnsService } from '@/lib/services/dpns-service'
import { charterService } from '@/lib/services/charter-service'
import type { CharterRole } from '@/lib/moderation-charters/charter-keys'
import { costTotal, formatCost, type CostLine, type CreateFees } from '@/lib/moderation-charters/costs'
import { charterActionError, type CharterAction } from '@/lib/moderation-charters/refusals'
import { chainOffsetMs, statusForContract, type ElectionStage } from '@/lib/moderation-charters/team-flow'

/** The election status of `contractId`, read once on mount and on `refresh()`. */
export function useElectionStatus(contractId: string) {
  const { isReady } = useSdk()
  const loader = useMemo(() => createElectionStatusLoader(() => moderationElectionService.getStatus(contractId)), [contractId])
  // Every answer and every read in flight is kept by the contract it is for, so a late
  // answer for a tab the viewer already left can never stand in for the current one.
  const [loaded, setLoaded] = useState<Record<string, { status: ElectionStatus | null; failed: boolean }>>({})
  const [reading, setReading] = useState<Record<string, number>>({})

  const refresh = useCallback(async () => {
    const requested = contractId
    const count = (delta: number) => setReading((previous) => ({ ...previous, [requested]: Math.max(0, (previous[requested] ?? 0) + delta) }))
    count(1)
    try {
      const result = await loader.load()
      setLoaded((previous) => ({ ...previous, [requested]: { status: result, failed: false } }))
    } catch (error) {
      logger.error('Moderation teams: election status read failed', error)
      setLoaded((previous) => ({ ...previous, [requested]: { status: previous[requested]?.status ?? null, failed: true } }))
    } finally {
      count(-1)
    }
  }, [contractId, loader])

  useEffect(() => {
    if (isReady) refresh().catch(() => { /* reported inside */ })
  }, [isReady, refresh])

  const current = loaded[contractId] ?? null
  return {
    status: statusForContract(current?.status ?? null, contractId),
    notElected: current !== null && !current.failed && current.status === null,
    loading: (reading[contractId] ?? 0) > 0,
    failed: current?.failed ?? false,
    refresh,
  }
}

/**
 * Chain time, carried forward by this device's clock every `intervalMs`: the
 * election's windows run on block time, so a device clock that is off never
 * moves the stage the page shows.
 */
export function useChainNow(status: ElectionStatus | null, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  // The offset is taken when the status arrives, the moment its chain time was current.
  const offset = useMemo(() => chainOffsetMs(status), [status])
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now + offset
}

/**
 * The fee of each charters write, priced for a charter of this shape (once the
 * shape has stood still for `debounceMs`); null until priced.
 */
export function useCreateFees(shape: { descriptionBytes: number; reasons: number; members: number }, debounceMs = 0): CreateFees | null {
  const { descriptionBytes, reasons, members } = shape
  const [fees, setFees] = useState<CreateFees | null>(null)
  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      charterService.createFees({ descriptionBytes, reasons, members })
        .then((value) => { if (live) setFees(value) })
        .catch((feeError: unknown) => logger.warn('Moderation teams: fees could not be priced', feeError))
    }, debounceMs)
    return () => { live = false; clearTimeout(timer) }
  }, [descriptionBytes, reasons, members, debounceMs])
  return fees
}

/**
 * `me`'s balance and whether they still need to set up their charter key of
 * `role` (each null while unknown), read again whenever `refreshOn` changes.
 */
export function useAccountReadiness(me: string | null, role: CharterRole, refreshOn: unknown) {
  const [balance, setBalance] = useState<bigint | null>(null)
  const [needsKey, setNeedsKey] = useState<boolean | null>(null)
  useEffect(() => {
    if (!me) return
    let live = true
    charterService.balance(me).then((value) => { if (live) setBalance(value) }).catch(() => { /* shown without */ })
    charterService.hasCharterKey(me, role).then((has) => { if (live) setNeedsKey(!has) }).catch(() => { /* priced as needed */ })
    return () => { live = false }
  }, [me, role, refreshOn])
  return { balance, needsKey, setNeedsKey }
}

/**
 * Runs charters writes with a progress label and an error message. A write the
 * person cancelled leaves no error. `run` resolves to the work's result, or to
 * undefined when it failed.
 */
export function useCharterRun() {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function run<T>(label: string | null, action: CharterAction, work: () => Promise<T>): Promise<T | undefined> {
    setBusy(label)
    setError(null)
    try {
      return await work()
    } catch (actionError) {
      const failure = charterActionError(action, actionError)
      if (failure.outcome !== 'cancelled') setError(failure.message)
      return undefined
    } finally {
      setBusy(null)
    }
  }

  return { busy, error, setBusy, setError, run }
}

const shortId = (id: string) => (id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id)

/** An identity by its username (or a shortened id while none is known), linking to its profile. */
export function IdentityName({ id, className }: { id: string; className?: string }) {
  const [name, setName] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    dpnsService.resolveUsername(id).then((resolved) => { if (live) setName(resolved) }).catch(() => { /* the short id stands */ })
    return () => { live = false }
  }, [id])
  return (
    <Link href={`/user/?id=${id}`} className={cn('font-medium hover:underline', className)} title={id}>
      {name ? `@${name.replace(/\.dash$/i, '')}` : shortId(id)}
    </Link>
  )
}

/** "3 d 4 h", "2 h 13 min", "4 min 10 s", "now". */
export function formatDuration(ms: number): string {
  if (ms <= 0) return 'now'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86_400), h = Math.floor((s % 86_400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  if (d > 0) return `${d} d ${h} h`
  if (h > 0) return `${h} h ${m} min`
  if (m > 0) return `${m} min ${sec} s`
  return `${sec} s`
}

/** A window length as people say it ("7 days", "1 hour", "10 minutes"). */
export function formatWindow(seconds: number): string {
  if (seconds >= 86_400 && seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? '' : 's'}`
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`
  if (seconds >= 60) return `${Math.round(seconds / 60)} minutes`
  return `${seconds} seconds`
}

export const formatWhen = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

const STAGE_LABELS: Record<ElectionStage['kind'], { label: string; tone: string }> = {
  'not-open': { label: 'Not open yet', tone: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300' },
  open: { label: 'Open for applications', tone: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300' },
  joining: { label: 'Applications closing', tone: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300' },
  voting: { label: 'Masternodes voting', tone: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300' },
  deciding: { label: 'Seating the winner', tone: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300' },
  seated: { label: 'Team seated', tone: 'bg-yappr-100 text-yappr-800 dark:bg-yappr-950 dark:text-yappr-300' },
  unknown: { label: 'Status unknown', tone: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300' },
}

export function StageBadge({ stage }: { stage: ElectionStage }) {
  const { label, tone } = STAGE_LABELS[stage.kind]
  return <span data-testid="election-stage" className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold', tone)}>{label}</span>
}

/** The chip a reason's three-letter code sits in. */
export function ReasonCode({ code }: { code: string }) {
  return <span className="font-mono text-xs rounded bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 mr-2">{code}</span>
}

function ReasonList({ proposal, reasons }: { proposal: CharterProposal; reasons: readonly CharterReason[] | null }) {
  if (reasons === null) return <p className="text-gray-500">Loading reasons…</p>
  if (reasons.length === 0) {
    return <p className="text-gray-500">{proposal.reasonIds.length === 0 ? 'None: this team could take no action.' : 'The reasons could not be read.'}</p>
  }
  return (
    <ul className="mt-1 space-y-1">
      {reasons.map((reason) => (
        <li key={reason.id}>
          <ReasonCode code={reason.code} />
          {reason.label}
          {reason.description && <span className="block text-gray-500 ml-12">{reason.description}</span>}
        </li>
      ))}
    </ul>
  )
}

function moderatorsShareText(share: number | null): string {
  if (share === null) return '100% (the full fee)'
  if (share === 0) return '0%: will not moderate or take rewards'
  return `${share}% of each moderators fee`
}

/** A charter's terms: what the team would moderate, its reasons, and how rewards are paid. */
export function CharterTerms({ proposal, reasons }: { proposal: CharterProposal; reasons: readonly CharterReason[] | null }) {
  return (
    <div className="space-y-3 text-sm">
      <p className="whitespace-pre-wrap break-words">{proposal.description}</p>
      <div>
        <h4 className="font-semibold">Reasons the team may act on</h4>
        <ReasonList proposal={proposal} reasons={reasons} />
      </div>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div>
          <dt className="text-gray-500">Moderators&apos; share</dt>
          <dd>{moderatorsShareText(proposal.moderatorsShare)}</dd>
        </div>
        {proposal.rewardSplit && (
          <div>
            <dt className="text-gray-500">Reward split</dt>
            <dd>Leader {proposal.rewardSplit.leader}% · shared equally {proposal.rewardSplit.equal}% · by actions {proposal.rewardSplit.actions}%</dd>
          </div>
        )}
      </dl>
    </div>
  )
}

/** The cost of an action, line by line, with its total and the viewer's balance. */
export function CostPreview({ lines, balance, loading }: { lines: readonly CostLine[] | null; balance: bigint | null; loading?: boolean }) {
  if (!lines) return <p className="text-sm text-gray-500">{loading ? 'Working out the cost…' : 'The cost could not be worked out.'}</p>
  const total = costTotal(lines)
  return (
    <div data-testid="cost-preview" className="rounded-lg border border-gray-200 dark:border-gray-800 p-3 text-sm">
      <table className="w-full">
        <tbody>
          {lines.map((line) => (
            <tr key={line.label}>
              <td className="py-0.5 pr-2">{line.label}</td>
              <td className={cn('py-0.5 text-right whitespace-nowrap', line.deposit && 'font-semibold')}>{formatCost(line.credits)}</td>
            </tr>
          ))}
          <tr className="border-t border-gray-200 dark:border-gray-800 font-semibold">
            <td className="pt-1.5">Total, about</td>
            <td className="pt-1.5 text-right whitespace-nowrap">{formatCost(total)}</td>
          </tr>
        </tbody>
      </table>
      {balance !== null && (
        <p className={cn('mt-2 text-xs', balance < total ? 'text-red-600 dark:text-red-400' : 'text-gray-500')}>
          Your balance: {formatCost(balance)}{balance < total ? '. That is not enough for this.' : ''}
        </p>
      )}
      <p className="mt-1 text-xs text-gray-500">Fees are estimates; cents are at $60 per DASH.</p>
    </div>
  )
}

export function Section({ title, children, className, testId }: { title?: string; children: React.ReactNode; className?: string; testId?: string }) {
  return (
    <section data-testid={testId} className={cn('border-b border-gray-200 dark:border-gray-800 p-4 space-y-3', className)}>
      {title && <h2 className="text-lg font-bold">{title}</h2>}
      {children}
    </section>
  )
}

const NOTICE_TONES = {
  info: 'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200',
  error: 'border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300',
  success: 'border-green-300 bg-green-50 text-green-900 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200',
  warn: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200',
}

export function Notice({ tone = 'info', children, testId }: { tone?: keyof typeof NOTICE_TONES; children: React.ReactNode; testId?: string }) {
  return <div role={tone === 'error' ? 'alert' : 'status'} data-testid={testId} className={cn('rounded-lg border p-3 text-sm', NOTICE_TONES[tone])}>{children}</div>
}

/** What a form field says when it fails its check; nothing while `message` is empty. */
export function FieldError({ message }: { message?: string }) {
  return message ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{message}</p> : null
}

/** A small line under a field, red when `bad`. */
export function Hint({ bad, children }: { bad: boolean; children: React.ReactNode }) {
  return <p className={bad ? 'text-xs text-red-600' : 'text-xs text-gray-500'}>{children}</p>
}

/** The link a leader shares so members can ask to join, with a button that copies it. */
export function InviteLink({ url }: { url: string }) {
  const copy = useCopy()
  return (
    <div className="flex gap-2">
      <Input readOnly value={url} className="font-mono text-xs" data-testid="invite-link" onFocus={(e) => e.currentTarget.select()} />
      <Button variant="outline" className="gap-1 shrink-0" onClick={() => copy(url, 'Invite link copied')}><ClipboardDocumentIcon className="h-4 w-4" /> Copy</Button>
    </div>
  )
}
