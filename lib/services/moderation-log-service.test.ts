import bs58 from 'bs58'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { labelText } from '@/lib/moderation-labels'
import type { LaneCursor, LanePage } from '@/lib/moderation-lanes'
import { expandQueries } from '../../scripts/hide-moderation-queries.mjs'

vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => { throw new Error('no network in this spec') } }))
/** The seated charter each contract's labels read against (null: no team seated, the interim classes). */
const charters = vi.hoisted(() => ({ reasons: null as Array<{ id: string; code: string; label: string }> | null, fails: false }))
vi.mock('./charter-reasons', async () => {
  const { labelText: text } = await import('@/lib/moderation-labels')
  return { charterReasonText: async (_contract: string, label: number) => (charters.fails ? null : text(label, charters.reasons)) }
})
import {
  LOG_PAGE_SIZE,
  actionText,
  compareLogRows,
  logHref,
  logRequest,
  logSources,
  mergeLog,
  pageAfter,
  reasonText,
  rowFromDocument,
  warningRows,
  type LogRow,
  type LogSource,
} from './moderation-log-service'

const id = (n: number) => bs58.encode(new Uint8Array(32).fill(n))
const AUTHOR = id(1)
const MOD = id(2)

function row(key: string, at: number, overrides: Partial<LogRow> = {}): LogRow {
  return {
    key, contract: 'social', action: 'hidden', docType: 'post', moderatorId: MOD, subjectId: AUTHOR, at,
    reasonCode: 1, reasonText: null, href: null, parentId: null, ...overrides,
  }
}

const docSource = (docType: string, mod: 1 | 2): LogSource => ({ id: `${docType}:mod${mod}`, kind: 'moderated', contract: 'social', docType, mod })

describe('log reads match the read catalogue', () => {
  // The catalogue (scripts/hide-moderation-queries.mjs) is what the conformance spec judges against the
  // contracts and the sakura battery ran, so the page must send exactly these.
  const catalogue = expandQueries({ author: id(3), me: id(4), post: id(5), reply: id(6), blog: id(7), blogPost: id(8), store: id(9), item: id(10), target: id(11), tag: 'x' })
    .filter((query) => query.purpose === 'log' && query.docType !== 'report')

  it('is covered source for source', () => {
    for (const contract of ['social', 'blog', 'storefront'] as const) {
      const mine = logSources(contract).filter((source) => source.kind !== 'warnings')
      const theirs = catalogue.filter((query) => query.contract === contract)
      expect(mine.length, contract).toBe(theirs.length)
      for (const source of mine) {
        const request = logRequest(source)
        const match = theirs.filter((query) => query.docType === request?.documentTypeName
          && JSON.stringify(query.body.where) === JSON.stringify(request?.where))
        expect(match, `${contract} ${source.id}`).toHaveLength(1)
        expect(request?.orderBy).toEqual(match[0].body.orderBy)
        expect(request?.limit).toBe(match[0].body.limit)
        expect(LOG_PAGE_SIZE).toBe(match[0].body.limit)
      }
    }
  })

  it('reads hidden and legal-hold lanes of the moderated index, and restrictions in force and lifted', () => {
    expect(logRequest(docSource('post', 1))).toEqual({
      documentTypeName: 'post', where: [['mod', '==', 1], ['$moderatedAt', '>', 0]], orderBy: [['$moderatedAt', 'desc']], limit: 20,
    })
    expect(logRequest({ id: 'r', kind: 'restriction', contract: 'blog', state: 2 }, 5, 'CURSOR')).toEqual({
      documentTypeName: 'restriction', where: [['state', '==', 2], ['$moderatedAt', '>', 0]], orderBy: [['$moderatedAt', 'desc']], limit: 5, startAfter: 'CURSOR',
    })
    expect(logRequest({ id: 'w', kind: 'warnings', contract: 'social' })).toBeNull()
  })

  it('never pins the listed lane, which a lane fan-out would multiply', () => {
    for (const source of logSources('social').filter((s) => s.kind !== 'warnings')) {
      expect(JSON.stringify(logRequest(source)?.where)).not.toContain('null')
    }
  })

  it('has restrictions on social and blog only', () => {
    expect(logSources('social').filter((s) => s.kind === 'restriction')).toHaveLength(2)
    expect(logSources('blog').filter((s) => s.kind === 'restriction')).toHaveLength(2)
    expect(logSources('storefront').filter((s) => s.kind === 'restriction')).toHaveLength(0)
  })
})

describe('log availability', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  async function load(env: Record<string, string>) {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
    vi.resetModules()
    vi.doMock('./evo-sdk-service', () => ({ getEvoSdk: async () => { throw new Error('no network in this spec') } }))
    return import('./moderation-log-service')
  }

  it('is on for the v18 set', async () => {
    const service = await load({
      NEXT_PUBLIC_CONTRACT_TOPOLOGY: 'v18', NEXT_PUBLIC_BLOG_TOPOLOGY: 'v10', NEXT_PUBLIC_STOREFRONT_TOPOLOGY: 'v11',
      NEXT_PUBLIC_YAPPR_CONTRACT_ID: id(20), NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID: id(21), NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID: id(22),
    })
    expect(service.availableLogContracts()).toEqual(['social', 'blog', 'storefront'])
    // v18 keeps the warning list, which the log reads too.
    expect(service.logSources('social').map((s) => s.kind)).toContain('warnings')
  })

  it('is off on older cuts, and where a product is switched off', async () => {
    const older = await load({
      NEXT_PUBLIC_CONTRACT_TOPOLOGY: 'v17', NEXT_PUBLIC_BLOG_TOPOLOGY: 'v9', NEXT_PUBLIC_STOREFRONT_TOPOLOGY: 'v10',
      NEXT_PUBLIC_YAPPR_CONTRACT_ID: id(20), NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID: id(21), NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID: id(22),
    })
    expect(older.availableLogContracts()).toEqual([])
    const noBlog = await load({
      NEXT_PUBLIC_CONTRACT_TOPOLOGY: 'v18', NEXT_PUBLIC_BLOG_TOPOLOGY: 'v10', NEXT_PUBLIC_STOREFRONT_TOPOLOGY: 'v11',
      NEXT_PUBLIC_YAPPR_CONTRACT_ID: id(20), NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID: '', NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID: id(22),
    })
    expect(noBlog.availableLogContracts()).toEqual(['social', 'storefront'])
  })
})

describe('rowFromDocument', () => {
  const post = {
    $id: id(30), $ownerId: AUTHOR, $moderatedBy: MOD, $moderatedAt: 1_800_000_000_000n, mod: 1, modLabel: 3,
  }

  it('reads a hidden post: who, when, why, and where to see it', () => {
    expect(rowFromDocument(docSource('post', 1), post)).toEqual({
      key: id(30), contract: 'social', action: 'hidden', docType: 'post', moderatorId: MOD, subjectId: AUTHOR,
      at: 1_800_000_000_000, reasonCode: 3, reasonText: null, href: `/post?id=${id(30)}`, parentId: null,
    })
  })

  it('marks a legal hold, and takes the mod lane from the document', () => {
    expect(rowFromDocument(docSource('post', 2), { ...post, mod: 2 })?.action).toBe('legalHold')
  })

  it('skips documents that are not a hide, or carry no moderator stamp', () => {
    expect(rowFromDocument(docSource('post', 1), { ...post, mod: undefined })).toBeNull()
    expect(rowFromDocument(docSource('post', 1), { ...post, $moderatedAt: undefined })).toBeNull()
    expect(rowFromDocument(docSource('post', 1), { ...post, $id: undefined })).toBeNull()
    expect(rowFromDocument({ id: 'w', kind: 'warnings', contract: 'social' }, post)).toBeNull()
  })

  it('tolerates a missing reason and a missing moderator id', () => {
    const bare = rowFromDocument(docSource('post', 1), { $id: id(31), $moderatedAt: 5, mod: 1 })
    expect(bare).toMatchObject({ moderatorId: null, reasonCode: null, subjectId: null })
  })

  it('reads a restriction placed and lifted', () => {
    const restriction = { $id: id(32), target: AUTHOR, state: 1, reason: 4, $moderatedBy: MOD, $moderatedAt: 9 }
    const source: LogSource = { id: 'r', kind: 'restriction', contract: 'social', state: 1 }
    expect(rowFromDocument(source, restriction)).toMatchObject({ action: 'restricted', docType: 'restriction', subjectId: AUTHOR, reasonCode: 4, href: `/user?id=${AUTHOR}` })
    expect(rowFromDocument({ ...source, state: 2 }, { ...restriction, state: 2 })?.action).toBe('restrictionLifted')
    expect(rowFromDocument(source, { ...restriction, state: 3 })).toBeNull()
    expect(rowFromDocument(source, { ...restriction, target: undefined })).toBeNull()
  })

  it('remembers a blog comment\'s post, which its link is read from', () => {
    const comment = rowFromDocument({ id: 'c', kind: 'moderated', contract: 'blog', docType: 'blogComment', mod: 1 }, { ...post, blogPostId: id(40) })
    expect(comment).toMatchObject({ docType: 'blogComment', parentId: id(40), href: null })
  })
})

describe('logHref', () => {
  const doc = { rootPostId: id(50), blogId: id(51), slug: 'my post', storeId: id(52), itemId: id(53) }

  it('links each type to the page that shows it', () => {
    const r = id(60)
    expect(logHref('post', doc, r, AUTHOR)).toBe(`/post?id=${r}`)
    expect(logHref('reply', doc, r, AUTHOR)).toBe(`/post?id=${id(50)}&reply=${r}`)
    expect(logHref('yapprProfile', doc, r, AUTHOR)).toBe(`/user?id=${AUTHOR}`)
    expect(logHref('blog', doc, r, AUTHOR)).toBe(`/blog?blog=${r}`)
    expect(logHref('blogPost', doc, r, AUTHOR)).toBe(`/blog?blog=${id(51)}&post=my%20post`)
    expect(logHref('store', doc, r, AUTHOR)).toBe(`/store/view?id=${r}`)
    expect(logHref('storeItem', doc, r, AUTHOR)).toBe(`/item?id=${r}`)
    expect(logHref('storeReview', doc, r, AUTHOR)).toBe(`/store/view?id=${id(52)}`)
    expect(logHref('itemReview', doc, r, AUTHOR)).toBe(`/item?id=${id(53)}`)
  })

  it('says null rather than guessing when the document does not name its target', () => {
    for (const type of ['reply', 'blogPost', 'storeReview', 'itemReview', 'blogComment', 'unknown']) expect(logHref(type, {}, id(61), null)).toBeNull()
    expect(logHref('yapprProfile', {}, id(61), null)).toBeNull()
  })
})

describe('warningRows', () => {
  it('lists every warning of every identity, with no moderator', () => {
    const rows = warningRows('social', [
      { identityId: AUTHOR, warnings: [{ warnedAt: 100n, reason: { text: 'spam' } }, { warnedAt: 200n, reason: { text: '' } }] },
      { identityId: MOD },
      { identityId: id(5), warnings: [{ warnedAt: 0n, reason: { text: 'no time' } }] },
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ action: 'warned', moderatorId: null, subjectId: AUTHOR, at: 100, reasonText: 'spam', href: `/user?id=${AUTHOR}` })
    expect(rows[1]).toMatchObject({ at: 200, reasonText: null })
    expect(new Set(rows.map((r) => r.key)).size).toBe(2)
  })
})

describe('merging the log', () => {
  const page = (docs: LogRow[], full = false): LanePage<LogRow> => ({ docs, full })

  it('interleaves sources newest first, with ties broken the same way every time', () => {
    const merged = mergeLog([page([row('a', 50), row('d', 10)]), page([row('c', 40), row('b', 40)]), page([row('e', 60)])], [null, null, null], 10)
    expect(merged.rows.map((r) => r.key)).toEqual(['e', 'a', 'c', 'b', 'd'])
    expect(merged.cursors).toEqual(['done', 'done', 'done'])
    expect(merged.more).toBe(false)
    expect([row('x', 1), row('y', 1)].sort(compareLogRows).map((r) => r.key)).toEqual(['y', 'x'])
  })

  it('stops at the limit and leaves each source a cursor at the last row it gave', () => {
    const merged = mergeLog([page([row('a', 50), row('d', 10)], true), page([row('b', 40), row('c', 30)], true)], [null, null], 3)
    expect(merged.rows.map((r) => r.key)).toEqual(['a', 'b', 'c'])
    expect(merged.cursors).toEqual(['a', 'c'])
    expect(merged.more).toBe(true)
  })

  it('keeps a source that gave nothing where it was, and a finished one finished', () => {
    const merged = mergeLog([page([row('a', 50)], true), page([row('z', 1)], true)], ['before', 'done'], 1)
    expect(merged.rows.map((r) => r.key)).toEqual(['a'])
    expect(merged.cursors).toEqual(['a', 'done'])
  })

  it('shows a row two sources both supplied once', () => {
    const merged = mergeLog([page([row('a', 50)]), page([row('a', 50)])], [null, null], 10)
    expect(merged.rows).toHaveLength(1)
  })

  it('pages a whole log source by source: nothing lost, nothing repeated, newest first', () => {
    // Four sources of different sizes, like hidden and legal-hold lanes plus restrictions and the warning list.
    const sources = [
      Array.from({ length: 23 }, (_, i) => row(`p${i}`, 10_000 - i * 7)),
      Array.from({ length: 9 }, (_, i) => row(`r${i}`, 9_990 - i * 31)),
      Array.from({ length: 1 }, () => row('s0', 5_000)),
      [] as LogRow[],
      Array.from({ length: 12 }, (_, i) => row(`w${i}`, 9_000 - i * 3, { action: 'warned', moderatorId: null })),
    ]
    const limit = 5
    const ordered = sources.map((all) => all.slice().sort(compareLogRows))
    let cursors: LaneCursor[] = sources.map(() => null)
    const seen: string[] = []
    for (let step = 0; step < 50; step++) {
      // Each source answers with the rows after its cursor, at most one page: a full page may have more behind it.
      const pages = ordered.map((all, index) => {
        const cursor = cursors[index]
        return cursor === 'done' ? page([]) : pageAfter(all, cursor, limit)
      })
      const merged = mergeLog(pages, cursors, limit)
      seen.push(...merged.rows.map((r) => r.key))
      cursors = merged.cursors
      if (!merged.more) break
    }
    const everything = sources.flat().sort(compareLogRows).map((r) => r.key)
    expect(seen).toEqual(everything)
    expect(cursors.every((cursor) => cursor === 'done')).toBe(true)
  })
})

describe('pageAfter', () => {
  const sorted = ['a', 'b', 'c', 'd', 'e'].map((key, i) => row(key, 100 - i))

  it('returns the rows after a key, and whether more follow', () => {
    expect(pageAfter(sorted, null, 2)).toEqual({ docs: sorted.slice(0, 2), full: true })
    expect(pageAfter(sorted, 'b', 2)).toEqual({ docs: sorted.slice(2, 4), full: true })
    expect(pageAfter(sorted, 'c', 2)).toEqual({ docs: sorted.slice(3), full: false })
    expect(pageAfter(sorted, 'e', 2)).toEqual({ docs: [], full: false })
    expect(pageAfter([], null, 2)).toEqual({ docs: [], full: false })
  })
})

describe('wording', () => {
  it('says hidden or restricted, never removed or deleted', () => {
    const lines = (['post', 'reply', 'yapprProfile', 'blog', 'blogPost', 'blogComment', 'store', 'storeItem', 'storeReview', 'itemReview'] as const)
      .flatMap((docType) => (['hidden', 'legalHold'] as const).map((action) => actionText({ action, docType })))
    lines.push(actionText({ action: 'restricted', docType: 'restriction' }), actionText({ action: 'restrictionLifted', docType: 'restriction' }), actionText({ action: 'warned', docType: 'warning' }))
    for (const line of lines) expect(line).not.toMatch(/remov|delet|ban|suspend/i)
    expect(actionText({ action: 'hidden', docType: 'post' })).toBe('Post hidden')
    expect(actionText({ action: 'legalHold', docType: 'storeItem' })).toBe('Listing hidden for legal reasons')
    expect(actionText({ action: 'restricted', docType: 'restriction' })).toBe('Account restricted')
  })

  it('words a reason from the charter or from the warning text, and never as a bare number', async () => {
    charters.reasons = [{ id: 'a', code: 'SPM', label: 'Spam' }, { id: 'b', code: 'HAR', label: 'Harassment' }]
    expect(await reasonText('social', { reasonCode: 2, reasonText: null })).toBe('Harassment')
    expect(await reasonText('social', { reasonCode: 9, reasonText: null })).toBeNull()
    expect(await reasonText('social', { reasonCode: null, reasonText: 'Posting links' })).toBe('Posting links')
    expect(await reasonText('social', { reasonCode: null, reasonText: null })).toBeNull()
    charters.fails = true
    expect(await reasonText('blog', { reasonCode: 1, reasonText: null })).toBeNull()
    charters.fails = false
    charters.reasons = null
  })

  it('reads a label as the interim class while no team is seated, the way a hidden item\'s own label does', async () => {
    const interim = labelText(1, null)
    expect(interim).toBeTruthy()
    expect(await reasonText('social', { reasonCode: 1, reasonText: null })).toBe(interim)
  })
})
