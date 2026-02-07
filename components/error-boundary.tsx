'use client'

import React from 'react'
import { ExclamationTriangleIcon, ArrowPathIcon } from '@heroicons/react/24/outline'

interface ErrorBoundaryState {
  hasError: boolean
  error?: Error
  errorInfo?: React.ErrorInfo
}

interface ErrorBoundaryProps {
  children: React.ReactNode
  fallback?: React.ComponentType<{ error: Error; retry: () => void }>
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void
  level?: 'app' | 'page' | 'component'
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      error
    }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo)
    
    this.setState({
      error,
      errorInfo
    })

    // Call optional error handler
    this.props.onError?.(error, errorInfo)

    // Report to error tracking service in production
    if (process.env.NODE_ENV === 'production') {
      // TODO: Implement error reporting
      console.error('Production error:', {
        error: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack,
        level: this.props.level || 'component'
      })
    }
  }

  retry = () => {
    this.setState({ hasError: false, error: undefined, errorInfo: undefined })
  }

  render() {
    if (this.state.hasError) {
      const error = this.state.error ?? new Error('Unknown error')
      // Use custom fallback if provided
      if (this.props.fallback) {
        const FallbackComponent = this.props.fallback
        return <FallbackComponent error={error} retry={this.retry} />
      }

      // Default error UI based on level
      return <DefaultErrorFallback
        error={error}
        retry={this.retry}
        level={this.props.level || 'component'}
      />
    }

    return this.props.children
  }
}

interface DefaultErrorFallbackProps {
  error: Error
  retry: () => void
  level: 'app' | 'page' | 'component'
}

function DefaultErrorFallback({ error, retry, level }: DefaultErrorFallbackProps) {
  const getErrorContent = () => {
    switch (level) {
      case 'app':
        return {
          title: 'Application Error',
          description: 'Something went wrong with the application. Please try refreshing the page.',
          actionText: 'Refresh Page',
          action: () => window.location.reload()
        }
      case 'page':
        return {
          title: 'Page Error',
          description: 'There was an error loading this page. Please try again.',
          actionText: 'Try Again',
          action: retry
        }
      default:
        return {
          title: 'Something went wrong',
          description: 'There was an error with this component. Please try again.',
          actionText: 'Retry',
          action: retry
        }
    }
  }

  const { title, description, actionText, action } = getErrorContent()

  return (
    <div className="flex flex-col items-center justify-center min-h-[200px] p-6 bg-gray-50 dark:bg-gray-900 rounded-lg border border-surface-200 dark:border-neutral-750">
      <ExclamationTriangleIcon className="h-12 w-12 text-red-500 mb-4" />
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
        {title}
      </h2>
      <p className="text-gray-600 dark:text-gray-400 text-center mb-4 max-w-md">
        {description}
      </p>
      
      {process.env.NODE_ENV === 'development' && (
        <details className="mb-4 max-w-md w-full">
          <summary className="cursor-pointer text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
            Error Details
          </summary>
          <div className="mt-2 p-2 bg-gray-100 dark:bg-gray-800 rounded text-xs font-mono text-gray-700 dark:text-gray-300 overflow-auto max-h-32">
            <div className="font-semibold mb-1">Error:</div>
            <div className="mb-2">{error.message}</div>
            {error.stack && (
              <>
                <div className="font-semibold mb-1">Stack:</div>
                <div className="whitespace-pre-wrap break-all">{error.stack}</div>
              </>
            )}
          </div>
        </details>
      )}
      
      <button
        onClick={action}
        className="inline-flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
      >
        <ArrowPathIcon className="h-4 w-4" />
        {actionText}
      </button>
    </div>
  )
}

// Higher-order component for easy wrapping
export function withErrorBoundary<P extends object>(
  Component: React.ComponentType<P>,
  errorBoundaryProps?: Omit<ErrorBoundaryProps, 'children'>
) {
  const WrappedComponent = (props: P) => (
    <ErrorBoundary {...errorBoundaryProps}>
      <Component {...props} />
    </ErrorBoundary>
  )
  
  WrappedComponent.displayName = `withErrorBoundary(${Component.displayName || Component.name})`
  
  return WrappedComponent
}

export default ErrorBoundary