# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
npm run dev      # Start development server
npm run build    # Build for production
npm run lint     # Run linting
```

### Dash Platform Scripts
```bash
node register-contract.js           # Register contract on Dash Platform
node test-dpns-resolve.js           # Test DPNS resolution
```

## Architecture Overview

Yappr is a decentralized social media platform built with Next.js 14 and Dash Platform.

### SDK Integration
- Uses `@dashevo/evo-sdk` package for Dash Platform operations
- `lib/services/evo-sdk-service.ts` manages SDK initialization and connection
- SDK runs in trusted mode with 8-second timeout for network requests
- Contract ID and network config in `lib/constants.ts`

### Services Layer (`lib/services/`)
Singleton service classes handle all Dash Platform operations:
- `evo-sdk-service.ts` - SDK initialization and connection management
- `state-transition-service.ts` - All write operations (creates/updates documents)
- `document-service.ts` - Query operations for reading documents
- `identity-service.ts` - Identity lookup and balance queries
- `dpns-service.ts` - Username resolution via DPNS
- Domain services: `post-service.ts`, `profile-service.ts`, `like-service.ts`, `follow-service.ts`, etc.

### Authentication System
- `contexts/auth-context.tsx` manages user sessions
- Private keys stored via secure storage (`lib/secure-storage.ts`)
- State transitions retrieve private keys on-demand for signing

### Data Contract Structure
The registered contract (`contracts/yappr-social-contract-actual.json`) defines 12 document types:
- `profile`, `avatar` - User data (separate for flexibility)
- `post` - 500 char limit, optional media
- `like`, `repost`, `follow` - Social interactions
- `bookmark`, `list`, `listMember`, `block`, `mute` - User preferences
- `directMessage`, `notification` - Communication

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