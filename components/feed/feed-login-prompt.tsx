'use client';

import { Button } from '@/components/ui/button';
import { useLoginPromptModal } from '@/hooks/use-login-prompt-modal';

export function FeedLoginPrompt() {
  const { open: openLoginPrompt } = useLoginPromptModal();

  return (
    <div className="flex flex-col items-center justify-center py-16 px-4">
      <div className="w-16 h-16 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center mb-4">
        <svg className="w-8 h-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
          />
        </svg>
      </div>
      <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-2">See posts from people you follow</h3>
      <p className="text-gray-500 dark:text-gray-400 text-center max-w-sm mb-6">
        Log in to view your personalized following feed and see updates from accounts you care about.
      </p>
      <Button onClick={() => openLoginPrompt()} className="px-6">
        Log in
      </Button>
    </div>
  );
}
