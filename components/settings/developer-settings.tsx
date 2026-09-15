'use client'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { SettingsSwitch } from '@/components/settings/settings-switch'
import { useQueryInspectorStore } from '@/lib/query-inspector/store'
import toast from 'react-hot-toast'

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
    </div>
  )
}
