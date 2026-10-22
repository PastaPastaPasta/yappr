# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
npm run dev        # Start development server
npm run build      # Build for production
npm run lint       # ESLint over app/ components/ contexts/ hooks/ lib/ types/; warnings fail
npm run test       # Vitest unit tests (lib/**/*.test.ts)
npm run lint:dead  # knip: unused files, exports, and dependencies
```

## Workflow

When completing a task, commit the changes automatically unless directed otherwise.

## Validating Changes

**Always validate your changes before committing.** Follow this checklist:

### 1. Run the Linter
```bash
npm run lint
```
- Fix all errors and warnings properly (see Code Quality Guidelines below)
- Do not commit code with linter failures

### 2. Run the Unit Tests
```bash
npm run test
```
- Pure modules under `lib/` (crypto primitives, codecs, parsers) have Vitest specs next to them as `*.test.ts`
- Add or extend a spec when touching one of these modules; anything that needs the SDK or a browser belongs in `e2e/`

### 3. Run the Build
```bash
npm run build
```
- Ensures TypeScript compilation succeeds
- Verifies static export works correctly
- Catches missing imports, type errors, and build-time issues
- Do not commit code that fails to build

### 4. Run the End-to-End Tests
```bash
npm run build:testing   # build the /testing bundle the tests run against
npm run test:e2e
```
- Runs Playwright against the real static export talking to real Dash testnet
- Without secrets, only the read-only `smoke` project runs; the `write` project self-skips
- The full suite needs `E2E_SEED_PHRASE` (in gitignored `.env.local`) and performs real state transitions against the dedicated test contracts in `.env.testing` — never production
- See `docs/TESTING.md` for the identity pool, provisioning, and known quirks

### 5. Code Review for Complex Changes
For complex or multi-file changes, use a code review sub-agent to identify potential issues:

```
Use the Task tool with subagent_type=Plan to review the changes for:
- Logic errors or edge cases
- Security vulnerabilities (XSS, injection, etc.)
- Consistency with existing patterns in the codebase
- Missing error handling
- Potential performance issues
```

**Trust but verify**: The review agent may flag potential issues that aren't actually problems, or miss real issues. Treat its output as suggestions to investigate, not definitive judgments. Verify each finding before acting on it.

### 6. Manual Verification (when applicable)
- For UI changes: Run `npm run dev` and visually verify the changes
- For new features: Test the happy path and common error cases
- For bug fixes: Confirm the original issue is resolved

### Validation Summary
| Check | Command | Required |
|-------|---------|----------|
| Linter | `npm run lint` | Always |
| Unit tests | `npm run test` | Always |
| Build | `npm run build` | Always |
| Dead code | `npm run lint:dead` | When adding or removing modules/exports |
| End-to-End | `npm run build:testing && npm run test:e2e` | Changes touching feeds, posts, or auth flows |
| Code Review | Task sub-agent | Complex changes |
| Dev Server | `npm run dev` | UI changes |

## Code Quality Guidelines

### Linter Errors and Warnings
**Always fix linter issues properly.** Do not suppress, disable, or work around linter warnings without a genuinely compelling reason.

**Do NOT:**
- Add `// eslint-disable-next-line` comments to silence warnings
- Use `@ts-ignore` or `@ts-expect-error` to bypass TypeScript errors
- Add `any` types to avoid proper typing
- Rename unused variables with `_` prefix just to quiet the linter
- Use `void` to silence floating promise warnings (e.g., `void someAsyncFn()`)
- Use other suppression patterns that hide problems rather than fix them

**Instead:**
- Fix the underlying issue the linter is flagging
- If a variable is unused, remove it entirely
- If a type is wrong, correct the type properly
- If code triggers a legitimate warning, refactor the code
- For floating promises, add proper `.catch()` error handling

Linter rules exist to catch real problems. Suppression comments should be rare exceptions with clear justification, not a standard way to make warnings disappear.

## Architecture Overview

Yappr is a decentralized social media platform built with Next.js 14 and Dash Platform.

### **CRITICAL: Fully Decentralized - No Backend**
This app is fully decentralized with **NO backend server**. All code and architecture must be compatible with a **fully static export** (configured via `output: 'export'` in `next.config.js`). The only "backend" is Dash Platform DAPI requests made directly from the client.

**Do NOT introduce:**
- Server-side API routes (`/api/*`)
- Server-side rendering that requires a Node.js server
- Database connections or server-side state
- Any architecture requiring a hosted backend
- Dynamic routes (e.g., `[id]`, `[slug]`, `[...params]`) - only static routes are allowed

**Routing constraint:** All routes must be statically defined. Use query parameters (e.g., `/post?id=123`) instead of dynamic path segments (e.g., `/post/[id]`). This ensures the app can be fully exported as static files.

**All data operations must go through:**
- Dash Platform DAPI (via `@dashevo/evo-sdk`)
- Client-side storage (localStorage, sessionStorage, IndexedDB)

### Parallel `/testing` Deployment
A second copy of the app is deployed at `https://yap.pr/testing/` from the same master commit as production. It is built with `npm run build:testing`, which sources the checked-in `.env.testing` to point at **dedicated test data contracts**, and namespaces all persisted browser storage under a `testing:` prefix (`lib/storage-scope.ts`). This is what the Playwright e2e suite runs against, so automated writes never touch production state. See `docs/TESTING.md`.

### SDK Integration
- Uses `@dashevo/evo-sdk` package for Dash Platform operations
- `lib/services/evo-sdk-service.ts` manages SDK initialization and connection
- SDK runs in trusted mode with 8-second timeout for network requests
- Contract ID and network config in `lib/constants.ts`
- **Index ordering**: Dash Platform indices support both `asc` and `desc` queries regardless of how the index is defined in the contract. Don't assume an index only works in one direction.

### Services Layer (`lib/services/`)
Singleton service classes handle all Dash Platform operations:
- `evo-sdk-service.ts` - SDK initialization and connection management
- `state-transition-service.ts` - All write operations (creates/updates documents)
- `document-service.ts` - Query operations for reading documents
- `identity-service.ts` - Identity lookup and balance queries
- `dpns-service.ts` - Username resolution via DPNS
- Domain services: `post-service.ts`, `unified-profile-service.ts`, `like-service.ts`, `follow-service.ts`, etc.

### Authentication System
- `contexts/auth-context.tsx` manages user sessions and exposes the `withAuth` HOC
- It delegates to the vendored `platform-auth` controller (`vendor/platform-auth`) through the adapters in `lib/auth/platform-auth-adapters.ts`
- Private keys live in the browser secret store built in `lib/secure-storage.ts` (localStorage, keys prefixed `yappr_secure_`). Sign-in is App Connect (wallet), the wallet's recovery phrase (App Connect builds: `lib/auth/recovery-phrase-sign-in.ts` derives the identity, its sign-in key and its DIP-13 7' messaging key as a Dash wallet does, `lib/crypto/dip13.ts`; the phrase is never stored), or a typed-in private key (`lib/auth/login-key.ts`, under "Advanced" on App Connect builds); a CRITICAL key typed in on an App Connect build stays in the tab only. Encrypted features on App Connect builds come only from a wallet-equivalent key (D38): a messaging key derived from a typed-in key is a developer option. A passkey can sign either session back in on yap.pr: `lib/auth/passkey-vault.ts` seals the session's keys to the passkey's PRF key in the passkey vault contract (`docs/PASSKEY_VAULT.md`)
- State transitions retrieve private keys on-demand for signing

### Data Contract Structure

The release set is social **v18**, blocks, **DM v5**, **blog v10**,
**storefront v11**, **pollr v8** and the passkey vault
(`contracts/yappr-passkey-vault-contract.json`, [docs/PASSKEY_VAULT.md](docs/PASSKEY_VAULT.md)),
all members of one App Connect anchor's permanent contract group.
`scripts/app-connect-set.mjs` owns the files, hashes and registration order.
Social v18, blog v10 and storefront v11 are "hide, don't delete"
([docs/SOCIAL_V18.md](docs/SOCIAL_V18.md)): moderators never delete, they hide
with the moderator-only `mod` lane every listing carries (read `mod == null`),
and they restrict authors (`live` 1 or 2) instead of banning them. Do not
resurrect the password-era vault, key backup, key exchange or DM v4 for the
release (D9/D10).

**Keep deployment states separate.** The first release set (social v17, blog
v9, storefront v10 and the members above) was registered on testnet on
2026-10-21; the owner then abandoned its social, blog and storefront (D42).
They stay in the group, unused: never file charters on them and never point a
build at them. Social v18, blog v10 and storefront v11 join the same group
(`register-app-connect-contracts --append-after passkeyVault`); until they are
registered and an activation PR pins them, the checked-in `.env.testnet`
still names v17, which `npm run build` loads for `/staging` (D20) and, once
the owner merges staging into master, for root. Until that merge, master's root still selects
social **v2**, DM **v3**, the old feature contracts and legacy login, and
`/testing` still runs v2 through the `lib/constants.ts` defaults.
`.env.devnet` selects Sakura **social v16**, blog **v8**, storefront **v9**,
pollr **v7**, DM **v5** and App Connect. Keep paths used by any current build
until the legacy cleanup (WP17) removes them.
The legacy v2 schema still has 500-character posts, a standalone profile,
and `postHashtag`/`postMention` discovery documents.
See [contracts/README.md](contracts/README.md),
[docs/TESTNET_RELEASE.md](docs/TESTNET_RELEASE.md) and
[docs/RELEASE_CLEANUP.md](docs/RELEASE_CLEANUP.md).

The modern social contract owns posts (up to 1,000 characters), replies,
quotes/reposts, likes, follows, bookmarks, discovery indexes, profile
extensions, private-feed records and moderator-resolved reports. Blocks live
in their own contract. DashPay's system profile plus `yapprProfile` replace
the legacy standalone profile on modern cuts. Notifications are derived
client-side from writes and proved indexes rather than stored in a social
notification document. Exact feature and index support goes through
`lib/contract-topology.ts`; don't guess a deployment from a versioned file.

**Ownership:** use Platform's `$ownerId`, never an invented `authorId` or
`userId`. Explicit target-owner fields exist only where a schema requires
them. Never add system ownership fields to document content.

Superseded topology designs and deployment experiments live in
[docs/archive](docs/archive/README.md). Current `/devnet` v16, the registered
v17 and the release v18 documentation remain outside that archive.

### DPNS Integration
- Usernames managed through Dash Platform Name Service
- Profile documents don't store usernames directly
- `lib/services/dpns-service.ts` and `components/dpns/` handle name resolution

### Important Patterns

1. **State Management**: Zustand store in `lib/store.ts`
2. **Styling**: Tailwind CSS with custom design system in `tailwind.config.js`
3. **UI Components**: Radix UI primitives in `components/ui/`
4. **Default avatars**: `unifiedProfileService.getDefaultAvatarUrl` (`lib/services/unified-profile-service.ts`) generates the DiceBear placeholder used when a profile has no avatar

### Known Issues

#### DAPI Gateway Timeouts
`wait_for_state_transition_result` frequently times out with 504 errors even when transactions succeed. The app handles this by:
- Using short timeout for confirmation wait
- Assuming success if broadcast succeeded but wait times out
- Updating UI immediately after broadcast
