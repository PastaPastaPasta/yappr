'use client'

import { Button } from '@/components/ui/button'
import { useDpnsRegistration } from '@/hooks/use-dpns-registration'
import { CheckCircle2, AlertTriangle, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDpnsCost, shortBalanceMessage, type DpnsQuote } from '@/lib/dpns/registration-quote'
import type { UsernameEntry, UsernameStatus } from '@/lib/types'

interface ReviewStepProps {
  onBack: () => void
  onRegister: () => void
  hasExistingUsernames?: boolean
}

function getStatusIcon(status: UsernameStatus): React.ReactNode {
  switch (status) {
    case 'available':
      return <CheckCircle2 className="w-5 h-5 text-green-500" />
    case 'contested':
      return <AlertTriangle className="w-5 h-5 text-orange-500" />
    default:
      return <XCircle className="w-5 h-5 text-red-500" />
  }
}

function getStatusText(status: UsernameStatus): string {
  switch (status) {
    case 'available':
      return 'Available'
    case 'contested':
      return 'Goes to a vote'
    case 'taken':
      return 'Taken'
    case 'invalid':
      return 'Invalid'
    default:
      return 'Unknown'
  }
}

function getStatusTextClass(status: UsernameStatus): string {
  switch (status) {
    case 'available':
      return 'text-green-600'
    case 'contested':
      return 'text-orange-600'
    default:
      return 'text-red-600'
  }
}

/** One line of the cost summary. */
function CostRow({ label, value, strong }: { label: React.ReactNode; value: string; strong?: boolean }): React.ReactNode {
  return (
    <div className={cn('flex items-baseline justify-between gap-4 text-sm', strong && 'font-semibold')}>
      <span className={strong ? undefined : 'text-gray-600 dark:text-gray-400'}>{label}</span>
      <span className="text-right tabular-nums">{value}</span>
    </div>
  )
}

/**
 * What registering costs, before the user confirms: each vote deposit (the
 * most that name pays into its vote), the network fees and the total, checked
 * against the balance.
 */
function CostSummary({ quote, balance }: { quote: DpnsQuote; balance: bigint }): React.ReactNode {
  const deposits = quote.names.filter((name) => name.contestFund !== null)
  const short = shortBalanceMessage(balance, quote.total)
  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-2" data-testid="dpns-cost-summary">
      <h3 className="font-semibold text-sm mb-1">Cost</h3>
      {deposits.map((name) => (
        <CostRow
          key={name.label}
          label={<>Vote deposit for <code>{name.label}.dash</code></>}
          value={formatDpnsCost(name.contestFund?.credits ?? 0n)}
        />
      ))}
      <CostRow label="Network fees" value={`about ${formatDpnsCost(quote.fees)}`} />
      <div className="border-t border-gray-200 dark:border-gray-700 pt-2">
        <CostRow label="Total" value={formatDpnsCost(quote.total)} strong />
      </div>
      <CostRow label="Your balance" value={formatDpnsCost(balance)} />
      {short && (
        <p className="text-sm text-red-600 dark:text-red-400 pt-1" role="alert">
          {short}
        </p>
      )}
    </div>
  )
}

/** A short name's vote, in plain words, with the deposit it holds. */
function ContestedExplanation({ quote, entries }: { quote: DpnsQuote; entries: UsernameEntry[] }): React.ReactNode {
  const deposits = quote.names.filter((name) => name.contestFund !== null && entries.some((entry) => entry.label === name.label))
  if (deposits.length === 0) return null
  const first = deposits[0]
  const one = deposits.length === 1
  return (
    <p className="text-sm text-orange-700 dark:text-orange-300">
      {one ? (
        <>
          <code>{first.label}.dash</code> is a short name, so registering it starts a community vote and holds a{' '}
          <strong>{formatDpnsCost(first.contestFund?.credits ?? 0n)}</strong> deposit in that vote.
        </>
      ) : (
        <>Short names start a community vote, and registering each one holds the deposit shown above in its vote.</>
      )}{' '}
      The deposit pays for the vote and isn&apos;t refunded, even if the vote picks someone else. No more than the
      deposit shown is ever paid into the vote.
    </p>
  )
}

export function ReviewStep({ onBack, onRegister, hasExistingUsernames }: ReviewStepProps): React.ReactNode {
  const {
    usernames,
    contestedAcknowledged,
    setContestedAcknowledged,
    quote,
  } = useDpnsRegistration()

  const availableUsernames = usernames.filter(
    (u) => u.status === 'available' || u.status === 'contested'
  )
  const nonContestedUsernames = usernames.filter((u) => u.status === 'available')
  const contestedUsernames = usernames.filter((u) => u.status === 'contested')
  const ready = quote.status === 'ready' ? quote : null
  const depositOf = (label: string) => ready?.quote.names.find((name) => name.label === label)?.contestFund?.credits ?? null
  const affordable = ready !== null && ready.balance >= ready.quote.total

  // Only show contested warning if user has no existing usernames to fall back on
  const allContestedWarning = availableUsernames.length > 0 && nonContestedUsernames.length === 0 && !hasExistingUsernames
  const canProceed = availableUsernames.length > 0 && affordable && (!allContestedWarning || contestedAcknowledged)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-2">Review Usernames</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {availableUsernames.length} of {usernames.length} username
          {usernames.length !== 1 ? 's' : ''} can be registered.
        </p>
      </div>

      {/* Results table */}
      <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 dark:bg-gray-800">
            <tr>
              <th className="px-4 py-2 text-left text-sm font-medium text-gray-500">
                Username
              </th>
              <th className="px-4 py-2 text-left text-sm font-medium text-gray-500">
                Status
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {usernames
              .filter((u) => u.label.trim())
              .map((entry) => {
                const deposit = entry.status === 'contested' ? depositOf(entry.label) : null
                return (
                  <tr key={entry.id}>
                    <td className="px-4 py-3">
                      <code className="text-sm bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded">
                        {entry.label}.dash
                      </code>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {getStatusIcon(entry.status)}
                        <span className={cn('text-sm', getStatusTextClass(entry.status))}>
                          {getStatusText(entry.status)}
                        </span>
                      </div>
                      {deposit !== null && (
                        <div className="text-xs text-orange-600 mt-1">{formatDpnsCost(deposit)} deposit</div>
                      )}
                    </td>
                  </tr>
                )
              })}
          </tbody>
        </table>
      </div>

      {availableUsernames.length > 0 && quote.status === 'failed' && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          We couldn&apos;t read what registering costs right now, so nothing can be registered yet. Go back and check
          the names again.
        </p>
      )}

      {availableUsernames.length > 0 && ready && <CostSummary quote={ready.quote} balance={ready.balance} />}

      {/* Contested warning - only shown when ALL usernames are contested */}
      {allContestedWarning ? (
        <div className="border-2 border-orange-400 bg-orange-50 dark:bg-orange-900/20 rounded-lg p-4 space-y-3">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-6 h-6 text-orange-500 flex-shrink-0 mt-0.5" />
            <div className="space-y-2">
              <h3 className="font-semibold text-orange-800 dark:text-orange-200">
                {contestedUsernames.length > 1 ? 'These names go' : 'This name goes'} to a community vote
              </h3>
              {ready && <ContestedExplanation quote={ready.quote} entries={contestedUsernames} />}
              <p className="text-sm text-orange-700 dark:text-orange-300">
                <strong>Until the vote is decided, people will see your account without a username.</strong>{' '}
                To be known by a name right away, add one with a number in it (like alex2) or one
                that&apos;s 20 characters or longer.
              </p>
            </div>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={contestedAcknowledged}
              onChange={(e) => setContestedAcknowledged(e.target.checked)}
              className="w-4 h-4 rounded border-orange-400 text-orange-600 focus:ring-orange-500"
            />
            <span className="text-sm text-orange-800 dark:text-orange-200">
              I understand my username won&apos;t show until the vote is decided
            </span>
          </label>
        </div>
      ) : (
        contestedUsernames.length > 0 && ready && (
          <div className="border border-orange-300 bg-orange-50 dark:bg-orange-900/20 rounded-lg p-4">
            <ContestedExplanation quote={ready.quote} entries={contestedUsernames} />
          </div>
        )
      )}

      {availableUsernames.length === 0 && (
        <div className="text-center py-4 text-gray-600 dark:text-gray-400">
          No usernames available to register. Please go back and try different usernames.
        </div>
      )}

      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack} className="flex-1">
          Back to Edit
        </Button>
        <Button onClick={onRegister} disabled={!canProceed} className="flex-1">
          Register {availableUsernames.length} Username
          {availableUsernames.length !== 1 ? 's' : ''}
        </Button>
      </div>
    </div>
  )
}
