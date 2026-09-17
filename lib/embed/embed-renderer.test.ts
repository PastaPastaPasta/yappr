import { describe, expect, it } from 'vitest'
import { renderEmbedHtml } from './embed-renderer'

describe('saved custom blog blocks in embeds', () => {
  it('retains code from the editor props, including ordinary comparison operators', () => {
    const html = renderEmbedHtml([{ type: 'codeBlock', props: { language: 'javascript', code: 'const qa = 1 < 2;' } }])
    expect(html).toContain('<code class="language-javascript">const qa = 1 &lt; 2;</code>')
  })

  it('keeps legacy inline code when the editor code prop is absent', () => {
    expect(renderEmbedHtml([{ type: 'codeBlock', content: [{ type: 'text', text: 'print("hello")' }] }]))
      .toContain('print(&quot;hello&quot;)')
  })

  it('keeps an explicitly cleared code prop empty', () => {
    expect(renderEmbedHtml([{ type: 'codeBlock', props: { code: '' }, content: 'old code' }]))
      .toBe('<pre><code></code></pre>')
  })

  it('retains cells at both ends of a populated saved table', () => {
    const data = JSON.stringify([['QA table cell', 'R&D'], ['', 'Last cell']])
    const html = renderEmbedHtml([{ type: 'simpleTable', props: { rows: 2, cols: 2, data } }])
    expect(html).toContain('<tr><td>QA table cell</td><td>R&amp;D</td></tr>')
    expect(html).toContain('<tr><td></td><td>Last cell</td></tr>')
  })

  it('renders empty tables and missing rows without losing the remainder of the article', () => {
    const html = renderEmbedHtml([
      { type: 'simpleTable', props: { rows: 2, cols: 2, data: JSON.stringify([['First']]) } },
      { type: 'simpleTable', props: { rows: 1, cols: 1, data: '' } },
      { type: 'paragraph', content: 'After the tables' },
    ])
    expect(html).toContain('<tr><td>First</td><td></td></tr><tr><td></td><td></td></tr>')
    expect(html).toContain('<tbody><tr><td></td></tr></tbody>')
    expect(html).toContain('<p>After the tables</p>')
  })

  it('uses the editor default 3 by 3 dimensions', () => {
    const html = renderEmbedHtml([{ type: 'simpleTable', props: { data: '' } }])
    expect(html.match(/<tr>/g)).toHaveLength(3)
    expect(html.match(/<td>/g)).toHaveLength(9)
  })

  it.each(['video', 'videoEmbed'])('keeps a saved %s URL accessible in the script iframe', (type) => {
    const url = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
    const html = renderEmbedHtml([{ type, props: { url } }])
    expect(html).toBe(`<p><a href="${url}" target="_top" rel="noopener noreferrer">Watch video</a></p>`)
  })

  it('retains the video label and ordinary Odysee URL', () => {
    const html = renderEmbedHtml([{ type: 'video', props: { url: 'https://odysee.com/@example/video', caption: 'QA video & audio' } }])
    expect(html).toContain('href="https://odysee.com/@example/video"')
    expect(html).toContain('>QA video &amp; audio</a>')
  })

  it('omits a video with no saved URL', () => {
    expect(renderEmbedHtml([{ type: 'videoEmbed', props: { url: '' } }])).toBe('')
  })
})
