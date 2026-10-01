/**
 * What a PostCard renders. `CardPost` mirrors the engine's `PostDTO`
 * (mobile/engine/src/api/dto.ts) field for field, so screens hand engine
 * data straight in.
 *
 * TODO: import these from `@engine/api/dto` (type-only) instead. Not yet:
 * dto.ts also imports values from web lib/ (unified-profile-service,
 * v10-profile, quote-reposts, poll-embed), so a type import makes the app's
 * tsc check that whole web graph, components included, and fail. It needs
 * the DTO interfaces in a file with type-only imports.
 */

export type CardKind = 'post' | 'reply';

export interface CardAuthor {
  id: string;
  /** DPNS name without `.dash`; null when the identity has none. */
  username: string | null;
  /** Never empty: the profile name, else the DPNS label, else `User <last 6 of id>`. */
  displayName: string;
  avatar: CardAvatar;
  /** False when the author lookup failed and the fields above are placeholders. */
  resolved: boolean;
}

/**
 * `AvatarDTO`: exactly one is set. A DiceBear recipe is drawn from the SVG
 * the engine renders (`profiles.avatarSvg`), never from a bundled DiceBear.
 */
export interface CardAvatar {
  /** An image as stored: http(s), or ipfs://. */
  uri: string | null;
  dicebear: { style: string; seed: string } | null;
}

export interface CardMedia {
  type: 'image' | 'video' | 'gif';
  url: string;
  thumbnail?: string;
  alt?: string;
  width?: number;
  height?: number;
}

export interface CardStats {
  likes: number;
  reposts: number;
  replies: number;
  quotes: number;
}

export interface CardViewer {
  liked: boolean;
  reposted: boolean;
  bookmarked: boolean;
  /** v10: the viewer's own quote or bare repost of this target (the one slot). */
  ownQuoteId: string | null;
  authorBlocked: boolean;
  followsAuthor: boolean;
}

export interface CardPost {
  id: string;
  kind: CardKind;
  author: CardAuthor;
  content: string;
  createdAt: Date;
  stats: CardStats;
  viewer?: CardViewer;
  media: CardMedia[];
  sensitive: boolean;
  deleted: boolean;
  encrypted: boolean;
  parentId?: string;
  rootPostId?: string;
  quotedPostId?: string;
  quoted?: CardPost;
  quotedRemoved: boolean;
  /** v10: a bare repost (no text of its own); the screen renders `quoted`, attributed to `author`. */
  bareRepost: boolean;
  /** `others`: further reposters collapsed into this card (v10). */
  repostedBy?: { id: string; username?: string; displayName?: string; others?: number };
  repostTimestamp?: Date;
  embed?: { contractId: string; documentType: string; id: string };
  /** The Pollr poll this post shows; `linkUrl` is a legacy link web hides from the text. */
  poll?: { id: string; linkUrl?: string };
}

/** Link-preview metadata (web `LinkPreviewData`, lib/link-preview/types). */
export interface CardLinkPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  youtubeVideoId?: string;
}

/** A read-only poll (UX_SPEC §2.4.8). */
export interface CardPoll {
  question: string;
  options: { label: string; votes: number }[];
  totalVotes: number;
  /** null: no end date. */
  endsAt: Date | null;
}

/** Async slots: the data, still loading, or failed. */
export type Loadable<T> = T | 'loading' | 'error';
