'use client'

import { useState, useEffect, useCallback } from 'react'
import { ChatBubbleLeftRightIcon, UserPlusIcon } from '@heroicons/react/24/outline'
import { PostCard } from '@/components/post/post-card'
import { ReplyThreadItem } from '@/components/post/reply-thread'
import { Button } from '@/components/ui/button'
import { governanceService } from '@/lib/services/governance-service'
import { postService } from '@/lib/services/post-service'
import { proposalClaimService } from '@/lib/services/proposal-claim-service'
import { dpnsService } from '@/lib/services/dpns-service'
import { useAuth } from '@/contexts/auth-context'
import { cn } from '@/lib/utils'
import type { Proposal, ProposalClaim, Post, ReplyThread } from '@/lib/types'
import { ProposalClaimBadge } from './ProposalBadge'

interface GovernanceProposalDiscussionProps {
  proposal: Proposal
  onClaimClick?: () => void
  className?: string
}

interface ClaimWithUsername extends ProposalClaim {
  username?: string
  displayName?: string
  verified: boolean
}

/**
 * Discussion section for a governance proposal.
 * Shows claims, linked post, and threaded replies.
 */
export function GovernanceProposalDiscussion({
  proposal,
  onClaimClick,
  className,
}: GovernanceProposalDiscussionProps) {
  const { user } = useAuth()
  const [claims, setClaims] = useState<ClaimWithUsername[]>([])
  const [linkedPost, setLinkedPost] = useState<Post | null>(null)
  const [replies, setReplies] = useState<ReplyThread[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hasUserClaimed, setHasUserClaimed] = useState(false)

  // Fetch claims and discussion data
  const fetchData = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    try {
      // Fetch claims for this proposal
      const proposalClaims = await governanceService.getClaimsForProposal(proposal.hash)

      // Enrich claims with username and verification status
      const enrichedClaims: ClaimWithUsername[] = await Promise.all(
        proposalClaims.map(async (claim) => {
          // Get username for claim owner
          let username: string | undefined
          let displayName: string | undefined
          try {
            const resolvedUsername = await dpnsService.resolveUsername(claim.ownerId)
            if (resolvedUsername) {
              username = resolvedUsername
              displayName = resolvedUsername
            }
          } catch (e) {
            console.warn('Failed to fetch DPNS for claim owner:', e)
          }

          // Validate claim
          const validation = proposalClaimService.validateClaim(claim, proposal)

          return {
            ...claim,
            username,
            displayName,
            verified: validation.verified,
          }
        })
      )

      setClaims(enrichedClaims)

      // Check if current user has claimed
      if (user) {
        const userClaimed = enrichedClaims.some(c => c.ownerId === user.identityId)
        setHasUserClaimed(userClaimed)
      }

      // If there are claims, fetch the linked post and its replies
      if (enrichedClaims.length > 0) {
        const primaryClaim = enrichedClaims[0]

        try {
          // Fetch the linked post
          const post = await postService.getEnrichedPostById(primaryClaim.linkedPostId)
          setLinkedPost(post)

          // Fetch replies to the linked post
          if (post) {
            const postReplies = await postService.getReplies(post.id)
            // Transform to ReplyThread format
            const threadReplies: ReplyThread[] = postReplies.documents.map(reply => ({
              post: reply,
              isAuthorThread: reply.author.id === post.author.id,
              isThreadContinuation: false,
              nestedReplies: [],
            }))
            setReplies(threadReplies)
          }
        } catch (e) {
          console.warn('Failed to fetch linked post:', e)
        }
      }
    } catch (e) {
      console.error('Failed to fetch discussion data:', e)
      setError('Failed to load discussion')
    } finally {
      setIsLoading(false)
    }
  }, [proposal, user])

  useEffect(() => {
    void fetchData()
  }, [fetchData])

  // Get display info for claims
  const claimDisplay = proposalClaimService.getClaimDisplayInfo(claims, proposal)

  if (isLoading) {
    return (
      <div className={cn('p-4', className)}>
        <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
          Discussion
        </h3>
        <div className="space-y-4 animate-pulse">
          <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
          <div className="h-20 bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className={cn('p-4', className)}>
        <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
          Discussion
        </h3>
        <p className="text-sm text-red-500">{error}</p>
        <Button onClick={fetchData} variant="outline" size="sm" className="mt-2">
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div className={cn('divide-y divide-gray-200 dark:divide-gray-800', className)}>
      {/* Claim Status Section */}
      <div className="p-4">
        <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
          Authorship
        </h3>

        {claims.length === 0 ? (
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              No one has claimed this proposal yet.
            </p>
            {user && (
              <Button onClick={onClaimClick} size="sm" className="gap-2">
                <UserPlusIcon className="h-4 w-4" />
                Claim
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {/* Primary claim display */}
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-600 dark:text-gray-400">
                {claimDisplay.text}
              </span>
              {claimDisplay.primaryClaim && (
                <span className="font-medium text-gray-900 dark:text-gray-100">
                  @{claims.find(c => c.id === claimDisplay.primaryClaim?.id)?.username || 'Unknown'}
                </span>
              )}
              {claimDisplay.badge !== 'none' && claimDisplay.badge !== 'disputed' && (
                <ProposalClaimBadge verified={claimDisplay.badge === 'verified'} />
              )}
              {claimDisplay.badge === 'disputed' && (
                <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300">
                  Disputed
                </span>
              )}
            </div>

            {/* Other claims indicator */}
            {claimDisplay.otherClaimsCount > 0 && (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                + {claimDisplay.otherClaimsCount} other {claimDisplay.otherClaimsCount === 1 ? 'claim' : 'claims'}
              </p>
            )}

            {/* Claim button for logged-in users who haven't claimed */}
            {user && !hasUserClaimed && (
              <Button onClick={onClaimClick} variant="outline" size="sm" className="gap-2 mt-2">
                <UserPlusIcon className="h-4 w-4" />
                Claim this proposal
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Community Support Section */}
      <div className="p-4">
        <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
          Community Support
        </h3>
        {linkedPost ? (
          <p className="text-sm text-gray-600 dark:text-gray-400">
            <span className="font-semibold text-gray-900 dark:text-gray-100">
              {linkedPost.likes}
            </span>{' '}
            {linkedPost.likes === 1 ? 'person supports' : 'people support'} this proposal
          </p>
        ) : (
          <p className="text-sm text-gray-500 dark:text-gray-400 italic">
            Community support will be shown once the proposal is claimed.
          </p>
        )}
      </div>

      {/* Discussion Thread Section */}
      <div className="p-4">
        <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
          Discussion
        </h3>

        {linkedPost ? (
          <div className="space-y-0 -mx-4">
            {/* Main linked post */}
            <PostCard post={linkedPost} hideReplyTo />

            {/* Replies */}
            {replies.length > 0 ? (
              <div className="border-t border-gray-200 dark:border-gray-800">
                {replies.map((thread) => (
                  <ReplyThreadItem
                    key={thread.post.id}
                    thread={thread}
                    mainPostAuthorId={linkedPost.author.id}
                  />
                ))}
              </div>
            ) : (
              <div className="border-t border-gray-200 dark:border-gray-800 p-4 text-center">
                <ChatBubbleLeftRightIcon className="h-8 w-8 mx-auto text-gray-400 mb-2" />
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  No replies yet. Be the first to join the discussion!
                </p>
              </div>
            )}
          </div>
        ) : claims.length === 0 ? (
          <div className="text-center py-6">
            <ChatBubbleLeftRightIcon className="h-10 w-10 mx-auto text-gray-400 mb-3" />
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
              Discussion will begin once someone claims this proposal.
            </p>
            {user && (
              <Button onClick={onClaimClick} className="gap-2">
                <UserPlusIcon className="h-4 w-4" />
                Claim and Start Discussion
              </Button>
            )}
          </div>
        ) : (
          <p className="text-sm text-gray-500 dark:text-gray-400 italic">
            Loading discussion...
          </p>
        )}
      </div>
    </div>
  )
}
