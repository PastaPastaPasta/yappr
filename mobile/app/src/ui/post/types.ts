import type { AuthorDTO, AvatarDTO, MediaDTO, ModerationDTO, PostDTO, PostStatsDTO, ViewerStateDTO } from '@engine/api/dto';

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
/** What the moderators did to the post (social v18): withheld on the official apps, labelled on archival builds. */
export type CardModeration = ModerationDTO;

/** Link-preview metadata (web `LinkPreviewData`, lib/link-preview/types). */
export interface CardLinkPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  youtubeVideoId?: string;
}

/** A poll (UX_SPEC §2.4.8): its results, and the viewer's ballot where they can vote. */
export interface CardPoll {
  /** The poll's id: a reused card forgets the last poll's unsent picks, and keys them (`usePollSelection`). */
  id: string;
  question: string;
  options: { label: string; votes: number }[];
  totalVotes: number;
  /** null: no end date. */
  endsAt: Date | null;
  multiChoice?: boolean;
  /**
   * How ballots work (`capabilities.pollVoting`): `editable` until the
   * close, `once` and final; absent or null shows results only.
   */
  voting?: 'editable' | 'once' | null;
  /** The viewer's choices: [] for none yet; null when they could not be read (no ballot shown); absent signed out. */
  myVotes?: number[] | null;
  /** A ballot of the viewer's is on its way: the controls wait. */
  saving?: boolean;
}

/** Async slots: the data, still loading, or failed. */
export type Loadable<T> = T | 'loading' | 'error';
