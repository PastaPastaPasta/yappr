import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from 'next-themes'
import { BlogReadingScope } from '@/components/blog/blog-reading-scope'
import '@/app/globals.css'

// The real next-themes provider as the app configures it, and a post shown in the
// reading theme given by ?post=light|dark. Opening and leaving the post is a mount
// and an unmount, as navigating to and from /blog?post=... is.
const postTheme = new URLSearchParams(window.location.search).get('post') === 'light' ? 'light' : 'dark'

function Fixture() {
  const [open, setOpen] = useState(false)
  return <main>
    <p data-testid="app-surface" className="bg-white dark:bg-gray-900">App surface</p>
    <button type="button" onClick={() => setOpen((value) => !value)}>{open ? 'Back' : 'Open post'}</button>
    {open && <BlogReadingScope theme={postTheme}>
      <article data-testid="post-surface" className="bg-white dark:bg-gray-900">Post body</article>
    </BlogReadingScope>}
  </main>
}

const root = document.getElementById('root')
if (!root) throw new Error('Missing fixture root')
createRoot(root).render(
  <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
    <Fixture />
  </ThemeProvider>
)
