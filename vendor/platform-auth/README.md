# @pastapastapasta/platform-auth

`@pastapastapasta/platform-auth` is a reusable authentication toolkit for Dash Platform applications.

The project is intended for app developers who want a consistent, configurable auth stack for Platform-based web apps without hard-coding auth flow logic into each individual product.

## Scope

`@pastapastapasta/platform-auth` focuses on orchestration, session state, and integration boundaries.

It is designed to help applications compose and reuse:

- identity-based sign-in
- password-unlock flows
- passkey-unlock flows
- wallet or login-key based sign-in flows
- Yappr-compatible wallet key exchange with QR-based login and first-login key registration
- auth-vault enrollment and secret merging
- session restore and logout behavior
- username and balance refresh
- application-specific post-login hooks

## Design

The project is headless-first.

That means the core package owns auth state and flow coordination, while each application keeps control over:

- branding and UI
- routing
- storage implementation details
- Dash service adapters
- optional product-specific side effects

This keeps the auth engine reusable across multiple apps with different onboarding, navigation, and feature sets.

## Package Structure

- `PlatformAuthController`: the core auth orchestration engine
- `PlatformAuthProvider` and `usePlatformAuth`: React bindings for consuming controller state
- typed adapter interfaces: contracts for storage, identity lookup, usernames, vaults, passkeys, and side effects
- Yappr-compatible key-exchange module: protocol helpers, transport polling, registration helpers, and React hooks

## Integration Model

Applications integrate `@pastapastapasta/platform-auth` by providing adapters for their own environment.

Typical adapters include:

- session persistence
- secret storage
- identity and DPNS lookups
- profile existence checks
- passkey operations
- auth-vault reads and writes
- key-exchange response queries and key-registration transition building
- app-specific post-login tasks

The package returns state, methods, and high-level intents. The host app decides how those intents map to routes, dialogs, or other UI.

## Yappr-Compatible Key Exchange

`@pastapastapasta/platform-auth` now ships a first-class, headless Yappr-compatible key-exchange module.

That module includes:

- `dash-key:` URI helpers
- ECDH + AES-GCM login-key decryption helpers
- polling utilities for `loginKeyResponse` documents
- `dash-st:` URI helpers for first-login key registration
- React hooks:
  - `useYapprKeyExchangeLogin(controller, options?)`
  - `useYapprKeyRegistration(controller, onComplete?, options?)`

The hooks are headless. Apps render their own QR code, timers, errors, and success states while the package keeps the protocol, timers, and state transitions consistent.

## Minimum Integration

To enable the shared Yappr-compatible flow in an app:

1. Create a `PlatformAuthController` with the normal auth adapters.
2. Provide `yapprKeyExchangeConfig` with:
   - `appContractId`
   - `keyExchangeContractId`
   - `network`
   - optional label and timeout overrides
3. Provide a `yapprKeyExchange` adapter that can:
   - query a wallet response by `(contractId, appEphemeralPubKeyHash)`
   - build an unsigned key-registration transition
   - verify whether the derived keys already exist on the identity
4. Use `useYapprKeyExchangeLogin(...)` and `useYapprKeyRegistration(...)` in app-owned UI.
5. Complete login with `controller.completeYapprKeyExchangeLogin(...)` or the lower-level `controller.loginWithLoginKey(...)`.

This keeps the package reusable across apps while allowing each app to keep its own styling, routing, and SDK/service wiring.

## Goals

- make Platform auth reusable across applications
- preserve app behavior while removing auth orchestration from app code
- keep flows individually configurable and disableable
- support multiple storage and contract strategies
- avoid coupling the package to a single app’s UI

## Non-Goals

- shipping a single branded login modal for all apps
- forcing one routing model or onboarding sequence
- bundling app-specific product logic into the core controller

## Current Status

The project currently provides the reusable controller, React bindings, adapter contracts, and a Yappr-compatible key-exchange module for QR-based wallet login flows.

## Installation

```bash
npm install @pastapastapasta/platform-auth
```

For GitHub Packages installs, configure npm for the `@pastapastapasta` scope:

```ini
@pastapastapasta:registry=https://npm.pkg.github.com
```

Implementation notes from the initial extraction work are kept in [`docs/`](./docs), including app-specific migration material and an integration guide for the reusable key-exchange module.

## Development

```bash
npm install
npm run lint
npm run build
```
