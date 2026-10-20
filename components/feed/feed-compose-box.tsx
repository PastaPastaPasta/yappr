'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { useAppStore } from '@/lib/store';
import { UserAvatar } from '@/components/ui/avatar-image';
import { Button } from '@/components/ui/button';

export function FeedComposeBox() {
  const [isHydrated, setIsHydrated] = useState(false);
  const { user } = useAuth();
  const setComposeOpen = useAppStore((state) => state.setComposeOpen);

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  // Signed out there is nothing to compose, and the sidebar already offers Sign in.
  if (!user) return null;

  return (
    <div className="border-b border-gray-200 dark:border-gray-800 px-4 py-2 md:p-4">
        <div className="flex gap-3">
          <div className="h-10 w-10 md:h-12 md:w-12 rounded-full overflow-hidden bg-white dark:bg-neutral-900 flex-shrink-0">
            {isHydrated ? (
              <UserAvatar userId={user.identityId} size="lg" alt="Your avatar" />
            ) : (
              <div className="w-full h-full bg-gray-300 dark:bg-gray-700 animate-pulse rounded-full" />
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            data-testid="open-compose-btn"
            onClick={() => setComposeOpen(true)}
            className="flex-1 justify-start h-auto text-left px-4 py-3 bg-gray-50 dark:bg-gray-950 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
          >
            What&apos;s happening?
          </Button>
        </div>
    </div>
  );
}
