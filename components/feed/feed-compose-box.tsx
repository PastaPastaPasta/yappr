'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { useAppStore } from '@/lib/store';
import { useLoginPromptModal } from '@/hooks/use-login-prompt-modal';
import { UserAvatar } from '@/components/ui/avatar-image';

export function FeedComposeBox() {
  const [isHydrated, setIsHydrated] = useState(false);
  const { user } = useAuth();
  const { setComposeOpen } = useAppStore();
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
          <button
            onClick={() => setComposeOpen(true)}
            className="flex-1 text-left px-4 py-3 bg-gray-50 dark:bg-gray-950 rounded-full text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
          >
            What&apos;s happening?
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-center">
          <button
            onClick={() => openLoginPrompt()}
            className="text-yappr-500 hover:text-yappr-600 font-medium py-1"
          >
            Login to share your thoughts
          </button>
        </div>
      )}
    </div>
  );
}
