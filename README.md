# Yappr

A decentralized social media platform built on Dash Platform. All data—posts, profiles, likes, follows, bookmarks, and direct messages—is stored on-chain with full user ownership.

## Features

### Core Social
- **Posts**: 500-character posts
- **Replies & Threads**: Nested conversation threads
- **Likes & Reposts**: Engage with posts
- **Follows**: Follow users to see their posts in your feed
- **Bookmarks**: Save posts to your bookmarks (stored on-chain)
- **Direct Messages**: Encrypted point-to-point messaging

### Discovery
- **Hashtags**: Tag posts with #hashtags, browse trending topics
- **Explore Page**: Trending hashtags and popular posts
- **User Search**: Find users by DPNS username or identity ID

### User Experience
- **Dark/Light Theme**: System-aware with manual override
- **Mobile-First**: Responsive design with bottom navigation on mobile
- **DiceBear Avatars**: Unique thumbs-style avatars based on identity
- **DPNS Integration**: Human-readable usernames via Dash Platform Name Service

### Security
- **Self-Custody**: You control your private keys
- **Encrypted Key Backup**: Optional on-chain encrypted backup with password protection
- **No Central Database**: All data stored on Dash Platform

## Tech Stack

| Category | Technology |
|----------|------------|
| Framework | Next.js 14 (App Router) |
| Language | TypeScript |
| Blockchain | Dash Platform via @dashevo/evo-sdk |
| Styling | Tailwind CSS |
| UI Components | Radix UI |
| Animations | Framer Motion |
| State | Zustand |
| Icons | Heroicons, Lucide React |
| Theming | next-themes |

## Getting Started

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Run linting
npm run lint
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Project Structure

```
yappr/
├── app/                    # Next.js pages (App Router)
│   ├── feed/              # Main feed (Following / For You)
│   ├── explore/           # Trending hashtags and posts
│   ├── hashtag/           # Posts by hashtag
│   ├── bookmarks/         # Saved posts
│   ├── messages/          # Direct messages
│   ├── notifications/     # User notifications
│   ├── post/              # Post detail view
│   ├── profile/           # User profiles
│   ├── settings/          # User settings
│   └── login/             # Authentication
│
├── components/
│   ├── ui/                # Core UI primitives (button, input, avatar, etc.)
│   ├── layout/            # Sidebar, mobile nav, right sidebar
│   ├── post/              # Post card, content renderer, likes modal
│   ├── compose/           # Post composition modal
│   ├── home/              # Homepage sections (stats, featured, top users)
│   ├── auth/              # Key backup and password modals
│   ├── settings/          # Settings components
│   └── dpns/              # DPNS username components
│
├── lib/
│   ├── services/          # Dash Platform service layer
│   │   ├── evo-sdk-service.ts       # SDK connection management
│   │   ├── document-service.ts      # Query operations
│   │   ├── state-transition-service.ts # Write operations
│   │   ├── post-service.ts          # Posts CRUD
│   │   ├── profile-service.ts       # Profile management
│   │   ├── like-service.ts          # Likes
│   │   ├── follow-service.ts        # Follows
│   │   ├── bookmark-service.ts      # Bookmarks
│   │   ├── hashtag-service.ts       # Hashtag tracking & trending
│   │   ├── direct-message-service.ts # Encrypted DMs
│   │   ├── dpns-service.ts          # Username resolution
│   │   └── identity-service.ts      # Identity & balance queries
│   ├── constants.ts       # Contract IDs, network config
│   ├── types.ts           # TypeScript interfaces
│   ├── store.ts           # Zustand store
│   ├── utils.ts           # Helper functions
│   ├── avatar-utils.ts    # DiceBear avatar generation
│   └── cache-manager.ts   # Query caching
│
├── contexts/
│   └── auth-context.tsx   # Authentication state
│
├── hooks/                 # Custom React hooks
│   ├── use-post-enrichment.ts  # Post stats with deduplication
│   ├── use-post-detail.ts      # Post detail with thread loading
│   └── use-homepage-data.ts    # Homepage stats aggregation
│
├── contracts/             # Dash Platform data contracts
│   ├── yappr-social-contract-actual.json  # Main social contract
│   ├── yappr-dm-contract.json             # Direct messages
│   ├── yappr-hashtag-contract.json        # Hashtag tracking
│   └── encrypted-key-backup-contract.json # Key backup
│
└── public/                # Static assets
```

## Dash Platform Integration

Yappr uses four data contracts deployed on Dash Platform:

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
- `directMessage` - Encrypted messages with receiver indexing

### Hashtag Contract
- `postHashtag` - Links hashtags to posts with trending support

### Encrypted Key Backup Contract
- `encryptedKeyBackup` - Password-encrypted private keys stored on-chain

### Important: Document Ownership
Documents use `$ownerId` (automatic platform field) for ownership. Do not include custom `authorId` or `userId` fields when creating documents.

## Routes

| Route | Description |
|-------|-------------|
| `/` | Public homepage with platform stats |
| `/login` | Authentication |
| `/feed` | Main feed (requires auth) |
| `/explore` | Trending hashtags and posts |
| `/hashtag?tag=xxx` | Posts with specific hashtag |
| `/bookmarks` | Saved posts (requires auth) |
| `/messages` | Direct messages (requires auth) |
| `/notifications` | Notifications (requires auth) |
| `/post?id=xxx` | Post detail and thread |
| `/profile` | Current user profile (requires auth) |
| `/user?id=xxx` | User lookup by ID |
| `/settings` | User settings (requires auth) |

## Platform Scripts

```bash
# Register a contract on Dash Platform
node register-contract.js

# Register contract with specific nonce
node register-contract-with-nonce.js

# Test DPNS name resolution
node test-dpns-resolve.js
```

## Architecture Notes

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

### Known Issues
`wait_for_state_transition_result` often times out (504) even when transactions succeed. The app handles this by assuming success if broadcast succeeded but confirmation wait times out.