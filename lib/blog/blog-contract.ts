/**
 * What the blog v7 cut declares that the client has to mirror exactly: the
 * action fee each create agrees to and the grids its trend windows bucket on.
 * Both are read off the committed contract JSON
 * (contracts/yappr-blog-contract.json, which IS blog v7), so the app cannot
 * drift from what is registered: an agreement naming a different amount is
 * refused (40133), and a ranked read naming a grid the index does not declare
 * is refused too.
 *
 * Older cuts (v1–v6) price nothing and bucket on the hard-coded daily grid in
 * blog-stats-service; nothing here applies to them.
 */
import blogContract from '@/contracts/yappr-blog-contract.json'
import { blogIsV7 } from '@/lib/constants'
import { actionFeeOf, timeRangeOf, type ActionFeeDeclaration, type DocumentAction, type WindowedRanking } from '@/lib/contract-topology'

type BlogSchemas = Record<string, { actionFees?: Parameters<typeof actionFeeOf>[0] }>
const schemas = blogContract.documentSchemas as unknown as BlogSchemas

/**
 * The action fee a v7 transition on `docType`/`action` must agree to, or null
 * when it charges nothing (every blog action before v7; follows, edits and
 * deletes on v7).
 */
export function blogActionFee(docType: string, action: DocumentAction): ActionFeeDeclaration | null {
  return blogIsV7() ? actionFeeOf(schemas[docType]?.actionFees, action) : null
}

/**
 * A rolling window a v7 ranking reads: the contract's grid, and `oldest`, the
 * oldest window still open, which spans nearly the whole `range` (48–72h)
 * rather than `newest`, which may be minutes old.
 */
export type BlogTrendWindow = Pick<WindowedRanking, 'grid' | 'selector'>

const TREND_INDEXES = {
  followers: ['blogFollow', 'followersTrend'],
  comments: ['blogComment', 'discussedRecent'],
} as const

/**
 * The v7 trend window as the contract declares it: `followers` is
 * `blogFollow.followersTrend` ("trending blogs"), `comments` is
 * `blogComment.discussedRecent` ("most discussed posts").
 */
export function blogTrendWindow(trend: keyof typeof TREND_INDEXES): BlogTrendWindow {
  const [docType, index] = TREND_INDEXES[trend]
  return { grid: timeRangeOf(blogContract.documentSchemas, docType, index), selector: 'oldest' }
}
