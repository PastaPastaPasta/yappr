# Social-screen query audit

The counts below are cold-load DAPI calls (document, count, or ranked calls).
A composite request counts as one network call even when it contains several
proved subqueries. `N` is the number of referenced posts or identities, `B` is
the number of blogs, `F` is the number of followed identities, and `E` is the
existing batched post-enrichment bundle. SDK startup, cache hits, retries,
writes, IPFS requests, and background polling are excluded.

| Screen | Before | After | Change |
| --- | ---: | ---: | --- |
| Home (`/`) | 16 | 5 | Ranked selection and post/profile hydration use composite queries. |
| Feed — For You first page | ~10 | 1 | One composite page carries posts, counts, quoted posts, profiles, names, and viewer marks. |
| Feed — Top | 9 | 2 | One ranked read plus one composite by-id hydration request (signed out). |
| Feed — Following | `2 + O(F)` | `2 + O(F)` | The timeline is compound already; repost attribution still reads followed users individually. |
| Explore — Top | 9 | 2 | Shares the ranked composite hydration path used by Feed Top. |
| Explore — hashtags | 1 | 1 | Proved hashtag ranking is already a single ranked request. |
| Explore — creators | 3 | 3 | Ranked creator selection plus profile and DPNS batch reads. |
| Explore — blogs | `2 + B + E` | `2 + B + E` | Blog-post discovery still has one indexed read per blog. |
| Search | `2 + E` | `2 + E` | Timeline search and cached blog search remain client-side filters. |
| Hashtag — inline topology | `1 + E` | `1 + E` | The post `tagAndTime` query is already the direct page. |
| Hashtag — legacy document topology | `1 + N + E` | `1 + 1 + E` | Post IDs are now fetched with one bounded `$id in [...]` batch. |
| Mentions | `1 + N + E + 1` | `1 + 1 + E + 1` | Mention targets are fetched with one bounded post-ID batch; ownership validation remains. |
| Bookmarks | `1 + N + E` | `1 + 1 + E` | Bookmark targets are fetched with one bounded post-ID batch. |
| User profile | `~10 + B + E` | `~10 + B + E` | Header decorations and repost/blog sections still use separate contracts. |
| Followers (20 identities) | 63 | 6 | Two grouped follow counts and one DPNS `in` query replace 40 count and 20 username calls. |
| Following (20 identities) | 62 | 5 | Same grouped enrichment; list membership supplies follow state. |
| Post detail | `2 + depth + E` | `2 + depth + E` | Thread ancestry, replies, and per-reply enrichment are already batched by level. |
| Post engagements | 7 | 7 | Engagement lists and counts use separate document types and cannot share a page root. |
| Notifications | 4–8 | 4–8 | Derived notification sources are separate document types; polling is unchanged. |
| Messages | 4–6 | 4–6 | DM contract reads and participant identity enrichment remain separate. |

The improvements in this audit are deliberately bounded by the current
contract indexes: grouped counts fall back to the existing per-identity count
methods when a node cannot decode grouped keys, and post-ID batches split at
the platform's 100-value `in` limit.
