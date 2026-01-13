/**
 * Centralized mock data and default value utilities.
 *
 * This module provides:
 * - Default avatar URL generation
 * - Mock/default user creation for development
 * - Factory functions for creating test data
 */

import { User } from './types';

/**
 * Generate a default avatar URL using DiceBear.
 * Provides consistent placeholder avatars based on user ID.
 */
export function getDefaultAvatarUrl(userId: string): string {
  if (!userId) return '';
  return `https://api.dicebear.com/7.x/thumbs/svg?seed=${encodeURIComponent(userId)}`;
}

/**
 * Create a default/placeholder user object.
 * Useful for fallback when profile data is unavailable.
 */
export function createDefaultUser(userId: string, overrides?: Partial<User>): User {
  return {
    id: userId || 'unknown',
    username: '',
    displayName: 'Unknown User',
    avatar: getDefaultAvatarUrl(userId),
    followers: 0,
    following: 0,
    verified: false,
    joinedAt: new Date(),
    ...overrides,
  };
}

/**
 * Mock user for development/testing.
 * Used when not connected to Dash Platform.
 */
export const mockCurrentUser: User = {
  id: '1',
  username: 'alexchen',
  displayName: 'Alex Chen',
  avatar: getDefaultAvatarUrl('1'),
  bio: 'Building the future of social media',
  followers: 1234,
  following: 567,
  verified: true,
  joinedAt: new Date('2024-01-01'),
};
