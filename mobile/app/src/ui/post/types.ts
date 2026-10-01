import type { AuthorDTO, AvatarDTO, MediaDTO, PostDTO, PostStatsDTO, ViewerStateDTO } from '@engine/api/dto';

/**
 * What a PostCard renders: the engine's DTOs (mobile/engine/src/api/dto.ts),
 * type-only, so screens hand engine data straight in. The `Card*` names are
 * kept as aliases for the design system's components.
 */

export type CardKind = PostDTO['kind'];
export type CardAuthor = AuthorDTO;
/** Exactly one is set. A DiceBear recipe is drawn from the SVG the engine renders (`profiles.avatarSvg`). */
export type CardAvatar = AvatarDTO;
export type CardMedia = MediaDTO;
export type CardStats = PostStatsDTO;
export type CardViewer = ViewerStateDTO;
export type CardPost = PostDTO;

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
