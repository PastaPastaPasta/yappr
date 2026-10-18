import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { LimitedInput, LimitedTextarea } from '@/components/ui/limited-text'
import '@/app/globals.css'

function Fixture() {
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [url, setUrl] = useState('')
  return <main className="max-w-xl p-6 space-y-4">
    <h1 className="text-xl font-semibold">Contract input limits</h1>
    <label className="block">Blog name<LimitedInput contract="blog" document="blog" field="name" value={name} onChange={e => setName(e.target.value)} /></label>
    <label className="block">Report details<LimitedTextarea contract="blog" document="report" field="note" value={note} onChange={e => setNote(e.target.value)} /></label>
    <label className="block">Cover image<LimitedInput contract="blog" document="blogPost" field="coverImage" value={url} onChange={e => setUrl(e.target.value)} /></label>
  </main>
}
const root = document.getElementById('root')
if (!root) throw new Error('Missing fixture root')
createRoot(root).render(<Fixture />)
