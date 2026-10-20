import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ScrollTabs, scrollTabId } from '@/components/ui/scroll-tabs'
import { PillTabs } from '@/components/blog/pill-tabs'
import { useTabKeyboard } from '@/hooks/use-tab-keyboard'
import '@/app/globals.css'

const TABS = [
  { key: 'all', label: 'All' },
  { key: 'reposts', label: 'Reposts' },
  { key: 'replies', label: 'Replies' },
  { key: 'follows', label: 'Follows', dot: true },
  { key: 'mentions', label: 'Mentions' },
] as const
type Key = (typeof TABS)[number]['key']

const SORTS = [
  { key: 'new', label: 'New' },
  { key: 'top', label: 'Top' },
  { key: 'rising', label: 'Rising' },
] as const

const MANUAL_KEYS = ['first', 'second', 'third'] as const
type ManualKey = (typeof MANUAL_KEYS)[number]

/** A tablist where selecting costs a reload, so arrows move focus only. */
function ManualTabs() {
  const [picked, setPicked] = useState<ManualKey>('first')
  const [selections, setSelections] = useState(0)
  const select = (key: ManualKey) => {
    setPicked(key)
    setSelections((count) => count + 1)
  }
  const keyboard = useTabKeyboard({ keys: MANUAL_KEYS, active: picked, onSelect: select, manualActivation: true })
  return <div>
    <div ref={keyboard.listRef} onKeyDown={keyboard.onKeyDown} role="tablist" aria-label="Manual" className="flex gap-2">
      {MANUAL_KEYS.map((key) => (
        <button key={key} type="button" role="tab" aria-selected={picked === key} tabIndex={picked === key ? 0 : -1} onClick={() => select(key)}>
          {key}
        </button>
      ))}
    </div>
    <p data-testid="manual-selections">{selections}</p>
  </div>
}

function Fixture() {
  const [active, setActive] = useState<Key>('all')
  const [sort, setSort] = useState<(typeof SORTS)[number]['key']>('new')
  return <main className="p-6 space-y-6">
    {/* A 200px bar forces sideways scrolling so scroll-into-view is observable. */}
    <div style={{ width: 200 }}>
      <ScrollTabs tabs={[...TABS]} active={active} onSelect={setActive} ariaLabel="Filter" panelId="demo-panel" />
    </div>
    <div id="demo-panel" role="tabpanel" aria-labelledby={scrollTabId('demo-panel', active)}>Showing {active}</div>
    <PillTabs options={SORTS} value={sort} onChange={setSort} label="Sort" />
    <p data-testid="sort">{sort}</p>
    <ManualTabs />
    <button type="button">After tabs</button>
  </main>
}
const root = document.getElementById('root')
if (!root) throw new Error('Missing fixture root')
createRoot(root).render(<Fixture />)
