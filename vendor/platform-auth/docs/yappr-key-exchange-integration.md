# Yappr-Compatible Key Exchange Integration

`platform-auth` ships a headless Yappr-compatible key-exchange module so apps can reuse the QR login flow without reimplementing the protocol.

## What the package owns

- `dash-key:` request URI generation
- ephemeral keypair generation
- wallet-response polling
- ECDH shared-secret derivation and login-key decryption
- derived auth/encryption key calculation
- first-login detection
- `dash-st:` registration URI generation
- React hook state machines for login and registration

## What the host app provides

The host app still provides the environment-specific adapters:

- a `PlatformAuthController`
- `yapprKeyExchangeConfig`
- a `yapprKeyExchange` adapter with:
  - `getResponse(...)`
  - `buildUnsignedKeyRegistrationTransition(...)`
  - `checkKeysRegistered(...)`
- QR presentation UI
- routing / modal behavior
- any product-specific post-login prompts

## Expected config

The shared Yappr-compatible flow expects:

- `appContractId`: the target application contract ID embedded in `dash-key:` requests
- `keyExchangeContractId`: the data contract that stores `loginKeyResponse` documents
- `network`: `mainnet`, `testnet`, or `devnet`
- optional overrides for `label`, `pollIntervalMs`, and `timeoutMs`

If no overrides are provided, the package preserves Yappr's current defaults:

- label: `Login to Yappr`
- poll interval: `3000`
- timeout: `120000`

## Typical usage

1. Create a `PlatformAuthController` with your normal auth dependencies plus `yapprKeyExchange` and `yapprKeyExchangeConfig`.
2. Call `useYapprKeyExchangeLogin(controller)` inside your QR/login modal.
3. Render the returned `uri`, timer, and error state in app-owned UI.
4. When the hook reaches `complete`, call `controller.completeYapprKeyExchangeLogin(...)`.
5. If the hook reaches `registering`, render UI backed by `useYapprKeyRegistration(controller, onComplete)`.

## Preserved behavior

The package intentionally preserves Yappr's current protocol and flow behavior:

- same URI formats
- same timer defaults
- same login state transitions
- same first-login registration check
- same expectation that apps own the actual modal markup and branding
