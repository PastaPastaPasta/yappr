// Export all services from a single entry point
export { identityService } from './identity-service';
export { dpnsService } from './dpns-service';
export { postService } from './post-service';
export { likeService } from './like-service';
export { followService } from './follow-service';
export { repostService } from './repost-service';
export { directMessageService } from './direct-message-service';
export { notificationService } from './notification-service';
export { blogService } from './blog-service';
export { blogPostService } from './blog-post-service';
export { blogCommentService } from './blog-comment-service';

// Pollr (native polls, shared contract with the standalone Pollr app)
export { pollrPollService } from './pollr-poll-service';
export { pollrVoteService } from './pollr-vote-service';
export type { Poll, CreatePollData } from './pollr-poll-service';
export type { CastVoteResult, PollTally } from './pollr-vote-service';

// New unified profile services
export { unifiedProfileService } from './unified-profile-service';

// Export types
export type { IdentityInfo, IdentityBalance } from './identity-service';
export type { PostStats, EncryptionOptions } from './post-service';
export type { LikeDocument } from './like-service';
export type { FollowDocument } from './follow-service';
export type { RepostDocument } from './repost-service';
export type { BlockDocument, BlockFollowData } from '../types';
export type { QueryOptions, DocumentResult } from './document-service';
export type { PostHashtagDocument, TrendingHashtag } from './hashtag-service';
export type { TipResult } from './tip-service';
export type { NotificationResult } from './notification-service';
export type {
  UnifiedProfileDocument,
  CreateUnifiedProfileData,
  UpdateUnifiedProfileData,
  AvatarConfig,
  DiceBearStyle,
} from './unified-profile-service';

// ECIES (private feeds, storefront orders and addresses, digital delivery)
export { privateFeedCryptoService } from './private-feed-crypto-service';

// Private feeds (social v17: several write-once feeds per identity)
export { privateFeedKeyStore } from './private-feed-key-store';
export { privateFeedService } from './private-feed-service';
export { privateFeedFollowerService } from './private-feed-follower-service';
export type { AccessStatus } from './private-feed-follower-service';
export type { FollowRequestDocument, PrivateFeedDocument } from './private-feed-reads';

// Note: Private feed notification documents cannot be created due to ownership constraints
// (actor can't sign documents owned by recipient). Notifications are derived by polling
// followRequest documents and grant status instead. See notification-service.ts.

