# Yappr Auth Review

This review maps Yappr’s current authentication behavior into extraction targets for `platform-auth`.

## Current orchestration hub

Yappr’s runtime auth orchestration is concentrated in `contexts/auth-context.tsx`. That file currently combines:

- persisted session restore
- direct auth-key login
- password login with three generations of fallback storage
- passkey login through the unified auth vault
- wallet QR / login-key login
- auth-vault enrollment and secret merging
- logout cleanup
- DPNS and balance refresh
- post-login product side effects
- React context state
- routing and modal decisions

That is the core extraction problem. The logic is reusable, but it is mixed with React and Yappr-specific UI actions.

## Concrete Yappr flows to preserve

### 1. Session restore

Current behavior:

- load `yappr_session` from local storage
- reject the session if the matching auth private key is missing from secure storage
- restore the in-memory user
- set the platform client identity
- backfill username in the background if missing
- run post-login background tasks

Behavioral invariant:

- a saved session without a saved auth key is invalid and must be cleared

### 2. Direct auth-key login

Current behavior:

- fetch identity
- resolve DPNS username
- persist session snapshot
- persist auth private key
- set platform client identity
- try to derive the encryption key in the background
- if no username exists, stop at username registration
- otherwise check whether a profile exists
- route either to the main app or profile creation

Behavioral invariants:

- key derivation is non-blocking
- missing username short-circuits before profile routing
- profile routing happens only after username gating

### 3. Password login

Current behavior:

- attempt unified auth vault first
- fall back to legacy vault contract
- fall back again to encrypted-key-backup contract
- preserve the current invalid-password semantics across all fallbacks
- once a secret is recovered, continue through the same direct-login path

Behavioral invariant:

- password login is not a separate session model; it unwraps into the same direct auth-key session model

### 4. Passkey login

Current behavior:

- only supported through the unified auth vault
- identity-specific and discoverable-passkey flows are both supported
- RP ID filtering is enforced
- passkey credentials are matched through stored credential hashes
- unlocked vault contents are restored into the same direct-login session model

Behavioral invariant:

- passkey login is a vault unlock strategy, not a separate identity model

### 5. Login-key / wallet key-exchange login

Current behavior:

- receive login key from wallet QR flow
- derive auth and encryption keys from the login key
- store login key
- continue through normal direct auth-key login
- store derived encryption key only after login succeeds
- create or update unified auth vault in the background
- merge QR-derived secrets into the vault in the background

Behavioral invariants:

- wallet login must not persist partial secrets on failure
- auth-key login remains the canonical session path even for wallet login

### 6. Auth vault enrollment and merge rules

Current behavior:

- prefer merging into an already unlocked vault
- if no active DEK exists, try to unlock the vault through a local-site passkey
- otherwise require the user to unlock the vault elsewhere before mutating it
- bundle contents may include login key, auth key, encryption key, and transfer key

Behavioral invariants:

- vault mutation is allowed only when the vault is already unlocked on the device or can be unlocked by an existing site passkey
- creating a vault requires either a login key or an auth key

### 7. Logout

Current behavior:

- clear saved session
- clear transient DPNS and backup prompt flags
- clear all sensitive secrets for the identity
- clear block and private-feed caches
- clear client identity
- redirect to login

Behavioral invariant:

- logout is a hard local secret reset

## Main extraction seams

### Good package candidates

- auth session controller logic
- vault orchestration logic
- passkey orchestration logic
- login-key orchestration logic
- session persistence contracts
- secret storage contracts
- auth events and route intents
- React provider and hooks

### Keep app-specific

- branded modals and copy
- exact route paths like `/feed`, `/profile/create`, `/login`
- global modal stores
- Yappr-only post-login tasks:
  - block cache warmup
  - DashPay contact suggestions
  - private feed follower sync

## Why a prebuilt UI does not belong in v1

Yappr’s UI makes product decisions that are not auth-engine decisions:

- when to show backup prompts
- which route to open on dismissal
- which onboarding copy to display
- when to offer passkey enrollment
- which post-login task failures are visible

Those should stay in the application layer. A portable auth package should return intents and events, not ship a rigid modal system.

## Package decision for v1

`platform-auth` should be:

- headless in the core layer
- React-friendly through a provider and hook
- fully adapter-driven for storage, Dash services, passkeys, and vaults
- feature-flagged so flows are individually disableable

That preserves behavior without locking future apps into Yappr’s UI.
