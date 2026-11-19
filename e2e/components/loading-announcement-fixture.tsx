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

createRoot(document.getElementById('root')!).render(<Fixture />)
