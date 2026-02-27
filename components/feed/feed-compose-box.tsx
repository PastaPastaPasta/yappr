'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { useAppStore } from '@/lib/store';
import { useLoginPromptModal } from '@/hooks/use-login-prompt-modal';
import { UserAvatar } from '@/components/ui/avatar-image';
import { Button } from '@/components/ui/button';

export function FeedComposeBox() {
  const [isHydrated, setIsHydrated] = useState(false);
  const { user } = useAuth();
  const setComposeOpen = useAppStore((state) => state.setComposeOpen);
  const { open: openLoginPrompt } = useLoginPromptModal();

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  return (
    <div className="border-b border-gray-200 dark:border-gray-800 px-4 py-2 md:p-4">
      {user ? (
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
            onClick={() => setComposeOpen(true)}
            className="flex-1 justify-start h-auto text-left px-4 py-3 bg-gray-50 dark:bg-gray-950 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
          >
            What&apos;s happening?
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-center">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => openLoginPrompt()}
            className="h-auto px-0 text-yappr-500 hover:text-yappr-600 font-medium py-1"
          >
            Login to share your thoughts
          </Button>
        </div>
      )}
    </div>
  );
}
