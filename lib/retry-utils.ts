/**
 * Retry utility functions for handling network errors and transient failures
 */

export interface RetryOptions {
  maxAttempts?: number
  initialDelayMs?: number
  maxDelayMs?: number
  backoffMultiplier?: number
  retryCondition?: (error: unknown) => boolean
}

export interface RetryResult<T> {
  success: boolean
  data?: T
  error?: Error
  attempts: number
}

/**
 * Default retry condition - retries on network errors and temporary failures
 */
function defaultRetryCondition(error: unknown): boolean {
  if (!error) return false

  const errObj = error as { message?: string; toString?: () => string }
  const errorMessage = errObj.message?.toLowerCase() || ''
  const errorString = errObj.toString?.()?.toLowerCase() || ''
  
  // Network-related errors
  const networkErrors = [
    'network error',
    'network request failed',
    'fetch failed',
    'connection refused',
    'timeout',
    'etimedout',
    'enotfound',
    'econnreset',
    'econnrefused',
    'missing response message',
    'transport error',
    'grpc error'
  ]
  
  // Check if it's a retryable error
  return networkErrors.some(networkError => 
    errorMessage.includes(networkError) || errorString.includes(networkError)
  )
}

/**
 * Exponential backoff with jitter
 */
function calculateDelay(attempt: number, initialDelayMs: number, maxDelayMs: number, backoffMultiplier: number): number {
  const delay = Math.min(initialDelayMs * Math.pow(backoffMultiplier, attempt - 1), maxDelayMs)
  // Add jitter (±25% random variation)
  const jitter = delay * 0.25 * (Math.random() * 2 - 1)
  return Math.max(0, delay + jitter)
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Retry an async operation with exponential backoff
 */
export async function retryAsync<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<RetryResult<T>> {
  const {
    maxAttempts = 3,
    initialDelayMs = 1000,
    maxDelayMs = 10000,
    backoffMultiplier = 2,
    retryCondition = defaultRetryCondition
  } = options

  let lastError: Error | undefined
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`Retry attempt ${attempt}/${maxAttempts}`)
      const result = await operation()
      console.log(`Operation succeeded on attempt ${attempt}`)
      
      return {
        success: true,
        data: result,
        attempts: attempt
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      console.warn(`Attempt ${attempt} failed:`, lastError.message)
      
      // Don't retry if this is the last attempt or if error is not retryable
      if (attempt === maxAttempts || !retryCondition(lastError)) {
        console.log(attempt === maxAttempts ? 'Max attempts reached' : 'Error not retryable')
        break
      }
      
      // Calculate delay for next attempt
      const delay = calculateDelay(attempt, initialDelayMs, maxDelayMs, backoffMultiplier)
      console.log(`Waiting ${Math.round(delay)}ms before retry...`)
      await sleep(delay)
    }
  }
  
  return {
    success: false,
    error: lastError,
    attempts: maxAttempts
  }
}

/**
 * Specialized retry for post creation with Dash Platform specific error handling
 */
export async function retryPostCreation<T>(
  operation: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<RetryResult<T>> {
  return retryAsync(operation, {
    maxAttempts: 3,
    initialDelayMs: 2000,
    maxDelayMs: 8000,
    backoffMultiplier: 2,
    retryCondition: (error) => {
      // Use default retry condition plus Dash Platform specific errors
      if (defaultRetryCondition(error)) return true

      const errorMessage = error instanceof Error ? error.message.toLowerCase() : ''

      // Dash Platform specific retryable errors
      const dashErrors = [
        'internal error',
        'temporarily unavailable',
        'service unavailable',
        'consensus error',
        'quorum not available'
      ]

      return dashErrors.some(dashError => errorMessage.includes(dashError))
    },
    ...options
  })
}

/**
 * Check if an error appears to be a network error
 */
export function isNetworkError(error: unknown): boolean {
  return defaultRetryCondition(error)
}

/**
 * Check if an error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  return defaultRetryCondition(error)
}