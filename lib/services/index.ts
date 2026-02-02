// Export all services from a single entry point
export { evoSdkService, getEvoSdk } from './evo-sdk-service';
export { identityService } from './identity-service';
export { dpnsService } from './dpns-service';
export { profileService } from './profile-service';
export { postService } from './post-service';
export { likeService } from './like-service';
export { followService } from './follow-service';
export { repostService } from './repost-service';
export { bookmarkService } from './bookmark-service';
export { blockService } from './block-service';
export { stateTransitionService } from './state-transition-service';
export { signerService, KeyPurpose, SecurityLevel, KeyType } from './signer-service';
export { documentBuilderService } from './document-builder-service';
export { directMessageService } from './direct-message-service';
export { hashtagService } from './hashtag-service';
export { notificationService } from './notification-service';
export { tipService, CREDITS_PER_DASH, MIN_TIP_CREDITS } from './tip-service';

// New unified profile services
export {
  unifiedProfileService,
  APPROVED_PAYMENT_SCHEMES,
  DICEBEAR_STYLES,
  DICEBEAR_STYLE_LABELS,
  DEFAULT_AVATAR_STYLE,
} from './unified-profile-service';

// Export types
export type { EvoSdkConfig } from './evo-sdk-service';
export type { IdentityInfo, IdentityBalance } from './identity-service';
export type { ProfileDocument } from './profile-service';
export type { PostDocument, PostStats, EncryptionOptions } from './post-service';
export type { LikeDocument } from './like-service';
export type { FollowDocument } from './follow-service';
export type { RepostDocument } from './repost-service';
export type { BookmarkDocument } from './bookmark-service';
export type { BlockDocument, BlockFilterDocument, BlockFollowDocument, BlockFollowData } from '../types';
export type { StateTransitionResult } from './state-transition-service';
export type { QueryOptions, DocumentResult } from './document-service';
export type {
  DirectMessageDocument,
  ConversationInviteDocument,
  ReadReceiptDocument,
  ParsedPaymentUri,
  SocialLink,
} from '../types';
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
export {
  TREE_CAPACITY,
  MAX_EPOCH,
  LEAF_START_INDEX,
  ROOT_NODE_ID,
  PROTOCOL_VERSION,
  AAD_POST,
  AAD_CEK,
  AAD_REKEY,
  AAD_GRANT,
  AAD_FEED_STATE,
} from './private-feed-crypto-service';

// Private feed key store
export { privateFeedKeyStore } from './private-feed-key-store';
export type {
  StoredPathKey,
  CachedCEK,
  RecipientLeafMap,
} from './private-feed-key-store';

// Private feed service (owner operations)
export {
  privateFeedService,
  prepareOwnerEncryption,
  prepareInheritedEncryption,
} from './private-feed-service';
export type {
  PrivateFeedStateDocument,
  PrivateFeedRekeyDocument,
  PrivatePostResult,
  EncryptedPostData,
  PrepareEncryptionResult,
} from './private-feed-service';

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

// Saved address service (encrypted shipping addresses)
export { savedAddressService } from './saved-address-service';