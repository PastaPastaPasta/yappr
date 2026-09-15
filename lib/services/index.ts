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

// Private feed crypto service
export { privateFeedCryptoService } from './private-feed-crypto-service';
export type {
  NodeKey,
  EncryptedPost,
  RekeyPacket,
  GrantPayload,
} from './private-feed-crypto-service';
export { TREE_CAPACITY, MAX_EPOCH } from './private-feed-crypto-service';

// Private feed key store
export { privateFeedKeyStore } from './private-feed-key-store';
export type {
  StoredPathKey,
  CachedCEK,
  RecipientLeafMap,
} from './private-feed-key-store';

// Private feed service (owner operations)
export { privateFeedService } from './private-feed-service';

// Private feed follower service (follower operations)
export { privateFeedFollowerService } from './private-feed-follower-service';
export type {
  FollowRequestDocument,
  PrivateFeedGrantDocument,
  DecryptResult,
  EncryptedPostFields,
} from './private-feed-follower-service';

// Note: Private feed notification documents cannot be created due to ownership constraints
// (actor can't sign documents owned by recipient). Notifications are derived by polling
// followRequest documents and grant status instead. See notification-service.ts.

