# Yappr

A decentralized social media platform built on Dash Platform. All data—posts, profiles, likes, follows, bookmarks, mentions, tips, and direct messages—is stored on-chain with full user ownership.

![Yappr Screenshot](yappr.png)

## Features

### Core Social
- **Posts**: 500-character posts with optional media and links
- **Replies & Threads**: Nested conversation threads with quote posts
- **Likes & Reposts**: Engage with posts
- **Follows**: Follow users to see their posts in your feed
- **Bookmarks**: Save posts to your bookmarks (stored on-chain)
- **Direct Messages**: Encrypted point-to-point messaging
- **Mentions**: Tag users with @username in posts
- **Blocking**: Block users to prevent interactions, subscribe to others' block lists

### Discovery
- **Hashtags**: Tag posts with #hashtags, browse trending topics
- **Explore Page**: Trending hashtags and popular posts
- **User Search**: Find users by DPNS username or identity ID
- **Mentions Feed**: View all posts that mention you

### User Experience
- **Dark/Light Theme**: System-aware with manual override
- **Mobile-First**: Responsive design with bottom navigation on mobile
- **DiceBear Avatars**: Unique thumbs-style avatars based on identity
- **DPNS Integration**: Human-readable usernames via Dash Platform Name Service
- **Link Previews**: Rich previews for shared links
- **Notifications**: Real-time notifications for likes, follows, replies, and mentions
- **Testnet Banner**: Visual indicator when running on testnet

### Payments
- **Tips**: Send tips to users via QR code (Dash and other crypto addresses)
- **Payment QR Codes**: Generate payment requests with amount and message

### Security
- **Self-Custody**: You control your private keys
- **Encrypted Key Backup**: Optional on-chain encrypted backup with password protection
- **Session Storage**: Secure key storage for browser sessions
- **No Central Database**: All data stored on Dash Platform

## Tech Stack

| Category | Technology |
|----------|------------|
| Framework | Next.js 14 (App Router, Static Export) |
| Language | TypeScript |
| Blockchain | Dash Platform via @dashevo/evo-sdk |
| Styling | Tailwind CSS |
| UI Components | Radix UI, Headless UI |
| Animations | Framer Motion |
| State | Zustand |
| Icons | Heroicons, Lucide React |
| Theming | next-themes |
| Dates | date-fns |
| Crypto | @noble/hashes, @noble/secp256k1 |
| QR Codes | qrcode.react |
| Toasts | react-hot-toast |
| Encoding | bs58, bs58check |

## Getting Started

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Build for GitHub Pages
npm run build:gh-pages

# Run linting
npm run lint
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Project Structure

```
yappr/
├── app/                    # Next.js pages (App Router)
│   ├── about/             # About page
│   ├── bookmarks/         # Saved posts
│   ├── contract/          # View data contract JSON
│   ├── cookies/           # Cookie policy
│   ├── dpns/register/     # Register DPNS username
│   ├── explore/           # Trending hashtags and posts
│   ├── feed/              # Main feed (Following / For You)
│   ├── followers/         # User's followers list
│   ├── following/         # User's following list
│   ├── hashtag/           # Posts by hashtag
│   ├── login/             # Authentication
│   ├── mentions/          # Posts mentioning a user
│   ├── messages/          # Direct messages
│   ├── notifications/     # User notifications
│   ├── post/              # Post detail view and threads
│   ├── privacy/           # Privacy policy
│   ├── profile/           # User profile (current user + edit)
│   ├── search/            # Search users and hashtags
│   ├── settings/          # User settings
│   ├── terms/             # Terms of service
│   └── user/              # View other user's profile
│
├── components/
│   ├── auth/              # Key backup and password modals
│   ├── compose/           # Post composition modal
│   ├── contacts/          # DashPay contacts integration
│   ├── dpns/              # DPNS username components
│   ├── home/              # Homepage sections (stats, featured, top users)
│   ├── layout/            # Sidebar, mobile nav, right sidebar
│   ├── post/              # Post card, content renderer, likes modal
│   ├── profile/           # Profile card, edit forms
│   ├── search/            # Search components
│   ├── settings/          # Settings components
│   ├── ui/                # Core UI primitives (button, input, avatar, etc.)
│   ├── error-boundary.tsx # Error boundary wrapper
│   └── providers.tsx      # App providers (theme, SDK, auth)
│
├── contexts/
│   ├── auth-context.tsx   # Authentication state and user session
│   └── sdk-context.tsx    # Dash SDK context provider
│
├── hooks/                 # Custom React hooks
│   ├── use-avatar.ts           # Avatar generation and caching
│   ├── use-block.ts            # Block/unblock functionality
│   ├── use-dashpay-contacts-modal.ts  # DashPay contacts modal
│   ├── use-dpns-registration.ts       # DPNS name registration
│   ├── use-follow.ts           # Follow/unfollow actions
│   ├── use-hashtag-validation.ts      # Hashtag validation
│   ├── use-homepage-data.ts    # Homepage stats aggregation
│   ├── use-link-preview.ts     # Link preview fetching
│   ├── use-login-prompt-modal.ts      # Login prompt modal
│   ├── use-mention-validation.ts      # Mention validation
│   ├── use-platform-detection.ts      # Platform/device detection
│   ├── use-post-detail.ts      # Post detail with thread loading
│   ├── use-post-enrichment.ts  # Post stats with deduplication
│   ├── use-progressive-enrichment.ts  # Progressive data loading
│   ├── use-require-auth.ts     # Auth requirement wrapper
│   └── use-tip-modal.ts        # Tip/payment modal
│
├── lib/
│   ├── services/          # Dash Platform service layer
│   │   ├── avatar-generator.ts        # DiceBear avatar generation
│   │   ├── block-service.ts           # User blocking
│   │   ├── bookmark-service.ts        # Bookmarks
│   │   ├── dashpay-contacts-service.ts # DashPay contacts
│   │   ├── direct-message-service.ts  # Encrypted DMs
│   │   ├── document-service.ts        # Query operations
│   │   ├── dpns-service.ts            # Username resolution
│   │   ├── encrypted-key-service.ts   # On-chain key backup
│   │   ├── evo-sdk-service.ts         # SDK connection management
│   │   ├── follow-service.ts          # Follows
│   │   ├── hashtag-service.ts         # Hashtag tracking & trending
│   │   ├── hashtag-validation-service.ts # Hashtag validation
│   │   ├── identity-service.ts        # Identity & balance queries
│   │   ├── key-validation-service.ts  # Private key validation
│   │   ├── like-service.ts            # Likes
│   │   ├── mention-service.ts         # Mentions
│   │   ├── mention-validation-service.ts # Mention validation
│   │   ├── notification-service.ts    # Notifications
│   │   ├── pagination-utils.ts        # Pagination helpers
│   │   ├── post-service.ts            # Posts CRUD
│   │   ├── profile-migration-service.ts # Profile migration
│   │   ├── profile-service.ts         # Profile management
│   │   ├── repost-service.ts          # Reposts
│   │   ├── sdk-helpers.ts             # SDK utility functions
│   │   ├── state-transition-service.ts # Write operations
│   │   ├── tip-service.ts             # Tip/payment handling
│   │   ├── unified-profile-service.ts # Unified profile queries
│   │   └── index.ts                   # Service exports
│   ├── stores/            # Zustand stores
│   │   └── notification-store.ts      # Notification state
│   ├── caches/            # Client-side caching
│   │   ├── block-cache.ts             # Block list cache
│   │   └── user-status-cache.ts       # User status cache
│   ├── crypto/            # Cryptographic utilities
│   │   ├── hash.ts                    # Hashing functions
│   │   ├── keys.ts                    # Key operations
│   │   └── wif.ts                     # WIF encoding/decoding
│   ├── bloom-filter.ts    # Bloom filter for efficient lookups
│   ├── cache-manager.ts   # Query caching
│   ├── constants.ts       # Contract IDs, network config
│   ├── dash-platform-client.ts # Platform client wrapper
│   ├── error-utils.ts     # Error handling utilities
│   ├── message-encryption.ts # DM encryption
│   ├── mock-data.ts       # Development mock data
│   ├── onchain-key-encryption.ts # Key backup encryption
│   ├── post-helpers.ts    # Post utility functions
│   ├── retry-utils.ts     # Retry logic with backoff
│   ├── secure-storage.ts  # Session storage for keys
│   ├── store.ts           # Main Zustand store
│   ├── types.ts           # TypeScript interfaces
│   └── utils.ts           # Helper functions
│
├── types/
│   └── sdk.ts             # Dash SDK type definitions
│
├── contracts/             # Dash Platform data contracts
│   ├── yappr-social-contract-actual.json  # Main social contract (deployed)
│   ├── yappr-social-contract.json         # Reference contract
│   ├── yappr-dm-contract.json             # Direct messages
│   ├── yappr-hashtag-contract.json        # Hashtag tracking
│   ├── yappr-mention-contract.json        # Mention tracking
│   ├── yappr-block-contract.json          # Enhanced blocking with bloom filters
│   ├── yappr-profile-contract.json        # Unified profile contract
│   ├── encrypted-key-backup-contract.json # Key backup
│   └── README.md                          # Contract documentation
│
├── public/                # Static assets
│   ├── yappr.png          # App logo
│   ├── yappr.jpg          # App logo (JPEG)
│   ├── pbde-dark.png      # "Powered by Dash Evo" dark
│   └── pbde-light.png     # "Powered by Dash Evo" light
│
├── .github/workflows/     # CI/CD workflows
│   ├── ci.yml             # Lint, typecheck, build on PR
│   └── deploy.yml         # Deploy to GitHub Pages
│
├── next.config.js         # Next.js configuration (static export, WASM)
├── tailwind.config.js     # Tailwind CSS configuration
├── register-contract.js   # Register contract on Dash Platform
├── register-contract-with-nonce.js # Register contract with specific nonce
├── register-hashtag-contract.js    # Register hashtag contract
├── test-dpns-resolve.js   # Test DPNS name resolution
└── TODO-MAINNET.md        # Pre-mainnet task tracking
```

## Dash Platform Integration

Yappr uses multiple data contracts deployed on Dash Platform (testnet):

### Main Social Contract
Core social features with 12 document types:
- `profile` - Display name, bio, location, website
- `avatar` - Avatar customization data
- `post` - Text posts (500 char limit)
- `like`, `repost`, `follow` - Social interactions
- `bookmark`, `list`, `listMember` - Collections
- `block`, `mute` - User preferences
- `notification` - User notifications

### Direct Message Contract
- `directMessage` - Encrypted messages with conversation threading

### Hashtag Contract
- `postHashtag` - Links hashtags to posts with trending support

### Mention Contract
- `postMention` - Tracks user mentions in posts for notification queries

### Block Contract
- Enhanced blocking with bloom filters for efficient client-side filtering
- `block`, `blockFilter`, `blockFollow` document types

### Unified Profile Contract
- Combined profile data with additional fields

### Encrypted Key Backup Contract
- `encryptedKeyBackup` - Password-encrypted private keys stored on-chain

### DashPay Contract
- Integration with DashPay contacts system

### Important: Document Ownership
Documents use `$ownerId` (automatic platform field) for ownership. Do not include custom `authorId` or `userId` fields when creating documents.

## Routes

| Route | Description |
|-------|-------------|
| `/` | Public homepage with platform stats |
| `/about` | About Yappr |
| `/login` | Authentication |
| `/feed` | Main feed (requires auth) |
| `/explore` | Trending hashtags and posts |
| `/search?q=xxx` | Search users and hashtags |
| `/hashtag?tag=xxx` | Posts with specific hashtag |
| `/mentions?user=xxx` | Posts mentioning a user |
| `/bookmarks` | Saved posts (requires auth) |
| `/messages` | Direct messages (requires auth) |
| `/notifications` | Notifications (requires auth) |
| `/post?id=xxx` | Post detail and thread |
| `/profile` | Current user profile (requires auth) |
| `/user?id=xxx` | User lookup by ID |
| `/followers?id=xxx` | User's followers list |
| `/following?id=xxx` | User's following list |
| `/settings` | User settings (requires auth) |
| `/dpns/register` | Register DPNS username |
| `/contract` | View data contract JSON |
| `/privacy` | Privacy policy |
| `/terms` | Terms of service |
| `/cookies` | Cookie policy |

## Platform Scripts

```bash
# Register a contract on Dash Platform
node register-contract.js

# Register contract with specific nonce
node register-contract-with-nonce.js

# Register hashtag tracking contract
node register-hashtag-contract.js

# Test DPNS name resolution
node test-dpns-resolve.js
```

## Architecture Notes

### Fully Static Export
The app is configured for static export (`output: 'export'` in `next.config.js`). There is no backend server—all data operations go through Dash Platform DAPI directly from the client.

### WebAssembly Support
The Dash SDK requires WebAssembly. The app includes:
- Webpack configuration for async WASM loading
- Required security headers (COEP, COOP) for cross-origin isolation
- Bundle splitting for the Dash SDK

### Services Layer
All Dash Platform operations go through singleton services in `lib/services/`. This provides:
- Centralized connection management
- Query caching and deduplication
- Consistent error handling
- Clean separation from UI components

### Caching
- Query cache: 2-minute TTL
- Trending cache: 5-minute TTL
- Automatic cache invalidation on writes
- Block list cached for efficient filtering

### Known Issues
`wait_for_state_transition_result` often times out (504) even when transactions succeed. The app handles this by assuming success if broadcast succeeded but confirmation wait times out.

## CI/CD

The project uses GitHub Actions for continuous integration:
- **CI Workflow** (`ci.yml`): Runs on PRs to master - linting, type checking, and build verification
- **Deploy Workflow** (`deploy.yml`): Deploys to GitHub Pages on push to master

## Network

Currently deployed on **Dash Platform Testnet**. See `lib/constants.ts` for contract IDs and network configuration.

## License

MIT
