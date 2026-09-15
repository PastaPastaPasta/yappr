# Yappr staging QA: validated issues, corrections and coverage

Updated 2026-09-15. Target: `https://yap.pr/devnet/`, observed build `4105c5d`. Reference staging revision: `4105c5d1c914f5d0838619da93c3b8d28b4a780e`.

**This supersedes the earlier report. The earlier claim of a completed audit of all user stories was unsupported.** Several reported failures used stale identities, incomplete observations, or invalid screenshot evidence. Confirmed defects, withdrawn claims and remaining test coverage are separated below. A route visit is not an end-to-end story pass, and a green build is not proof of live persistence.

## Confirmed issues and individual fixes

| ID | Impact | Reproduction on reference staging | Resulting behavior | PR |
|---|---|---|---|---|
| QA-01 | Low: telemetry integration | Browser blocks the deployment-injected `static.cloudflareinsights.com` script under the committed CSP. | Permit the exact script host. Existing HTTPS connection policy needs no extra entry. | [#406](https://github.com/PastaPastaPasta/yappr/pull/406) |
| QA-02 | Medium: broken-link recovery | Open `/devnet/embed/` without `post`, or with `?post=`. With Platform unavailable it waits on SDK initialization indefinitely; after initialization it displays a bare error. | Immediate accessible missing-post message and a base-path-aware Browse blogs recovery link. | [#407](https://github.com/PastaPastaPasta/yappr/pull/407) |
| QA-03 | High: unusable payment destination | The payment form accepts a Dash/tDash address with invalid length/checksum and allows submission. | Validate Base58Check payload length, checksum and network version across modal, profile entry and profile import; retain valid URI query parameters. | [#410](https://github.com/PastaPastaPasta/yappr/pull/410) |
| QA-04 | Medium: broken-link recovery | Open `/devnet/store/view/` with absent/empty `id`. Store loading never resolves into useful content. This is the store route, not the separate `/item/` route. | Missing-store message and Browse Stores recovery on desktop/mobile. | [#411](https://github.com/PastaPastaPasta/yappr/pull/411) |
| QA-05 | Medium: dialog accessibility | Open Create Blog. The dialog lacks an accessible description and Radix reports the missing description. | Visible description connected to the dialog; keyboard dismissal remains functional. | [#412](https://github.com/PastaPastaPasta/yappr/pull/412) |
| QA-06 | Medium: post accessibility | Zero-count icon-only post actions have missing/unhelpful accessible names; bookmark does not expose pressed state. Like already exposed pressed state. | Names for the six action-row controls, clear tooltips and bookmark pressed state. Desktop/mobile keyboard and ARIA assertions accompany screenshots. | [#413](https://github.com/PastaPastaPasta/yappr/pull/413) |
| QA-07 | Medium: menu accessibility | The separate top-right post options button has an empty accessible name. | Named post/reply options, focus tooltip and keyboard menu behavior. | [#414](https://github.com/PastaPastaPasta/yappr/pull/414) |
| QA-08 | Medium: misleading guest page | As a guest, `/followers/` or `/following/` without `id` displays `@User` and an apparent zero-result list although no target was selected. | Guest recovery; signed-in own-account defaults and explicit public targets remain supported. | [#415](https://github.com/PastaPastaPasta/yappr/pull/415) |
| QA-09 | Medium: mobile navigation accessibility | Computed accessibility snapshot confirms all five mobile bottom-navigation controls lack names. | Named navigation landmark/controls, Menu disclosure state and focus tooltip. | [#416](https://github.com/PastaPastaPasta/yappr/pull/416) |
| QA-10 | Medium: hidden-menu accessibility | The visually closed mobile More sheet remains exposed in the accessibility tree; invisible controls can receive keyboard focus. This is separate from the withdrawn visual duplicate-navigation claim. | Closed-sheet inert/ARIA exclusion and open/close keyboard focus. | [#418](https://github.com/PastaPastaPasta/yappr/pull/418) |
| QA-11 | Medium: wrong deployment navigation | A real published devnet article embeds successfully, but its footer opens root testnet and shows Blog not found. Generated iframe/script snippets and the loader also drop the deployment path. | Preserve the build deployment path in snippets, loader and article footer. | [#417](https://github.com/PastaPastaPasta/yappr/pull/417) |
| QA-12 | Medium: profile form accessibility | Name/Bio/Location are unnamed; Pronouns/Website use placeholders as fallback. All five visible label clicks fail to focus their fields. | Connect each label to a stable unique input ID. | [#419](https://github.com/PastaPastaPasta/yappr/pull/419) |
| QA-13 | Medium: embedded article navigation | Script-created iframe renders the real article but View on Yappr cannot navigate the host tab because the sandbox includes an invalid navigation flag. | User-activated top navigation from script-created embeds, stacked on #417 to isolate this defect. | [#420](https://github.com/PastaPastaPasta/yappr/pull/420) |
| QA-14 | High: profile edits fail | Editing only Bio on two current seeded profiles fails with a visible generic toast. SDK schema validation rejects the parsed paymentUris array; the replacement path merged the display User model into a raw profile payload. | Send the full raw-derived serialized replacement; actual UI save/readback and exact original field restoration passed. | [#421](https://github.com/PastaPastaPasta/yappr/pull/421) |
| QA-15 | Medium: incorrect reply context | Open a saved reply directly. Its parent remains Unknown User and loses engagement counts even after waiting; opening the parent directly resolves its profile. | Keep the enriched chain returned before initial state installation. | [#422](https://github.com/PastaPastaPasta/yappr/pull/422) |
| QA-16 | Medium: broken search navigation | On deployed staging, select the #masternodes sidebar suggestion. It navigates to /devnet/hashtag/masternodes and a 404 instead of the supported query route. | Supported query route, verified by mouse/keyboard browser regressions and populated feed readback. | [#423](https://github.com/PastaPastaPasta/yappr/pull/423) |
| QA-17 | Medium: broken copied link | Copy a devnet post link; the clipboard omits /devnet and the destination cannot find the same post. | Copy deployment-aware URLs; actual clipboard and destination readback verified on exact base/head. | [#425](https://github.com/PastaPastaPasta/yappr/pull/425) |
| QA-18 | Medium: stale private reply control | After approved recipient recovers keys, plaintext appears but reply remains unavailable until reload. | Subscribe to follower-key readiness changes; settled revocation compatibility separately verified. | [#424](https://github.com/PastaPastaPasta/yappr/pull/424) |
| QA-19 | Medium: blog light-theme contrast | Create Blog heading/Cancel render black on near-black; selected blog title/tab render white on white in light mode. | Theme-aware management styling; actual light/dark management and reader/theme compatibility verified. | [#427](https://github.com/PastaPastaPasta/yappr/pull/427) |
| QA-20 | Low: stale article comment count | Delete own last comment: Comments (0) and No comments yet appear, but article header and rail still show1. Fresh reload fixes the count. | Derive all displayed counts from current visible comments; actual before/head deletion cycles and independent cleanup readback passed. | [#429](https://github.com/PastaPastaPasta/yappr/pull/429) |
| QA-21 | Medium: incorrect commerce amounts | Product/order amounts of0.00000100 DASH display0.0000, hiding their value. | Preserve eight-decimal duff precision in storefront prices. | [#426](https://github.com/PastaPastaPasta/yappr/pull/426) |
| QA-22 | Medium: incorrect currency defaults | A DASH store opens new product/shipping forms with USD, requiring repeated correction. | Load the store default before creating product/zone forms; preserve edited records and explicit overrides. | [#428](https://github.com/PastaPastaPasta/yappr/pull/428) |
| QA-23 | High: wrong-network onboarding | Devnet Create an identity opens the bridge in TESTNET mode. | Include the correct bridge network selector; actual before/head destination labels verified. | [#430](https://github.com/PastaPastaPasta/yappr/pull/430) |
| QA-24 | Medium: shipping calculation race | A valid address is rejected by immediate Continue, then accepted unchanged after calculation settles. | Pending-state/cancellation fix undergoing actual browser comparison. | Pending |
| QA-25 | High: DASH checkout unavailable | A DASH-priced order paid via tdash shows Amount not calculated / Price unavailable. | Preserve1:1 amounts for matching currency/scheme; fix undergoing actual browser comparison. | Pending |
| QA-26 | Medium: checkout accessibility | Shipping/contact inputs and country select lack programmatic label associations. | Independent focused fix in progress. | Pending |
| QA-27 | Medium: settings accessibility | Eleven notification/privacy/performance switches lack accessible names. | Associate visible labels/descriptions; fix in progress. | Pending |
| QA-28 | Medium: incorrect Following feed | Live persona50 follows nobody; quickly select Following and38public posts persist after18seconds. Refresh correctly empties the feed. | Ignore stale page/background results from prior feed view; fix in progress. | Pending |

Severity here describes practical impact, not a security vulnerability rating. No confirmed P0 data-loss defect remains from the original audit.

## Evidence and validation standard

The authoritative PR descriptions contain immutable before/after links, exact revisions, matching fixtures, limitations and checks. Earlier illustrative/synthetic application screenshots are retired; they do not prove product behavior.

- **#406:** Browser diagnostic running the actual CSP extracted from each committed layout. A harmless script response isolates browser policy enforcement. It demonstrates blocked-before/loaded-after, not successful real telemetry delivery. [Evidence](https://github.com/PastaPastaPasta/dash-ui-artifacts/tree/e483b3bb43dbfb944967850821c858e5e76159ff/yappr/pr-406).
- **#407:** Actual independently built app revisions, same missing query and unavailable Platform fixture. Two Playwright regressions cover absent/empty ID and `/devnet/blog` destination. [Evidence](https://github.com/PastaPastaPasta/dash-ui-artifacts/tree/e483b3bb43dbfb944967850821c858e5e76159ff/yappr/pr-407).
- **#410:** Shared address validation has 17 targeted Vitest cases; independent review found no blocking code defect. Twelve inspected and hash-verified captures use the actual components with a disclosed save/change observer, proving invalid submission is prevented. This does not prove an on-chain payment. [Evidence](https://github.com/PastaPastaPasta/dash-ui-artifacts/tree/9d7fc2af9a95b0fc8ddc7054d6f0a9863c2aac8a/yappr/pr-410).
- **#411:** Actual base/head app screenshots at desktop/mobile plus two missing/empty-ID browser regressions. [Evidence](https://github.com/PastaPastaPasta/dash-ui-artifacts/tree/5031a9a3b836516787028d54092062bfa2daf61e/yappr/pr-411).
- **#412:** Actual base/head dialog screenshots, accessible description and keyboard checks. [Evidence](https://github.com/PastaPastaPasta/dash-ui-artifacts/tree/58feb20941cc88573eb129fdc16673ce29e8a5fb/yappr/pr-412).
- **#413:** Actual base/head post at desktop/mobile, focused tooltip captures and separate accessible-name/state assertions. Pixels alone cannot prove screen-reader semantics. [Evidence](https://github.com/PastaPastaPasta/dash-ui-artifacts/tree/70c6de93eb046d4c0eac2fba5a24489cf35d83a8/yappr/pr-413).

[Successful post, like/unlike and bookmark/unbookmark cycles](https://github.com/PastaPastaPasta/dash-ui-artifacts/tree/a33ea2235f732bc876195e6561776ec22080b79c/yappr/qa-20260915-revalidation/social-cycle) include actual independent-session readback and inspected final screenshots. Rejected loading captures and corrected test selectors are documented; they are not product failures.

[Reply, repost/undo and follow/unfollow evidence](https://github.com/PastaPastaPasta/dash-ui-artifacts/tree/122da82bdb785c65c258dbe44714b5e0ff47e858/yappr/qa-20260915-revalidation/social-persona33) records fresh-session reads, relevant public SDK records, and seven inspected screenshots.

[Auth Vault password/passkey evidence](https://github.com/PastaPastaPasta/dash-ui-artifacts/tree/1a5d5d3d63f714374af57e7a7f25fb840cbca6bd/yappr/qa-20260915-revalidation/auth-vault-persona39) records seven normal-flow checks, including an empty browser-context password sign-in and virtual-authenticator passkey sign-in. The virtual authenticator is disclosed; this is not a physical-device compatibility claim.

[Private-feed lifecycle evidence](https://github.com/PastaPastaPasta/dash-ui-artifacts/tree/1bab1e9cef3b764c3d744e8722c1614740fafc01/yappr/qa-20260915-revalidation/private-feed-36-37) records enable, publish, request, approve, fresh approved readback, normal revocation and a locked future post. Three visible state inconsistencies are documented separately from the successful lifecycle; no access-bypass test was performed.

[Appearance and notification evidence](https://github.com/PastaPastaPasta/dash-ui-artifacts/tree/204a49f868720375af2c7975771a73f1a0df4dc7/yappr/qa-20260915-revalidation/settings-notifications) records four appearance assertions and actual reply-notification/filter/read-state/navigation checks.

Source changes received local builds and relevant lint/tests. Current PR checks must be read from GitHub; a skipped check is not counted as a pass, and a CodeRabbit success status can represent a skipped review. Published image verification checks HTTP status, content type and SHA-256 against the inspected local files, followed by inspection of the rendered PR.

## Corrections to the original findings

| Earlier claim | Corrected disposition |
|---|---|
| Deterministic first DM loss; P0 | Retracted. A first message persisted and decrypted in fresh sender and recipient contexts on unchanged staging. This validates one supported key/session configuration, not every key type. |
| Fix first DM by adding `recipientId` | Invalid. The live lean DM contract forbids that extra property. [#409](https://github.com/PastaPastaPasta/yappr/pull/409) is closed; its synthetic screenshot is removed from the description. |
| Auth Vault/encryption/password/passkey controls absent | Retracted. Real settings show Enter Key, Add Password Unlock and Add Passkey. Enter Key and Enable Private Feed open the expected forms. Subsequent actual Auth Vault and private-feed cycles passed as recorded below. |
| Duplicate mobile bottom-navigation rows | Retracted. Full-page capture included the closed translated More sheet below the viewport. Actual 390×844 screenshots at top and bottom show one navigation row. |
| Post/like/bookmark failures universally invisible; bookmark rollback absent | Unproven. Staging already has generic failure feedback and rollback. Earlier observations do not establish their absence or isolate timing. |
| Buy YAPP to fix bookmark failure; #408 fixes write feedback | Invalid. Bookmarks have no YAPP cost. `createDocument()` returns an error result that the proposed catch does not receive. [#408](https://github.com/PastaPastaPasta/yappr/pull/408) is closed; its handcrafted HTML evidence is removed. |
| Blog/store `Identity not found` establishes current product write failure | Unproven. Earlier fixtures included identities from a reset chain. Later current-persona creation succeeded. Blog source has a failure toast; the initial no-toast claim is not established. |
| No-store inventory/manage redirect is a bug | Intentional setup flow: these routes direct a seller with no store to create one. No fix proposed. |
| Duplicate payment-modal buttons | Not established. The count mixed the modal title and background controls with the active submit button. |
| Seller can buy own item, therefore checkout defective | Product restriction not established. Reaching checkout is not proof of an invalid order or payment. No invented self-purchase ban proposed. |
| All missing-context routes lack recovery | Overstated. `/item/` already offers Browse Stores; hashtag and mentions have contextual guidance. Embed, store/view and guest connection lists are assessed separately. |
| Sign-in CTAs and shortened devnet banner are defects | Subjective observations. Multiple sign-in entry points alone do not establish failure; the mobile banner retains the data-reset warning. No unsupported behavior change proposed. |

[Public correction evidence](https://github.com/PastaPastaPasta/dash-ui-artifacts/tree/58ecafc3910db13eef55840a42cffdf7845fd4e1/yappr/qa-20260915-revalidation) records exact staging revision, identities, message marker, live DM schema, screenshots and limitations. These are same-revision observations, not before/after fixes.

**Still unisolated:** immediately after one successful first DM send, the active thread showed the message while the conversation sidebar remained empty. A fresh sender session restored the sidebar. Delivery succeeded; the sidebar observation needs separate reproduction before assigning a root cause or issuing a fix.

## User-story inventory and honest coverage

The inventory was derived from 38 route pages plus the dialogs/settings they expose. Each row names a distinct user objective. “Observed” means the earlier interactive audit visited the surface; it does not imply every transition or edge case passed. “Revalidated” names a repeatable observation with current fixtures. “Remaining” is work not certified by this report. The overall audit is **not yet exhaustive**.

| Story | Surface | Current evidence / remaining work |
|---|---|---|
| Browse public posts without an account | Home, Explore | Populated live reads observed; sort/pagination coverage incomplete. |
| Browse following feed | Feed | Persona48 follows49: real QA post appears in fresh Following feed. Block removes target, unblock restores target; relationship restored absent. Rapid tab switch separately exposes QA-28 contamination, so overall feed correctness remains open. |
| Search users, hashtags and content | Search | Entry/results surfaces observed; empty, repeated, pagination and special-character cases remaining. |
| Browse a hashtag | Hashtag | Missing-context guidance inspected; populated pagination remaining. |
| View mentions | Mentions | Guest guidance inspected; two-account mention notification cycle remaining. |
| Open a post and its thread | Post | Current root/reply publication and fresh readback passed; direct reply context revealed QA-15, fixed in #422. |
| View engagement lists | Post engagements | Route visited; consistency after writes remaining. |
| Discover and view profiles | User | Seeded profile reads observed; missing/invalid/deleted identity permutations remaining. |
| Create a new funded identity | Login/create-account flow | Entry UI inspected. New identity funding/registration ceremony not certified. |
| Restore a session with an authentication key | Login/session | Revalidated with current seeded identities and fresh browser contexts. |
| Sign in via external wallet QR | Login | Entry UI inspected; real external-wallet ceremony remaining. |
| Enroll and sign in with a passkey | Login/settings | Persona39 enrollment, logout, passkey sign-in and reload passed with Chromium virtual WebAuthn/PRF. Physical-device and external-wallet ceremonies remain separate. |
| Add password unlock and sign in | Login/settings | Persona39 actual password enrollment, logout/password sign-in, empty-context password sign-in and reload passed. No preseeded session/private key was used for fresh sign-in. |
| Recover/replace a missing key | Settings | Recovery entry visible; recovery workflow remaining. |
| Finish first-run onboarding | Welcome | Surface inspected; fresh-account completion remaining. |
| Create/edit a profile | Profile create/settings | Bio-only edit failed on two current identities; confirmed QA-14 serialization issue. Fixed by #421; live UI save and fresh chain readback passed, then original raw contract fields restored. |
| Choose avatar/banner and social links | Profile settings | Surface inventoried; media upload/save/readback remaining. |
| Add a profile payment destination | Profile payment input | Malformed Dash validation addressed by #410; on-chain transfer not exercised. |
| Register/manage a DPNS username | DPNS register | Entry surface inspected; paid registration/conflict/readback remaining. |
| Compose a public post | Composer | Revalidated with persona30: post creation success toast, modal closes, and an independent session displays saved post `9mcdDNznWP86bScjmMykF1kzNpecneoFoZVVNAB5qCFd`. |
| Reply and compose a thread | Composer/post | Persona33 reply publication/readback and persona42 three-part thread publication/readback passed. Direct part3 detail shows root+part3 by current flat-context design; reduced ancestry is a UX concern, not a confirmed missing-data defect. |
| Attach media to a post | Composer/storage | Upload/provider flows remaining. |
| Create/vote on a poll | Composer/poll | Personas42/43 poll creation, vote and fresh readback passed; end-time/multiple-choice branches remain. |
| Edit/delete own content | Post options | Persona43 own quote deletion passed immediately and after fresh readback; SDK tombstone confirmed. Ordinary post options expose no Edit action. Thread cleanup verified to tombstones. |
| Like/unlike, repost/undo and quote | Post actions | Names/tooltips covered by #413; persona32 like/unlike with fresh-session readback passed. Persona33 repost/undo fresh-session cycles also passed. Persona43 quote publication, readback and deletion/tombstone readback passed. |
| Bookmark/unbookmark | Post/bookmarks | Accessible state covered by #413; persona32 bookmark/unbookmark and independent-session readback both passed. |
| Share a post/copy link | Post actions | Actual clipboard/destination readback exposed QA-17, fixed in#425. Native share sheet remains. |
| Follow/unfollow another identity | Profile/connection lists | Persona33 follow/unfollow passed, with both fresh own/target lists and independent SDK records checked; initial relationship restored. |
| View own followers/following | Connection lists | Authenticated no-id default intentional; preserve in QA-08. |
| View another user's followers/following | Connection lists | Explicit-id route supported; guest missing-context recovery fixed in #415. |
| Block/unblock and consume trusted block lists | Privacy & Security | Persona48 blocks49 through post menu; fresh profile/blocked-users settings reflect block, target absent from Following. Settings unblock restores target in fresh feed. Trusted-list propagation remains. |
| Read/mark/filter notifications | Notifications/settings | Persona30 received persona33 reply notification; Replies filter, mark-all-read persistence after reload, and click-through to persisted reply passed. Other event types/mobile filtering remain. |
| Choose NSFW content preferences | Composer/privacy/post/feed | Persona49 published harmless flagged text. Persona48 warning/reveal, reload resetting reveal, Always show persistence, Hide persistence, list exclusion and gated direct detail passed. Warn first and follow relationship restored. Initial direct click on a hidden radio was a test selector error; clicking its visible label worked. |
| Enter encryption key | Privacy & Security | Personas36/37 normal encryption-key entry passed as part of private-feed lifecycle; populated secret inputs were excluded from captures. |
| Enable and publish a private feed | Private Feed | Persona36 enabled a feed, published a private QA post, and owner readback passed. |
| Request/approve/revoke private-feed access | Private Feed/profile | Persona37 requested, persona36 approved, fresh recipient decrypted. Normal revocation rotated epoch, removed request/grant and locked a future post in retained recipient session. Reply-control/dashboard UI inconsistencies are being isolated separately. |
| Send the first direct message | Messages | Revalidated: real send, fresh sender readback, fresh recipient decryption. |
| Continue/reload a conversation | Messages | Existing-message readback revalidated; concurrent replies and pagination remaining. |
| Discover stores/items | Store/item | Routes and seeded items observed; full filtering/stock permutations remaining. |
| Create/manage a store | Store create/manage | Earlier current-persona creation succeeded; repeat evidence lacks full provenance. No fresh completion claimed. |
| Configure store payment methods | Payment modal | Invalid Dash acceptance reproduced; #410 validates modal/profile/import paths. |
| Create/manage inventory/products | Store inventory/item add | Persona40 product creation/readback and stock5→7 UI/reload passed. DASH precision/default bugs QA-21/22 fixed separately. Deletion/stock-exhaustion branches remain. |
| Add/remove items and retain cart | Item/cart | Earlier add-to-cart/persistence observed; mixed-store/quantity/stock edges remaining. |
| Save shipping information | Checkout/settings | Encryption prerequisite visible; save/readback remaining. |
| Checkout and pay as another buyer | Checkout | Full funded buyer/seller payment cycle remaining. |
| Track/cancel/fulfill an order | Orders/seller orders | QA order processing→shipped→delivered persisted to buyer41. Tracking is explicitly fake; no actual shipment/payment occurred. Cancellation remains. |
| Review a purchased product | Orders/item | Buyer41 five-star review persisted; store shows5.0/1. This followed a simulated QA order, with no actual payment/shipment. |
| Discover/create a blog | Blog | Persona44 create and independent My Blogs readback passed. Light-mode contrast issue QA-19 confirmed; dialog description separately fixed in #412. |
| Configure blog theme and metadata | Blog settings | Persona44 description save/fresh readback and label add/fresh readback passed; Ocean theme saved and visible to fresh persona45. Fresh theme editor and reader both confirmed Ocean background#ecfeff; disposable draft title/body restored after reload. |
| Publish/edit/delete a blog article | Blog editor | Real QA articles published and read back independently. Persona44 article content edit persisted to fresh persona45. Article deletion is not exposed by current normal UI; no unsupported delete claim. |
| Read/comment on a blog article | Blog viewer | Persona45 comment creation, persona44 readback, own deletion and completed empty-state fresh readback passed. Deletion exposed stale header/rail count QA-20. An initial wrong empty-state test string was corrected, not counted as an app failure. |
| Embed an article and recover a broken link | Embed | Missing/empty-ID offline recovery revalidated in #407; successful embed navigation exposed QA-11; correction in #417. |
| Navigate on mobile/by keyboard/screen reader | Navigation/post/dialogs | Specific action/dialog defects receive separate PRs; not a blanket accessibility certification. |
| Change appearance/storage/provider preferences | Settings | Persona38 light/dark selection, dark persistence after reload, and System following dark/light media changes passed. Storage/provider integrations remain. |
| Inspect query/contract information | Developer settings/contract | Entry surfaces observed; no proof-correctness certification. |
| Read informational/legal pages | About/private feeds/privacy/terms/cookies | Routes visited; copy/content review not a functional transaction test. |
| Log out, clear local state, and restore account | Settings/session | Independent contexts used for readback; every logout/vault-lock variant remaining. |

## Identity/funding setup and transcript correction

The repository's `docs/TESTING.md`, `e2e/fixtures/auth.ts`, provisioning scripts, and the current seeded-devnet setup are the available setup references. The current 100-persona corpus is in the private local fixture directory `/Users/pasta/.local/share/yappr-seed-20260915-hour/`. Old saved identities from earlier chain deployments cannot be assumed valid after a reset.

1. Use the environment for the network under test and verify an identity exists on that current network before interpreting a write failure.
2. Load test secrets programmatically; never paste keys/mnemonics into reports, terminal logs or screenshots.
3. For this target, use the `devnet:` storage namespace. The older generic `testing:` instructions are not interchangeable with a `/devnet` build.
4. Follow the current fixture code for session/key serialization and skip-DPNS state. A recognized local session alone does not prove the remote identity is funded.
5. Verify credits and any action-specific YAPP cost before writes. Bookmarks must not be described as requiring YAPP.
6. After a successful mutation, validate with a new independent browser context, and with the other identity where relevant.

Rate limiting is no longer used as an explanation for unfinished coverage. Remaining flows above are explicitly uncertified, not assumed impossible or automatically passed.

## Platform/GroveDB attribution

The validated app defects do not establish a Dash Platform or GroveDB bug. Stale identity errors, expected balance rejections, missing client context, and invalid proposed document properties cannot be attributed to backend corruption. Public reads and the tested DM state transition succeeded. No claim is made about consensus, proof soundness, or all backend mutation paths.
