# Migration Plan

## Goal

Move Yappr onto `platform-auth` without changing auth behavior.

## Recommended order

1. Keep Yappr UI in place.
2. Replace `contexts/auth-context.tsx` internals with a thin wrapper around `PlatformAuthController`.
3. Implement Yappr adapters for:
   - session store
   - secure secret store
   - identity lookup
   - DPNS resolution
   - profile existence checks
   - platform client identity injection
   - unified vault operations
   - passkey operations
   - legacy password fallbacks
   - post-login side effects
4. Map controller intents to current Yappr behavior:
   - `username-required` -> open username modal
   - `profile-required` -> route to profile creation
   - `ready` -> route to feed
   - `logged-out` -> route to login
5. Once Yappr is stable, reuse the same controller in `pollr` with a different UI and side-effect adapter set.

## Behavioral invariants to test during migration

- session restore fails when the auth private key is absent
- direct key login still opens username registration before profile routing
- password login preserves unified-vault -> legacy-vault -> encrypted-backup fallback order
- passkey login still filters to the current RP ID
- wallet login still stores no partial secrets on failure
- logout still clears all local secrets and caches

## Suggested next extraction targets from Yappr into this package

- pure auth-vault crypto helpers
- passkey PRF helpers
- login-key derivation helpers
- WIF and key parsing helpers needed by the controller crypto port

Those are portable enough to live in `platform-auth` after the first adapter-based rollout.
