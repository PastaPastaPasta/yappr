# Isolated browser component regressions

Run `npm run test:components` after `npx playwright install chromium`. This uses a
separate Vite/Playwright configuration and does not join the live-network tests
in `e2e/smoke` or `e2e/write`. It requires no identity, credentials, or Platform
writes. These are functional regression tests, not evidence of live-chain behavior
or screenshots for visual review.

The private-feed fixture renders the real `PrivateFeedSettings` and real toast
UI. It uses the real `lib/secure-storage.ts`, platform-auth browser secret store,
WIF normalization, and browser localStorage. Explicit Vite aliases replace only
auth, feed/identity services, key-on-identity validation, the
key-entry modal hook, and unrelated dialogs. External requests are blocked and
asserted absent. Every test gets a fresh browser context and uses public scalar 1,
which must never be used with an actual identity or funds.

The first three successful-chain cases cover normal persistence, a swallowed
localStorage key-write failure with null readback, and a swallowed write failure
over a stale key for the same identity (non-null readback holding the wrong
secret, which must be dropped). A fourth case submits the
prefilled, already-stored derived key unchanged and checks that its 'derived'
type label is kept rather than relabelled as external. Each verifies refreshed
enabled UI, the correct success/warning toasts, and absence of a misleading
"Failed to enable private feed" toast. The storage failure affects only the
synthetic encryption-key entry; storage availability checks still succeed.

The QA round-one suite runs second with its own Vite boundaries, rendering the
real messages, post, profile, inventory, checkout, store and shipping-management
pages against canned read-only services. It covers every finding in the release
QA's DM, private-feed, social and store lanes. CSV download checks verify that
digital listings are excluded with a visible explanation, including when a
listing is archived; digital-only inventory produces no download. Geometry
assertions verify mobile network-label clearance and dismissal without taking
screenshots. The wallet case in the original fixture checks wallet-specific
private-feed setup copy. No fixture submits an order or other network write.
