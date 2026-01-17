/**
 * Proposal Claim Service
 *
 * Handles creating proposal claims which link a Platform identity
 * to a governance proposal they authored. Claims include a mandatory
 * linked post (discussion thread) and optional cryptographic proof.
 *
 * The claim flow:
 * 1. User writes their intro/pitch for the proposal (mandatory post)
 * 2. Post is created first in yappr-social-contract
 * 3. ProposalClaim document is created with linkedPostId pointing to that post
 * 4. If claim creation fails, the post should be deleted (rollback)
 */

import { stateTransitionService, StateTransitionResult } from './state-transition-service';
import { postService } from './post-service';
import { governanceService } from './governance-service';
import { hexToBytes, stringToIdentifierBytes } from './sdk-helpers';
import { YAPPR_GOVERNANCE_CONTRACT_ID, DOCUMENT_TYPES } from '../constants';
import type { Post, Proposal, ProposalClaim } from '../types';

// ============================================================================
// Types
// ============================================================================

export interface CreateClaimOptions {
  /** The governance proposal hash (64-char hex) */
  proposalHash: string;
  /** Content for the mandatory linked post */
  postContent: string;
  /** Optional media URL for the post */
  mediaUrl?: string;
  /** Optional proof message to sign */
  proofMessage?: string;
  /** Optional signature of proofMessage with collateral key */
  proofSignature?: string;
}

export interface CreateClaimResult {
  success: boolean;
  claim?: ProposalClaim;
  post?: Post;
  error?: string;
}

export interface ClaimValidation {
  verified: boolean;
  reason: string;
}

// ============================================================================
// Proposal Claim Service
// ============================================================================

class ProposalClaimService {
  /**
   * Create a proposal claim with linked discussion post.
   *
   * Flow:
   * 1. Check if user already claimed this proposal
   * 2. Create the linked post (in yappr-social-contract)
   * 3. Create the proposalClaim document (in yappr-governance-contract)
   * 4. If claim fails, attempt to delete the post (best-effort rollback)
   */
  async createClaim(
    ownerId: string,
    options: CreateClaimOptions
  ): Promise<CreateClaimResult> {
    const { proposalHash, postContent, mediaUrl, proofMessage, proofSignature } = options;

    try {
      // 1. Check if user already claimed this proposal
      const alreadyClaimed = await governanceService.hasUserClaimedProposal(proposalHash, ownerId);
      if (alreadyClaimed) {
        return {
          success: false,
          error: 'You have already claimed this proposal',
        };
      }

      // 2. Create the linked post first
      console.log('Creating linked post for proposal claim...');
      const post = await postService.createPost(ownerId, postContent, {
        mediaUrl,
      });

      if (!post.id) {
        return {
          success: false,
          error: 'Failed to create linked post - no post ID returned',
        };
      }

      console.log('Linked post created:', post.id);

      // 3. Create the proposalClaim document
      try {
        const claimResult = await this.createClaimDocument(ownerId, {
          proposalHash,
          linkedPostId: post.id,
          proofMessage,
          proofSignature,
        });

        if (!claimResult.success) {
          // Rollback: attempt to delete the post
          console.error('Claim creation failed, attempting to rollback post...');
          await this.attemptPostRollback(ownerId, post.id);
          return {
            success: false,
            error: claimResult.error || 'Failed to create claim document',
          };
        }

        // Transform the result into a ProposalClaim
        const claim = this.transformClaimResult(claimResult, ownerId, proposalHash, post.id);

        return {
          success: true,
          claim,
          post,
        };
      } catch (claimError) {
        // Rollback: attempt to delete the post
        console.error('Claim creation threw error, attempting to rollback post...', claimError);
        await this.attemptPostRollback(ownerId, post.id);
        throw claimError;
      }
    } catch (error) {
      console.error('ProposalClaimService.createClaim error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error creating claim',
      };
    }
  }

  /**
   * Create the proposalClaim document on Platform.
   */
  private async createClaimDocument(
    ownerId: string,
    options: {
      proposalHash: string;
      linkedPostId: string;
      proofMessage?: string;
      proofSignature?: string;
    }
  ): Promise<StateTransitionResult> {
    const { proposalHash, linkedPostId, proofMessage, proofSignature } = options;

    // Convert hex proposal hash to byte array
    const proposalHashBytes = Array.from(hexToBytes(proposalHash.toLowerCase()));

    // Convert base58 post ID to byte array
    const linkedPostIdBytes = stringToIdentifierBytes(linkedPostId);

    // Build document data
    const documentData: Record<string, unknown> = {
      proposalHash: proposalHashBytes,
      linkedPostId: linkedPostIdBytes,
    };

    // Add optional proof fields
    if (proofMessage) {
      documentData.proofMessage = proofMessage;
    }
    if (proofSignature) {
      documentData.proofSignature = proofSignature;
    }

    console.log('Creating proposalClaim document...', {
      proposalHash,
      linkedPostId,
      hasProof: !!proofSignature,
    });

    return stateTransitionService.createDocument(
      YAPPR_GOVERNANCE_CONTRACT_ID,
      DOCUMENT_TYPES.PROPOSAL_CLAIM,
      ownerId,
      documentData
    );
  }

  /**
   * Attempt to delete a post as part of rollback.
   * This is best-effort - we log errors but don't throw.
   */
  private async attemptPostRollback(ownerId: string, postId: string): Promise<void> {
    try {
      // Note: Post deletion may not be implemented or may fail
      // This is best-effort cleanup
      console.log('Attempting to rollback post:', postId);
      // TODO: Call post delete method when available
      // await postService.deletePost(ownerId, postId);
      console.warn('Post rollback not implemented - orphaned post may exist:', postId);
    } catch (error) {
      console.error('Failed to rollback post (orphaned post may exist):', error);
    }
  }

  /**
   * Transform the state transition result into a ProposalClaim object.
   */
  private transformClaimResult(
    result: StateTransitionResult,
    ownerId: string,
    proposalHash: string,
    linkedPostId: string
  ): ProposalClaim {
    const doc = result.document || {};

    return {
      id: (doc.$id || doc.id || '') as string,
      ownerId,
      proposalHash,
      linkedPostId,
      proofMessage: doc.proofMessage as string | undefined,
      proofSignature: doc.proofSignature as string | undefined,
      createdAt: doc.$createdAt ? new Date(doc.$createdAt as number) : new Date(),
    };
  }

  /**
   * Validate a claim against a proposal's collateral public key.
   *
   * Returns verification status and reason.
   */
  validateClaim(claim: ProposalClaim, proposal: Proposal): ClaimValidation {
    // No proof provided
    if (!claim.proofMessage || !claim.proofSignature) {
      return {
        verified: false,
        reason: 'No cryptographic proof provided',
      };
    }

    // Proposal doesn't have collateral public key
    if (!proposal.collateralPubKey) {
      return {
        verified: false,
        reason: 'Proposal collateral public key not available',
      };
    }

    // TODO: Implement actual signature verification
    // This would use dashcore-lib to verify the signature:
    //
    // import { Message, PublicKey } from '@dashevo/dashcore-lib';
    // const pubKey = PublicKey.fromString(proposal.collateralPubKey);
    // const msg = new Message(claim.proofMessage);
    // const isValid = msg.verify(pubKey.toAddress(), claim.proofSignature);
    //
    // For now, we mark claims with signatures as "unverified - verification pending"
    // until we integrate dashcore-lib for signature verification.

    return {
      verified: false,
      reason: 'Signature verification not yet implemented',
    };
  }

  /**
   * Generate a proof message for signing.
   * Format: "I claim proposal <hash> - <timestamp>"
   */
  generateProofMessage(proposalHash: string): string {
    const timestamp = Date.now();
    return `I claim proposal ${proposalHash} - ${timestamp}`;
  }

  /**
   * Get claim display info for UI rendering.
   * Determines the display text and badge based on claim status.
   */
  getClaimDisplayInfo(claims: ProposalClaim[], proposal: Proposal): {
    text: string;
    badge: 'verified' | 'unverified' | 'disputed' | 'none';
    primaryClaim?: ProposalClaim;
    otherClaimsCount: number;
  } {
    if (claims.length === 0) {
      return {
        text: 'Unclaimed',
        badge: 'none',
        otherClaimsCount: 0,
      };
    }

    // Validate all claims
    const validatedClaims = claims.map(claim => ({
      claim,
      validation: this.validateClaim(claim, proposal),
    }));

    // Find verified claims
    const verifiedClaims = validatedClaims.filter(vc => vc.validation.verified);

    if (verifiedClaims.length === 1) {
      return {
        text: 'Claimed by',
        badge: 'verified',
        primaryClaim: verifiedClaims[0].claim,
        otherClaimsCount: claims.length - 1,
      };
    }

    if (verifiedClaims.length > 1) {
      return {
        text: 'Disputed - multiple verified claims',
        badge: 'disputed',
        primaryClaim: verifiedClaims[0].claim,
        otherClaimsCount: claims.length - 1,
      };
    }

    // No verified claims - show first unverified claim
    return {
      text: 'Claimed by',
      badge: 'unverified',
      primaryClaim: claims[0],
      otherClaimsCount: claims.length - 1,
    };
  }
}

// Singleton instance
export const proposalClaimService = new ProposalClaimService();
