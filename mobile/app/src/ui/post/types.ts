/**
 * What a PostCard renders. `CardPost` mirrors the engine's `PostDTO`
 * (mobile/engine/src/api/dto.ts, PR #610) field for field, so screens hand
 * engine data straight in.
 *
 * TODO(#610): once the engine PR is in this tree, replace these with
 * `import type { PostDTO, AuthorDTO, MediaDTO } from '@engine/api/dto'` and
 * delete the copies.
 */

export type CardKind = 'post' | 'reply';

export interface CardAuthor {
  id: string;
  /** DPNS name without `.dash`; null when the identity has none. */
  username: string | null;
  /** Never empty: the profile name, else the DPNS label, else `User <last 6 of id>`. */
  displayName: string;
  /** Never empty: the profile avatar, else the default DiceBear avatar (an SVG data URI). */
  avatarUrl: string;
  /** False when the author lookup failed and the fields above are placeholders. */
  resolved: boolean;
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
  repostedBy?: { id: string; username?: string; displayName?: string };
  repostTimestamp?: Date;
  embed?: { contractId: string; documentType: string; id: string };
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
