'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { ChevronDownIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { SettingsSwitch } from '@/components/settings/settings-switch'
import { useQueryInspectorStore } from '@/lib/query-inspector/store'
import {
  POLLR_CONTRACT_ID,
  YAPPR_BLOG_CONTRACT_ID,
  YAPPR_CONTRACT_ID,
  YAPPR_DM_V5_CONTRACT_ID,
  YAPPR_STOREFRONT_CONTRACT_ID,
  getConfiguredNetwork,
  getContractTopology,
} from '@/lib/constants'
import toast from 'react-hot-toast'

function formatBuildDate(value: string | undefined): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function BuildRow({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-3 py-1.5">
      <dt className="text-gray-500">{label}</dt>
      <dd className="min-w-0 break-all font-mono text-gray-800 dark:text-gray-200" data-testid={testId}>
        {children}
      </dd>
    </div>
  )
}

/**
 * What this build was compiled against: the network, the commit and the
 * contracts it talks to. Collapsed by default; the e2e suite opens it to check
 * that the served artifact targets the contracts under test.
 */
function BuildDetails() {
  const contracts = [
    { label: 'Social', id: YAPPR_CONTRACT_ID },
    { label: 'Messages', id: YAPPR_DM_V5_CONTRACT_ID },
    { label: 'Store', id: YAPPR_STOREFRONT_CONTRACT_ID },
    { label: 'Blog', id: YAPPR_BLOG_CONTRACT_ID },
    { label: 'Polls', id: POLLR_CONTRACT_ID },
  ].filter(({ id }) => id)
  const builtAt = formatBuildDate(process.env.NEXT_PUBLIC_GIT_COMMIT_DATE)

  return (
    <details className="group rounded-lg border border-gray-200 dark:border-gray-800" data-testid="build-details">
      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 font-medium [&::-webkit-details-marker]:hidden">
        Build details
        <ChevronDownIcon className="h-4 w-4 text-gray-500 transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <dl className="border-t border-gray-200 px-4 py-3 text-sm dark:border-gray-800">
        <BuildRow label="Network">{getConfiguredNetwork()}</BuildRow>
        <BuildRow label="Commit" testId="build-commit">{process.env.NEXT_PUBLIC_GIT_COMMIT_HASH || 'dev'}</BuildRow>
        <BuildRow label="Branch">{process.env.NEXT_PUBLIC_GIT_BRANCH || 'unknown'}</BuildRow>
        {builtAt && <BuildRow label="Committed">{builtAt}</BuildRow>}
        {/* The contract id does not say which SHAPE of contract it is, and a
            client compiled for one shape queries fields another lacks. Printing
            the compiled-in topology makes that checkable from the served build. */}
        <BuildRow label="Topology" testId="build-topology">{getContractTopology()}</BuildRow>
        {contracts.map(({ label, id }) => (
          <BuildRow key={label} label={`${label} contract`}>{id}</BuildRow>
        ))}
      </dl>
      <div className="border-t border-gray-200 px-4 py-3 dark:border-gray-800">
        <Link href="/contract" className="text-sm font-medium text-yappr-700 hover:underline dark:text-yappr-400">
          View the social data contract
        </Link>
      </div>
    </details>
  )
}

export function DeveloperSettings() {
  const enabled = useQueryInspectorStore((s) => s.enabled)
  const setEnabled = useQueryInspectorStore((s) => s.setEnabled)
  const totalCaptured = useQueryInspectorStore((s) => s.totalCaptured)
  const clear = useQueryInspectorStore((s) => s.clear)

  return (
    <div className="p-6 space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Query inspector</CardTitle>
          <CardDescription>
            Watch every Dash Platform request this app makes, live — the query, the response,
            and the cryptographic proof it arrived with.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Enable query inspector</p>
              <p className="text-sm text-gray-500">
                Shows a live console in the bottom-right corner on every page
              </p>
            </div>
            <SettingsSwitch
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label="Enable query inspector"
            />
          </div>
          <div className="flex items-center justify-between border-t border-gray-200 dark:border-gray-800 pt-4">
            <div>
              <p className="font-medium">Captured queries</p>
              <p className="text-sm text-gray-500">
                {totalCaptured} captured this session (newest 300 kept)
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={totalCaptured === 0}
              onClick={() => {
                clear()
                toast.success('Captured queries cleared')
              }}
            >
              Clear
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4">
        <h4 className="font-medium mb-2 text-sm">How it works:</h4>
        <ul className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
          <li className="flex gap-2">
            <span className="text-yappr-500">&bull;</span>
            Every read is served with a GroveDB proof and verified in your browser — the
            inspector shows what&apos;s normally discarded after verification
          </li>
          <li className="flex gap-2">
            <span className="text-yappr-500">&bull;</span>
            Proofs open directly in the GroveDB proof visualizer for a tree-level view
          </li>
          <li className="flex gap-2">
            <span className="text-yappr-500">&bull;</span>
            Toggle from anywhere with{' '}
            <code className="text-xs bg-gray-100 dark:bg-gray-800 px-1 rounded">
              Ctrl+Shift+Y
            </code>
          </li>
          <li className="flex gap-2">
            <span className="text-yappr-500">&bull;</span>
            Captured data stays in memory on this device and is gone on reload
          </li>
        </ul>
      </div>

      <BuildDetails />
    </div>
  )
}
