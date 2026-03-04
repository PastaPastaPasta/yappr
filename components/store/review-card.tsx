'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { UserAvatar } from '@/components/ui/avatar-image'
import { RatingStars } from './rating-stars'
import { ProfileHoverCard } from '@/components/profile/profile-hover-card'
import { formatDate } from '@/lib/utils/format'
import { dpnsService } from '@/lib/services/dpns-service'
import { unifiedProfileService } from '@/lib/services/unified-profile-service'
import type { StoreReview } from '@/lib/types'

interface ReviewCardProps {
  review: StoreReview
  index?: number
}

export function ReviewCard({ review, index = 0 }: ReviewCardProps) {
  const [username, setUsername] = useState<string | null>(review.reviewerUsername || null)
  const [displayName, setDisplayName] = useState<string | null>(review.reviewerDisplayName || null)

  useEffect(() => {
    if (!review.reviewerId) return

    let active = true

    // Reset state from props when reviewerId changes (handles component reuse)
    const initialUsername = review.reviewerUsername || null
    const initialDisplayName = review.reviewerDisplayName || null
    setUsername(initialUsername)
    setDisplayName(initialDisplayName)

    // Fetch username if not provided in props
    if (!initialUsername) {
      dpnsService.resolveUsername(review.reviewerId)
        .then(name => {
          if (active) setUsername(name)
        })
        .catch(err => logger.error('Failed to resolve username:', err))
    }

    // Fetch display name if not provided in props
    if (!initialDisplayName) {
      unifiedProfileService.getProfile(review.reviewerId)
        .then(profile => {
          if (active && profile?.displayName) {
            setDisplayName(profile.displayName)
          }
        })
        .catch(err => logger.error('Failed to fetch profile:', err))
    }

    return () => {
      active = false
    }
  }, [review.reviewerId, review.reviewerUsername, review.reviewerDisplayName])

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: index * 0.05 }}
      className="p-4"
    >
      <div className="flex gap-3">
        {/* Avatar */}
        <ProfileHoverCard
          userId={review.reviewerId}
          username={username}
          displayName={displayName || undefined}
          avatarUrl={review.reviewerAvatar}
        >
          <Link href={`/user?id=${review.reviewerId}`} className="flex-shrink-0">
            <UserAvatar
              userId={review.reviewerId}
              size="md"
              alt={username || displayName || 'Reviewer'}
              preloadedUrl={review.reviewerAvatar}
            />
          </Link>
        </ProfileHoverCard>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Header: DPNS username (primary), display name (secondary), stars, date */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <ProfileHoverCard
              userId={review.reviewerId}
              username={username}
              displayName={displayName || undefined}
              avatarUrl={review.reviewerAvatar}
            >
              <Link
                href={`/user?id=${review.reviewerId}`}
                className="font-semibold text-gray-900 dark:text-gray-100 hover:underline truncate"
              >
                {username
                  ? `@${username}`
                  : displayName || `${review.reviewerId.slice(0, 8)}...`}
              </Link>
            </ProfileHoverCard>
            {username && displayName && displayName !== username && (
              <span className="text-sm text-gray-500 truncate">{displayName}</span>
            )}
            <span className="text-gray-300 dark:text-gray-600">·</span>
            <RatingStars rating={review.rating} size="sm" />
            <span className="text-gray-300 dark:text-gray-600">·</span>
            <span className="text-sm text-gray-500">
              {formatDate(review.createdAt)}
            </span>
          </div>

          {/* Review title */}
          {review.title && (
            <h4 className="font-medium mt-1">{review.title}</h4>
          )}

          {/* Review content */}
          {review.content && (
            <p className="text-gray-600 dark:text-gray-400 mt-1">{review.content}</p>
          )}
        </div>
      </div>
    </motion.div>
  )
}
