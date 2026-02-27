import type { Post } from './post'
import type { User } from './user'

export interface Notification {
  id: string
  type: 'follow' | 'mention' | 'like' | 'repost' | 'reply' | 'privateFeedRequest' | 'privateFeedApproved' | 'privateFeedRevoked'
  from: User
  post?: Post
  createdAt: Date
  read: boolean
}
