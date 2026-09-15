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

| QA-10 | Medium: hidden-menu accessibility | The visually closed mobile More sheet remains exposed in the accessibility tree; invisible controls can receive keyboard focus. This is separate from the withdrawn visual duplicate-navigation claim. | Separate focused fix in progress. | Pending |
| QA-11 | Medium: wrong deployment navigation | A real published devnet article embeds successfully, but its footer opens root testnet and shows Blog not found. Generated iframe/script snippets and the loader also drop the deployment path. | Preserve the build deployment path in snippets, loader and article footer. | [#417](https://github.com/PastaPastaPasta/yappr/pull/417) |

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

Source changes received local builds and relevant lint/tests. Current PR checks must be read from GitHub; a skipped check is not counted as a pass, and a CodeRabbit success status can represent a skipped review. Published image verification checks HTTP status, content type and SHA-256 against the inspected local files, followed by inspection of the rendered PR.

## Corrections to the original findings

| Earlier claim | Corrected disposition |
|---|---|
| Deterministic first DM loss; P0 | Retracted. A first message persisted and decrypted in fresh sender and recipient contexts on unchanged staging. This validates one supported key/session configuration, not every key type. |
| Fix first DM by adding `recipientId` | Invalid. The live lean DM contract forbids that extra property. [#409](https://github.com/PastaPastaPasta/yappr/pull/409) is closed; its synthetic screenshot is removed from the description. |
| Auth Vault/encryption/password/passkey controls absent | Retracted. Real settings show Enter Key, Add Password Unlock and Add Passkey. Enter Key and Enable Private Feed open the expected forms. Enrollment/publication was not completed in this revalidation. |
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
| Browse following feed | Feed | Page/read surface observed; follow-write-to-feed propagation remaining. |
| Search users, hashtags and content | Search | Entry/results surfaces observed; empty, repeated, pagination and special-character cases remaining. |
| Browse a hashtag | Hashtag | Missing-context guidance inspected; populated pagination remaining. |
| View mentions | Mentions | Guest guidance inspected; two-account mention notification cycle remaining. |
| Open a post and its thread | Post | Current post fixture used for accessibility captures; reply/write/readback cycle remaining. |
| View engagement lists | Post engagements | Route visited; consistency after writes remaining. |
| Discover and view profiles | User | Seeded profile reads observed; missing/invalid/deleted identity permutations remaining. |
| Create a new funded identity | Login/create-account flow | Entry UI inspected. New identity funding/registration ceremony not certified. |
| Restore a session with an authentication key | Login/session | Revalidated with current seeded identities and fresh browser contexts. |
| Sign in via external wallet QR | Login | Entry UI inspected; real external-wallet ceremony remaining. |
| Enroll and sign in with a passkey | Login/settings | Control availability revalidated; full ceremony remaining. |
| Add password unlock and sign in | Login/settings | Control availability revalidated; full enrollment/lock/unlock remaining. |
| Recover/replace a missing key | Settings | Recovery entry visible; recovery workflow remaining. |
| Finish first-run onboarding | Welcome | Surface inspected; fresh-account completion remaining. |
| Create/edit a profile | Profile create/settings | Surface observed; persisted edit/readback and failure recovery remaining. |
| Choose avatar/banner and social links | Profile settings | Surface inventoried; media upload/save/readback remaining. |
| Add a profile payment destination | Profile payment input | Malformed Dash validation addressed by #410; on-chain transfer not exercised. |
| Register/manage a DPNS username | DPNS register | Entry surface inspected; paid registration/conflict/readback remaining. |
| Compose a public post | Composer | Revalidated with persona30: post creation success toast, modal closes, and an independent session displays saved post `9mcdDNznWP86bScjmMykF1kzNpecneoFoZVVNAB5qCFd`. |
| Reply and compose a thread | Composer/post | Inventory only beyond entry UI; publish/readback remaining. |
| Attach media to a post | Composer/storage | Upload/provider flows remaining. |
| Create/vote on a poll | Composer/poll | Full two-account cycle remaining. |
| Edit/delete own content | Post options | Menu access covered separately; persistence cycle remaining. |
| Like/unlike, repost/undo and quote | Post actions | Names/tooltips covered by #413; persona32 like/unlike with fresh-session readback passed. Repost/quote cycles continuing. |
| Bookmark/unbookmark | Post/bookmarks | Accessible state covered by #413; persona32 bookmark/unbookmark and independent-session readback both passed. |
| Share a post/copy link | Post actions | Control naming covered by #413; clipboard/share-sheet destinations remaining. |
| Follow/unfollow another identity | Profile/connection lists | Read surfaces observed; full two-account transition remaining. |
| View own followers/following | Connection lists | Authenticated no-id default intentional; preserve in QA-08. |
| View another user's followers/following | Connection lists | Explicit-id route supported; guest missing-context recovery in progress. |
| Block/unblock and consume trusted block lists | Privacy & Security | Settings visible; behavioral filtering/readback remaining. |
| Read/mark/filter notifications | Notifications/settings | Entry surface observed; event-trigger/readback cycle remaining. |
| Enter encryption key | Privacy & Security | Real key-entry dialog revalidated; no secret entered in published captures. |
| Enable and publish a private feed | Private Feed | Setup controls revalidated; successful publish remaining. |
| Request/approve/revoke private-feed access | Private Feed/profile | Two-account access and revocation cycles remaining. |
| Send the first direct message | Messages | Revalidated: real send, fresh sender readback, fresh recipient decryption. |
| Continue/reload a conversation | Messages | Existing-message readback revalidated; concurrent replies and pagination remaining. |
| Discover stores/items | Store/item | Routes and seeded items observed; full filtering/stock permutations remaining. |
| Create/manage a store | Store create/manage | Earlier current-persona creation succeeded; repeat evidence lacks full provenance. No fresh completion claimed. |
| Configure store payment methods | Payment modal | Invalid Dash acceptance reproduced; #410 validates modal/profile/import paths. |
| Create/manage inventory/products | Store inventory/item add | Earlier creation observed; update/delete/stock cycles remaining. |
| Add/remove items and retain cart | Item/cart | Earlier add-to-cart/persistence observed; mixed-store/quantity/stock edges remaining. |
| Save shipping information | Checkout/settings | Encryption prerequisite visible; save/readback remaining. |
| Checkout and pay as another buyer | Checkout | Full funded buyer/seller payment cycle remaining. |
| Track/cancel/fulfill an order | Orders/seller orders | Empty states observed; complete transition cycle remaining. |
| Review a purchased product | Orders/item | Full eligible purchase/review cycle remaining. |
| Discover/create a blog | Blog | Current-persona create and My Blogs success previously observed; dialog accessibility revalidated in #412. |
| Configure blog theme and metadata | Blog settings | Inventory only; saved customization/readback remaining. |
| Publish/edit/delete a blog article | Blog editor | A real QA article was published through the normal editor and read back signed out; edit/delete cycles remaining. |
| Read/comment on a blog article | Blog viewer | Complete comment cycle remaining. |
| Embed an article and recover a broken link | Embed | Missing/empty-ID offline recovery revalidated in #407; successful embed navigation exposed QA-11; correction in #417. |
| Navigate on mobile/by keyboard/screen reader | Navigation/post/dialogs | Specific action/dialog defects receive separate PRs; not a blanket accessibility certification. |
| Change appearance/storage/provider preferences | Settings | Entry surfaces observed; persistence and provider integrations remaining. |
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
