# Social query audit

This is the complete screen inventory for the social part of Yappr, compared with `origin/staging` at `4105c5d1`. A number is a **DAPI document facade request** (document, count, or ranked request) on a cold load. A composite request counts once, regardless of its proved subqueries. SDK startup, HTTP retries, writes, IPFS/media, cache hits, and polling after the initial load are not included. `N` is selected post IDs, `F` followed identities, `B` blogs, and `P` visible blog posts. `R` is the cold relation check: blocked state, block-follow state, and one following-list page (normally 3). Pagination adds one request per additional page. These are controlled budgets, not claims that every user sees the same number of rows.

## Screen budgets

| Screen, tab, or dialog | Before | After | What changed |
| --- | ---: | ---: | --- |
| Home (`/`) | 5 | 5 | Existing ranked/composite work from #397 is retained; reposter identity hydration is batched. |
| Feed — For You | 5 | 4 | Existing composite page remains one page request; the reposter identity follow-up is one batch. |
| Feed — Top | 2 + hidden Recent 2 | 2 | Recent is disabled, including its poll, while Top is selected. |
| Feed — Following | `2 + F + E` | `2 + ceil(F/11) + E` | Followed-owner repost pages are sibling-bundled and reposter identities are batched; dense owners retain ordinary pagination. |
| Explore — Top | 2 | 2 | Existing ranked selection and composite hydration are retained. |
| Explore — hashtags/trending | 1 | 1 | Ranked hashtag query is already one request. |
| Explore — creators | 3 | 3 | Ranked creators plus profile/name batches; no compatible creator-count composite is available. |
| Explore — blogs | `2 + B` | `2 + ceil(B/11)` | Recent/search blog pages are sibling-bundled; card follow counts are not loaded when not displayed. |
| Search — users/hashtags/blogs | `2 + B` | `2 + ceil(B/11)` | DPNS prefix/profile resolution is batched and blog pages are bundled. |
| Hashtag — inline index | `1 + E` | `1 + E` | The direct hashtag page is already one selected-page query. |
| Hashtag — legacy topology | `1 + N + E` | `1 + ceil(N/100) + E` | Referenced posts use bounded `$id in` pages. |
| Mentions | `1 + N + E + 1` | `1 + ceil(N/100) + E + 1` | Mention targets use bounded ID pages; ownership validation remains a separate proof. |
| Bookmarks | `1 + N + E` | `1 + ceil(N/100) + E` | Bookmark targets use bounded ID pages. |
| User profile (`/user`) | `~10 + B + E` | `~7 + ceil(B/11) + E` | First posts include display enrichment, blog pages are bundled, and profile statistics use one bound-count composite when a profile exists. Private-feed/store/repost sections remain data-dependent. |
| Followers (20 rows) | 63 | 6 | One list, one DPNS batch, one profile batch, two grouped count requests, and one follow-status list. |
| Following (20 rows) | 62 | 5 | Same grouped enrichment without follow-back status. |
| Profile hover card | 4 | 2 | Profile/name plus two counts become a profile-root bound-count composite; a supplied name skips DPNS. |
| Post detail (`/post`) | `2 + depth + E` | `2 + depth + E` | Thread ancestry and replies remain paginated; selected content uses shared enrichment. |
| Post engagements tab bar | 3 counts + active list | 1 composite + active list | Target root binds quote, like, and repost counts. The active engagement list and identity batch remain separate. |
| Likes/reposts/quotes modal/list | `1 + 2N` | `1 + 1` | Each selected engagement list uses one document page and one identity batch. |
| Notifications | 8 (empty v6 poll) | 2 | Seven social sources share one sibling composite; blog-follow source remains one page. Populated body/blog/identity terms are batched. |
| Messages/conversation list (20 conversations) | `2 + 20 + 20 + 2 + K` | `2 + ceil((20 + 1)/11) + 1 + K` | Invites remain separate because their directions differ; message pages and receipt batches are chunked into compatible composites; participants share identity loading. `K` is required public-key work. |
| Messages — conversation detail | `1 + K` | `1 + K` | Per-conversation ascending page and encryption/key operations are load-bearing. |
| Blog home | `1 + P/100 + P` | `1 + ceil(P/11) + 0` | Comment first pages are bundled; follower count is retained because it is displayed. |
| Blog discovery / blog search | `2 + B` | `2 + ceil(B/11)` | Blog pages and author identities are bundled. |
| Blog article | `1 + 1 + 1` | `1 + 0 + 1` | Article follower count is skipped when not displayed; comments are loaded as one page. |
| Blog comments dialog | 1 page | 1 page | Comments have no countable index; pagination is preserved. |
| Private-feed dashboard | 5+ | 5+ | Security surfaces remain separate; duplicate reads and identity loops are removed. A 2000-rekey cap still requires the latest-epoch query. |
| Private-feed followers/requests | 2 + identity loop | 2 + identity batch | Access/grant/request reads remain separate; request identities are batched. |
| Block-list settings | 2 + identity loop | 2 + identity batch | Following and block-follow lists remain distinct doctypes. |
| Settings — Account | 2–3 | 2–3 | Account-only profile date and aliases are lazy; ordinary profile/DPNS reads remain when opened. |
| Settings — other sections | 2–3 hidden | 0 hidden | Account date/alias loaders no longer run for unrelated sections. |
| DashPay contacts dialog | `1 + 2N` | `1 + 1` | Contact identity resolution is batched. |
| Right sidebar — desktop | 4 signed-in / 2 signed-out | 2 / 1 | Own post/follower/following counts use one profile-root bound-count composite; global post count remains separate. |
| Right sidebar — mobile | 4 / 2 | 0 | The sidebar does not mount below 1024px. |
| Poll card | 2–3 | 2–3 | Poll document, grouped tally, and own votes use incompatible fields. |
| Embed post | 2 | 2 | Content and author name are separate contracts. |
| Legal/about/contract/welcome pages | 0 | 0 | Static screens have no social content queries (the shared shell may load when mounted). |

`E` is the existing shared post-enrichment bundle. For known signed-in posts, old enrichment is `9 + R` and composite enrichment is `1 + R`; replies are `6 + R` and `1 + R`. A cursor-free display page is therefore `1 + 9 + R -> 1 + R` for posts and `1 + 6 + R -> 1 + R` for replies. Cursors use ordinary selection followed by exact-ID composite enrichment because composites have no cursor surface.

## Network proof and limits

`scripts/verify-social-query-bundles.mjs` runs read-only equivalence probes against devnet. The latest report is `/tmp/yappr-social-live-report.json`:

| Probe | Independent | Composite | Result |
| --- | ---: | ---: | --- |
| Profiles + DPNS, including profile-less identity | 2 | 1 | equivalent |
| Notification sources | 7 | 1 | equivalent |
| Following repost pages | 4 | 1 | equivalent |
| Blog pages | 2 | 1 | equivalent |
| Conversation messages + receipt IN page | 3 | 1 | equivalent |
| Blog comment first pages | 2 | 1 | equivalent |
| Post composite counts/marks | 8 post rows | passed | equivalent |
| Reply composite counts/marks | 0 rows | passed | equivalent |

Additional direct devnet probes validated the nonempty composite shapes used by
the new code: a profile root with post/follower/following bound counts returned
all three count maps, and a post root with quote/like/repost bound counts
returned its count maps. The public probe report remains document-equivalence
focused, so those root-count checks are not folded into its row table.

The blog, DM, and reply public fixtures are empty, so nonempty decoding is covered by unit tests. Blog comments and follower lists have no countable index and keep pagination. Composite sibling bundles preserve each member's limit/order and fall back when proof, topology, cursor, or compatibility constraints fail; failed members are never cached as absences.

Commerce routes (`/cart`, `/checkout`, `/item`, `/orders`, `/store/*`) and wallet/key-backup transition flows were inventoried but are outside this social audit because their data lives in separate contracts or requires private keys/writes.
