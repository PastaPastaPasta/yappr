import React from 'react'
import { ArrowPathIcon } from '@heroicons/react/24/outline'
import { Spinner } from './spinner'

export interface LoadingStateProps {
  loading: boolean
  error?: string | null
  isEmpty?: boolean
  onRetry?: () => void
  children: React.ReactNode
  loadingText?: string
  emptyText?: string
  emptyDescription?: string
  className?: string
}

export function LoadingState({
  loading,
  error,
  isEmpty,
  onRetry,
  children,
  loadingText = 'Loading...',
  emptyText = 'No data found',
  emptyDescription = 'There\'s nothing here yet.',
  className = ''
}: LoadingStateProps) {
  if (loading) {
    return (
      <div className={`flex flex-col items-center justify-center p-8 ${className}`}>
        <Spinner size="md" className="mb-4" />
        <p className="text-surface-500 text-sm">{loadingText}</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className={`flex flex-col items-center justify-center p-8 ${className}`}>
        <div className="text-red-500 mb-4">
          <svg className="h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
        </div>
        <h3 className="text-lg font-display font-medium text-gray-900 dark:text-white mb-2">
          Something went wrong
        </h3>
        <p className="text-surface-500 dark:text-surface-400 text-center mb-4 max-w-md">
          {error}
        </p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="inline-flex items-center gap-2 px-4 py-2 bg-gradient-yappr text-white rounded-full hover:shadow-yappr transition-all"
          >
            <ArrowPathIcon className="h-4 w-4" />
            Try Again
          </button>
        )}
      </div>
    )
  }

  if (isEmpty) {
    return (
      <div className={`flex flex-col items-center justify-center p-8 ${className}`}>
        <div className="text-surface-400 mb-4">
          <svg className="h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2M4 13h2m13-8l-2-2m0 0l-2 2m2-2v6" />
          </svg>
        </div>
        <h3 className="text-lg font-display font-medium text-gray-900 dark:text-white mb-2">
          {emptyText}
        </h3>
        <p className="text-surface-500 dark:text-surface-400 text-center">
          {emptyDescription}
        </p>
      </div>
    )
  }

  return <>{children}</>
}

export interface AsyncState<T> {
  data: T | null
  loading: boolean
  error: string | null
}

export interface UseAsyncStateResult<T> extends AsyncState<T> {
  setData: (data: T | null | ((prev: T | null) => T | null)) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  reset: () => void
}

export function useAsyncState<T>(initialData: T | null = null): UseAsyncStateResult<T> {
  const [state, setState] = React.useState<AsyncState<T>>({
    data: initialData,
    loading: false,
    error: null
  })

  const setData = React.useCallback((data: T | null | ((prev: T | null) => T | null)) => {
    setState(prev => ({
      ...prev,
      data: typeof data === 'function' ? (data as (prev: T | null) => T | null)(prev.data) : data,
      error: null
    }))
  }, [])

  const setLoading = React.useCallback((loading: boolean) => {
    setState(prev => ({ ...prev, loading, error: loading ? null : prev.error }))
  }, [])

  const setError = React.useCallback((error: string | null) => {
    setState(prev => ({ ...prev, error, loading: false }))
  }, [])

  const reset = React.useCallback(() => {
    setState({ data: initialData, loading: false, error: null })
  }, [initialData])

  return {
    ...state,
    setData,
    setLoading,
    setError,
    reset
  }
}

export default LoadingState
