'use client';

import { ArrowPathIcon } from '@heroicons/react/24/outline';
import { cn } from '@/lib/utils';
import type { FeedTab } from '@/hooks/use-feed-data';

interface FeedHeaderProps {
  activeTab: FeedTab;
  onTabChange: (tab: FeedTab) => void;
  onRefresh: () => void;
  isLoading: boolean;
  potatoMode: boolean;
}

export function FeedHeader({ activeTab, onTabChange, onRefresh, isLoading, potatoMode }: FeedHeaderProps) {
  return (
    <header className={`sticky top-[32px] sm:top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 ${potatoMode ? '' : 'backdrop-blur-xl'}`}>
      <div className="px-4 py-3 flex items-center justify-between">
        <h1 className="text-xl font-bold">Home</h1>
        <button
          onClick={onRefresh}
          disabled={isLoading}
          className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
        >
          <ArrowPathIcon className={cn('h-5 w-5 text-gray-500', isLoading && 'animate-spin')} />
        </button>
      </div>

      <div className="flex border-b border-gray-200 dark:border-gray-800">
        <button
          onClick={() => onTabChange('forYou')}
          className={cn(
            'flex-1 py-4 text-center font-medium transition-colors relative',
            activeTab === 'forYou'
              ? 'text-gray-900 dark:text-white'
              : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
          )}
        >
          For You
          {activeTab === 'forYou' && (
            <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-14 h-1 bg-yappr-500 rounded-full" />
          )}
        </button>
        <button
          onClick={() => onTabChange('following')}
          className={cn(
            'flex-1 py-4 text-center font-medium transition-colors relative',
            activeTab === 'following'
              ? 'text-gray-900 dark:text-white'
              : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
          )}
        >
          Following
          {activeTab === 'following' && (
            <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-14 h-1 bg-yappr-500 rounded-full" />
          )}
        </button>
      </div>
    </header>
  );
}
