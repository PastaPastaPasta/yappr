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

createRoot(document.getElementById('root')!).render(<>
  <Fixture />
  {new URLSearchParams(window.location.search).has('opens-loading') ? <OpensLoading /> : null}
</>)
