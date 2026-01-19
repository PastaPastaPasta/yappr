'use client';

/**
 * PrivateFeedNotificationService
 *
 * Creates notification documents for private feed events.
 * Implements PRD §7 notification integration.
 *
 * Notification types:
 * - privateFeedRequest: Someone requested access to your private feed
 * - privateFeedApproved: Your request was approved
 * - privateFeedRevoked: Your access was revoked
 */

import { stateTransitionService } from './state-transition-service';
import { YAPPR_CONTRACT_ID, DOCUMENT_TYPES } from '../constants';

/**
 * Private feed notification types
 */
export type PrivateFeedNotificationType =
  | 'privateFeedRequest'
  | 'privateFeedApproved'
  | 'privateFeedRevoked';

/**
 * Result of notification creation
 */
interface NotificationResult {
  success: boolean;
  notificationId?: string;
  error?: string;
}

/**
 * Service for creating private feed notification documents
 */
class PrivateFeedNotificationService {
  private contractId = YAPPR_CONTRACT_ID;

  /**
   * Create a notification for a private feed request
   * Called by the requester when they submit a follow request
   *
   * @param requesterId - The requester's identity ID (who is sending the request)
   * @param feedOwnerId - The feed owner's identity ID (recipient of notification)
   * @returns Promise with success status
   */
  async createRequestNotification(
    requesterId: string,
    feedOwnerId: string
  ): Promise<NotificationResult> {
    return this.createNotification(
      'privateFeedRequest',
      requesterId,
      feedOwnerId
    );
  }

  /**
   * Create a notification for a private feed request approval
   * Called by the feed owner when they approve a follower
   *
   * @param feedOwnerId - The feed owner's identity ID (who approved)
   * @param requesterId - The requester's identity ID (recipient of notification)
   * @returns Promise with success status
   */
  async createApprovedNotification(
    feedOwnerId: string,
    requesterId: string
  ): Promise<NotificationResult> {
    return this.createNotification(
      'privateFeedApproved',
      feedOwnerId,
      requesterId
    );
  }

  /**
   * Create a notification for a private feed revocation
   * Called by the feed owner when they revoke a follower
   *
   * @param feedOwnerId - The feed owner's identity ID (who revoked)
   * @param revokeeId - The revoked user's identity ID (recipient of notification)
   * @returns Promise with success status
   */
  async createRevokedNotification(
    feedOwnerId: string,
    revokeeId: string
  ): Promise<NotificationResult> {
    return this.createNotification(
      'privateFeedRevoked',
      feedOwnerId,
      revokeeId
    );
  }

  /**
   * Internal method to create notification documents
   *
   * @param type - The notification type
   * @param fromUserId - The user who triggered the notification
   * @param toUserId - The recipient of the notification (document owner)
   * @returns Promise with success status
   */
  private async createNotification(
    type: PrivateFeedNotificationType,
    fromUserId: string,
    toUserId: string
  ): Promise<NotificationResult> {
    try {
      // The notification is owned by the recipient (toUserId)
      // fromUserId is stored in the document to indicate who triggered it
      const documentData = {
        type,
        fromUserId,
        read: false,
      };

      console.log(`Creating ${type} notification:`, {
        from: fromUserId.slice(0, 8) + '...',
        to: toUserId.slice(0, 8) + '...',
      });

      const result = await stateTransitionService.createDocument(
        this.contractId,
        DOCUMENT_TYPES.NOTIFICATION,
        toUserId,
        documentData
      );

      if (!result.success) {
        console.error(`Failed to create ${type} notification:`, result.error);
        return { success: false, error: result.error };
      }

      console.log(`${type} notification created successfully`);
      return {
        success: true,
        notificationId: result.document?.$id as string | undefined,
      };
    } catch (error) {
      console.error(`Error creating ${type} notification:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

// Singleton instance
export const privateFeedNotificationService = new PrivateFeedNotificationService();
