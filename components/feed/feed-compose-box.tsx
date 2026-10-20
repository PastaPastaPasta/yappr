'use client';

import { useEffect, useLayoutEffect, useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { useAppStore } from '@/lib/store';
import { UserAvatar } from '@/components/ui/avatar-image';
import { Button } from '@/components/ui/button';
import { hasStoredSession } from '@/lib/storage-scope';

// Layout effects only run in the browser; the server render skips them quietly.
const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function FeedComposeBox() {
  const [isHydrated, setIsHydrated] = useState(false);
  // Read before the first paint, never during render, so the server and first
  // client render agree (nothing reserved) and a signed-out visitor never sees
  // the box appear and collapse.
  const [hasSavedSession, setHasSavedSession] = useState(false);
  const { user, isAuthRestoring } = useAuth();
  const setComposeOpen = useAppStore((state) => state.setComposeOpen);

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  useBrowserLayoutEffect(() => {
    setHasSavedSession(hasStoredSession());
  }, []);

  // Signed out there is nothing to compose, and the sidebar already offers Sign in.
  // Without a saved session there is nothing to restore either, so no height is held.
  if (!user && !(isAuthRestoring && hasSavedSession)) return null;

  // While a saved session is restored, the box holds its full size (the same
  // markup, inert) so the feed below does not jump down when it appears.
  const placeholder = !user;

  return (
    <div className="border-b border-gray-200 dark:border-gray-800 px-4 py-2 md:p-4" aria-hidden={placeholder || undefined}>
        <div className="flex gap-3">
          <div className="h-10 w-10 md:h-12 md:w-12 rounded-full overflow-hidden bg-white dark:bg-neutral-900 flex-shrink-0">
            {isHydrated && user ? (
              <UserAvatar userId={user.identityId} size="lg" alt="Your avatar" />
            ) : (
              <div className="w-full h-full bg-gray-300 dark:bg-gray-700 animate-pulse rounded-full" />
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            data-testid={placeholder ? undefined : 'open-compose-btn'}
            disabled={placeholder}
            tabIndex={placeholder ? -1 : undefined}
            onClick={() => setComposeOpen(true)}
            className="flex-1 justify-start h-auto text-left px-4 py-3 bg-gray-50 dark:bg-gray-950 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
          >
            What&apos;s happening?
          </Button>
        </div>
    </div>
  );
}
