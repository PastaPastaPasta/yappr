/**
 * Type definitions for Dash Platform SDK responses and document structures.
 * These types help eliminate `any` usage throughout the codebase and provide
 * compile-time guarantees for SDK interactions.
 */

/**
 * Base document interface representing common fields from Dash Platform documents.
 * All documents created on Dash Platform include these system fields.
 */
export interface BaseDocument {
  /** Unique document identifier (base58 encoded) */
  $id: string;
  /** Owner identity ID (base58 encoded) */
  $ownerId: string;
  /** Creation timestamp in milliseconds */
  $createdAt: number;
  /** Last update timestamp in milliseconds (optional for immutable documents) */
  $updatedAt?: number;
  /** Document revision number for optimistic concurrency */
  $revision?: number;
}

/**
 * Generic document with additional data fields.
 * Used when the document structure is known but varies by document type.
 */
export interface DocumentWithData<T = Record<string, unknown>> extends BaseDocument {
  /** Nested data object (some SDK responses nest user fields here) */
  data?: T;
}

/**
 * Raw SDK document that may have a toJSON method.
 * SDK documents often need to be converted to plain objects.
 */
export interface SDKDocument {
  $id?: string;
  $ownerId?: string;
  $createdAt?: number;
  $updatedAt?: number;
  $revision?: number;
  id?: string;
  ownerId?: string;
  createdAt?: number;
  updatedAt?: number;
  revision?: number;
  data?: Record<string, unknown>;
  toJSON?: () => Record<string, unknown>;
}

/**
 * SDK query response - can be a Map, Array, or object with documents property.
 * The v3 SDK returns different response shapes depending on the query.
 */
export type SDKQueryResponse =
  | Map<unknown, SDKDocument>
  | SDKDocument[]
  | { documents: SDKDocument[] }
  | SDKDocument;

/**
 * Result of a state transition (create, update, delete document).
 */
export interface StateTransitionResult {
  success: boolean;
  transactionHash?: string;
  document?: SDKDocument;
  error?: string;
}

/**
 * SDK create document operation result.
 */
export interface SDKCreateResult {
  document?: SDKDocument;
  stateTransition?: {
    $id?: string;
  };
  transitionId?: string;
}

/**
 * SDK replace/update document operation result.
 */
export interface SDKReplaceResult {
  document?: SDKDocument;
  stateTransition?: {
    $id?: string;
  };
  transitionId?: string;
}

/**
 * SDK delete document operation result.
 */
export interface SDKDeleteResult {
  stateTransition?: {
    $id?: string;
  };
  transitionId?: string;
}

/**
 * Identity public key information from SDK.
 */
export interface IdentityPublicKey {
  id: number;
  type: number;
  purpose: number;
  securityLevel: number;
  data?: Uint8Array;
  readOnly?: boolean;
  signature?: Uint8Array;
}

/**
 * Identity information from SDK.
 */
export interface IdentityInfo {
  id: string;
  balance: number;
  publicKeys: IdentityPublicKey[];
}

/**
 * Identity balance response from SDK.
 */
export interface IdentityBalance {
  confirmed: number;
  pending?: number;
}

/**
 * DPNS domain document structure.
 */
export interface DPNSDomainDocument extends BaseDocument {
  label: string;
  normalizedLabel: string;
  normalizedParentDomainName: string;
  records: {
    identity?: Uint8Array | string;
  };
}

/**
 * Profile document structure (Yappr contract).
 */
export interface ProfileDocumentData {
  displayName?: string;
  bio?: string;
  location?: string;
  website?: string;
  avatarUri?: string;
  bannerUri?: string;
  paymentUris?: string[];
  socialLinks?: string[];
  pronouns?: string;
  nsfw?: boolean;
}

/**
 * Post document structure (Yappr contract).
 */
export interface PostDocumentData {
  content: string;
  mediaUrl?: string;
  replyToPostId?: string | Uint8Array;
  quotedPostId?: string | Uint8Array;
  language?: string;
  sensitive?: boolean;
  embedContractId?: string | Uint8Array;
  embedDocType?: string;
  embedId?: string | Uint8Array;
}

/**
 * Like document structure (Yappr contract).
 */
export interface LikeDocumentData {
  postId: string | Uint8Array;
}

/**
 * Repost document structure (Yappr contract).
 */
export interface RepostDocumentData {
  postId: string | Uint8Array;
}

/**
 * Follow document structure (Yappr contract).
 */
export interface FollowDocumentData {
  followingId: string | Uint8Array;
}

/**
 * Bookmark document structure (Yappr contract).
 */
export interface BookmarkDocumentData {
  postId: string | Uint8Array;
}

/**
 * Block document structure (Yappr contract).
 */
export interface BlockDocumentData {
  blockedId: string | Uint8Array;
  message?: string;
}

/**
 * Direct message document structure (Yappr contract).
 */
export interface DirectMessageDocumentData {
  conversationId: Uint8Array;
  encryptedContent: Uint8Array;
}

/**
 * Conversation invite document structure (Yappr contract).
 */
export interface ConversationInviteDocumentData {
  recipientId: Uint8Array;
  conversationId: Uint8Array;
  senderPubKey?: Uint8Array;
}

/**
 * Type guard to check if a value is an SDK document with toJSON method.
 */
export function hasToJSON(value: unknown): value is { toJSON: () => Record<string, unknown> } {
  return typeof value === 'object' && value !== null && 'toJSON' in value && typeof (value as { toJSON: unknown }).toJSON === 'function';
}

/**
 * Type guard to check if a response is a Map.
 */
export function isMapResponse(response: unknown): response is Map<unknown, SDKDocument> {
  return response instanceof Map;
}

/**
 * Type guard to check if a response has a documents property.
 */
export function hasDocumentsProperty(response: unknown): response is { documents: SDKDocument[] } {
  return typeof response === 'object' && response !== null && 'documents' in response && Array.isArray((response as { documents: unknown }).documents);
}
