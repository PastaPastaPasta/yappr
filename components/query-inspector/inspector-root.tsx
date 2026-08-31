'use client'

import { AnimatePresence } from 'framer-motion'
import { useQueryInspectorStore } from '@/lib/query-inspector/store'
import { InspectorPill } from './inspector-pill'
import { InspectorPanel } from './inspector-panel'

export function InspectorRoot() {
  const panelOpen = useQueryInspectorStore((s) => s.panelOpen)
  return (
    <>
      <AnimatePresence>{!panelOpen && <InspectorPill key="pill" />}</AnimatePresence>
      <AnimatePresence>{panelOpen && <InspectorPanel key="panel" />}</AnimatePresence>
    </>
  )
}
