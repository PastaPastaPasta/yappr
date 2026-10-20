import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ScrollTabs, scrollTabId } from '@/components/ui/scroll-tabs'
import { PillTabs } from '@/components/blog/pill-tabs'
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
    <button type="button">After tabs</button>
  </main>
}
const root = document.getElementById('root')
if (!root) throw new Error('Missing fixture root')
createRoot(root).render(<Fixture />)
