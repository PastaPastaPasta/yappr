'use client'

import * as Tabs from '@radix-ui/react-tabs'
import { ArrowLeftIcon } from '@heroicons/react/24/outline'
import type { QueryRecord, ResponseMetadataDetails } from '@/lib/query-inspector/types'
import { JsonBlock } from './json-block'
import { PanelIconButton } from './panel-icon-button'
import { ProofChip } from './proof-chip'
import { ProofView } from './proof-view'

const TABS = [
  { value: 'query', label: 'Query' },
  { value: 'result', label: 'Result' },
  { value: 'metadata', label: 'Metadata' },
  { value: 'proof', label: 'Proof' },
]

export function EntryDetail({ record, onBack }: { record: QueryRecord; onBack: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-gray-200 dark:border-neutral-800 px-2 py-2">
        <PanelIconButton onClick={onBack} label="Back to query list">
          <ArrowLeftIcon className="h-4 w-4" />
        </PanelIconButton>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-mono text-xs font-medium text-gray-900 dark:text-gray-100">
              {record.method}
            </span>
            <ProofChip record={record} />
          </div>
          <p className="font-mono text-[10px] text-gray-500">
            {new Date(record.timestamp).toLocaleTimeString('en-US', { hour12: false })} ·{' '}
            {Math.round(record.durationMs)}ms · {record.kind}
          </p>
        </div>
      </div>

      <Tabs.Root defaultValue="query" className="flex min-h-0 flex-1 flex-col">
        <Tabs.List className="flex shrink-0 gap-4 border-b border-gray-200 dark:border-neutral-800 px-4">
          {TABS.map((tab) => (
            <Tabs.Trigger
              key={tab.value}
              value={tab.value}
              className="border-b-2 border-transparent pb-2 pt-2 font-mono text-[11px] text-gray-500 transition-colors data-[state=active]:border-yappr-500 data-[state=active]:text-gray-900 dark:data-[state=active]:text-gray-100"
            >
              {tab.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <Tabs.Content value="query" className="flex-1 overflow-y-auto p-4">
          {record.status === 'error' && (
            <div className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 font-mono text-[11px] text-red-600 dark:text-red-400 break-all">
              {record.error}
            </div>
          )}
          <JsonBlock value={record.params} />
        </Tabs.Content>

        <Tabs.Content value="result" className="flex-1 overflow-y-auto p-4">
          <p className="mb-2 font-mono text-[11px] text-gray-500">{record.resultSummary}</p>
          <JsonBlock value={record.result ?? null} />
        </Tabs.Content>

        <Tabs.Content value="metadata" className="flex-1 overflow-y-auto p-4">
          {record.metadata ? (
            <MetadataRows metadata={record.metadata} />
          ) : (
            <p className="py-8 text-center text-xs text-gray-500">
              No response metadata — this call type doesn&apos;t return proven metadata.
            </p>
          )}
        </Tabs.Content>

        <Tabs.Content value="proof" className="flex-1 overflow-y-auto p-4">
          <ProofView record={record} />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  )
}

function MetadataRows({ metadata }: { metadata: ResponseMetadataDetails }) {
  const blockTime = Number(metadata.timeMs)
  const rows = [
    {
      label: 'Platform height',
      value: metadata.height,
      note: 'Platform block height this response was proven at.',
    },
    {
      label: 'Epoch',
      value: String(metadata.epoch),
      note: 'Platform epoch — the fee and validator-set period.',
    },
    {
      label: 'Block time',
      value: Number.isFinite(blockTime)
        ? `${new Date(blockTime).toLocaleString('en-US', { hour12: false })} (${metadata.timeMs}ms)`
        : `${metadata.timeMs}ms`,
      note: 'Timestamp of the Platform block that anchors this response.',
    },
    {
      label: 'Protocol version',
      value: String(metadata.protocolVersion),
      note: 'Platform protocol version that produced this response.',
    },
    {
      label: 'Core chain-locked height',
      value: String(metadata.coreChainLockedHeight),
      note: 'Dash Core chain height locked into this Platform block.',
    },
    {
      label: 'Chain ID',
      value: metadata.chainId,
      note: 'Network identity of the chain that served the response.',
    },
  ]
  return (
    <div>
      {rows.map((row) => (
        <div
          key={row.label}
          className="border-b border-gray-100 dark:border-neutral-900 py-2 last:border-0"
        >
          <div className="flex items-baseline justify-between gap-4">
            <span className="shrink-0 text-xs text-gray-500">{row.label}</span>
            <span className="break-all text-right font-mono text-xs text-gray-900 dark:text-gray-100">
              {row.value}
            </span>
          </div>
          <p className="mt-0.5 text-[10px] text-gray-400 dark:text-gray-600">{row.note}</p>
        </div>
      ))}
    </div>
  )
}
