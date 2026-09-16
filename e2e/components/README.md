# Isolated browser component regressions

Run `npm run test:components` after `npx playwright install chromium`. This uses a
separate Vite/Playwright configuration and does not join the live-network tests
in `e2e/smoke` or `e2e/write`. It requires no identity, credentials, or Platform
writes. These are functional regression tests, not evidence of live-chain behavior
or screenshots for visual review.

The private-feed fixture renders the real `PrivateFeedSettings` and real toast
UI. It uses the real `lib/secure-storage.ts`, platform-auth browser secret store,
WIF normalization, and browser localStorage. Explicit Vite aliases replace only
auth/vault operations, feed/identity services, key-on-identity validation, the
key-entry modal hook, and unrelated dialogs. External requests are blocked and
asserted absent. Every test gets a fresh browser context and uses public scalar 1,
which must never be used with an actual identity or funds.

The three successful-chain cases cover normal persistence before vault merge,
a swallowed localStorage key-write failure with null readback, and a rejected
vault merge while the local key remains available. Each verifies refreshed
enabled UI, the correct success/warning toasts, and absence of a misleading
"Failed to enable private feed" toast. The storage failure affects only the
synthetic encryption-key entry; storage availability checks still succeed.
