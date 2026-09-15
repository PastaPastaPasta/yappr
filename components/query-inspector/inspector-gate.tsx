'use client'

import dynamic from 'next/dynamic'
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { useQueryInspectorStore } from '@/lib/query-inspector/store'

// The inspector UI is only pulled into the bundle once someone enables it.
const InspectorRoot = dynamic(
  () => import('./inspector-root').then((m) => m.InspectorRoot),
  { ssr: false }
)

/**
 * Always-mounted lightweight gate: renders the inspector when enabled and
 * listens for the Ctrl+Shift+Y toggle so it works even off the settings page.
 */
export function QueryInspectorGate() {
  const enabled = useQueryInspectorStore((s) => s.enabled)
  // The enabled flag comes from localStorage; render nothing until after
  // hydration so the client's first paint matches the static export.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        const store = useQueryInspectorStore.getState()
        const next = !store.enabled
        store.setEnabled(next)
        toast.success(next ? 'Query inspector enabled' : 'Query inspector disabled')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  if (!mounted || !enabled) return null
  return <InspectorRoot />
}
