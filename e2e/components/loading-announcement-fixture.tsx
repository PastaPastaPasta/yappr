import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { LoadingAnnouncement } from '@/components/ui/loading-announcement'
import { TrendingHashtagRowSkeleton } from '@/components/explore/trending-hashtag-row'
import '@/app/globals.css'

/** A view that loads on demand, as Explore's trending tab does when another window is picked. */
function Fixture() {
  const [loading, setLoading] = useState(false)
  return (
    <main>
      <button type="button" onClick={() => setLoading((value) => !value)}>{loading ? 'Finish' : 'Load'}</button>
      <LoadingAnnouncement loading={loading} label="Loading trending tags" />
      {loading ? <TrendingHashtagRowSkeleton count={3} testId="skeleton" /> : <p>Loaded</p>}
    </main>
  )
}

/** A view that opens already loading (Explore's first trending read). */
function OpensLoading() {
  const [loading, setLoading] = useState(true)
  return (
    <section aria-label="Opens loading">
      <button type="button" onClick={() => setLoading(false)}>Settle</button>
      <LoadingAnnouncement loading={loading} label="Loading creators" />
    </section>
  )
}

/** Tabs kept mounted and hidden, as Explore's are: the status sits outside them and follows the tab shown. */
function KeptTabs() {
  const [tab, setTab] = useState<'trending' | 'blogs'>('blogs')
  return (
    <section aria-label="Kept tabs">
      <button type="button" onClick={() => setTab('trending')}>Trending</button>
      <LoadingAnnouncement loading={tab === 'trending'} label="Loading trending tags" />
      <div hidden={tab !== 'trending'}><TrendingHashtagRowSkeleton count={2} /></div>
      <div hidden={tab !== 'blogs'}><p>Blogs</p></div>
    </section>
  )
}

const params = new URLSearchParams(window.location.search)
createRoot(document.getElementById('root')!).render(<>
  <Fixture />
  {params.has('opens-loading') ? <OpensLoading /> : null}
  {params.has('kept-tabs') ? <KeptTabs /> : null}
</>)
