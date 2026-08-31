# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
npm run dev      # Start development server
npm run build    # Build for production
npm run lint     # Run linting
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

### 2. Run the Build
```bash
npm run build
```
- Ensures TypeScript compilation succeeds
- Verifies static export works correctly
- Catches missing imports, type errors, and build-time issues
- Do not commit code that fails to build

### 3. Run the End-to-End Tests
```bash
npm run build:testing   # build the /testing bundle the tests run against
npm run test:e2e
```
- Runs Playwright against the real static export talking to real Dash testnet
- Without secrets, only the read-only `smoke` project runs; the `write` project self-skips
- The full suite needs `E2E_SEED_PHRASE` (in gitignored `.env.local`) and performs real state transitions against the dedicated test contracts in `.env.testing` — never production
- See `docs/TESTING.md` for the identity pool, provisioning, and known quirks

### 4. Code Review for Complex Changes
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

### 5. Manual Verification (when applicable)
- For UI changes: Run `npm run dev` and visually verify the changes
- For new features: Test the happy path and common error cases
- For bug fixes: Confirm the original issue is resolved

### Validation Summary
| Check | Command | Required |
|-------|---------|----------|
| Linter | `npm run lint` | Always |
| Build | `npm run build` | Always |
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
- Domain services: `post-service.ts`, `profile-service.ts`, `like-service.ts`, `follow-service.ts`, etc.

### Authentication System
- `contexts/auth-context.tsx` manages user sessions and exposes the `withAuth` HOC
- It delegates to the vendored `platform-auth` controller (`vendor/platform-auth`) through the adapters in `lib/auth/platform-auth-adapters.ts`
- Private keys live in the browser secret store built in `lib/secure-storage.ts` (localStorage, keys prefixed `yappr_secure_`); passkey/PRF unlock is in `lib/webauthn/passkey-prf.ts`
- State transitions retrieve private keys on-demand for signing

### Data Contract Structure
The deployed social contract (`contracts/yappr-social-contract-v2.json` on staging/prod; the /devnet build runs the v5 contract, `contracts/yappr-social-contract-v5.json`) defines 16 document types:
- `profile` - User data (name, bio, avatar/banner references)
- `post`, `reply` - Content; `post` is 500 chars, optional media
- `like`, `repost`, `follow`, `followRequest` - Social interactions
- `bookmark`, `block`, `blockFilter`, `blockFollow` - User preferences and moderation
- `postHashtag`, `postMention` - Discovery indexes written alongside posts
- `privateFeedGrant`, `privateFeedRekey`, `privateFeedState` - Private (encrypted) feed key management

Not in this contract:
- Direct messages live in the separate DM contract (`contracts/yappr-dm-contract.json`)
- Notifications are derived client-side from other document types, not stored
- `list` / `listMember` / `mute` were dropped when the v2 contract was cut (never implemented; `block` covers muting)

Additional contracts back specific features: storefront (7 types), DM, blog, vault/auth-vault, key exchange, encrypted key backup, and the externally-owned Pollr contract. The standalone hashtag, mention, and block contracts are gone — those doctypes moved into the social contract, and `lib/constants.ts` no longer carries their contract IDs.

**IMPORTANT**: Documents use `$ownerId` (platform system field), NOT custom `authorId`/`userId` fields. When creating documents, only include content fields - ownership is automatic.

### DPNS Integration
- Usernames managed through Dash Platform Name Service
- Profile documents don't store usernames directly
- `lib/services/dpns-service.ts` and `components/dpns/` handle name resolution

### Important Patterns

1. **State Management**: Zustand store in `lib/store.ts`
2. **Styling**: Tailwind CSS with custom design system in `tailwind.config.js`
3. **UI Components**: Radix UI primitives in `components/ui/`
4. **Mock Data**: `lib/mock-data.ts` for development when not connected to Dash Platform

### Known Issues

#### DAPI Gateway Timeouts
`wait_for_state_transition_result` frequently times out with 504 errors even when transactions succeed. The app handles this by:
- Using short timeout for confirmation wait
- Assuming success if broadcast succeeded but wait times out
- Updating UI immediately after broadcast
