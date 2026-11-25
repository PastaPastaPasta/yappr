'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { logger } from '@/lib/logger'
import { useAuth } from '@/contexts/auth-context'
import { useLoginModal } from '@/hooks/use-login-modal'
import type { StatusCache } from '@/lib/caches/status-cache'

export interface ToggleResult {
  success: boolean
  error?: string
}

export interface ToggleRelationOptions<TArg, TResult extends ToggleResult> {
  /** The other side of the relation: a user id or a blog id. */
  subjectId: string
  /** Known value from a batch prefetch; skips the initial query when given. */
  initialValue?: boolean
  cache: StatusCache
  /** Prefix for log lines, e.g. `useFollow`. */
  label: string
  /** When set, the viewer cannot target themself and sees this error if they try. */
  selfError?: string
  check: (viewerId: string, subjectId: string) => Promise<boolean>
  turnOn: (viewerId: string, subjectId: string, arg: TArg) => Promise<TResult>
  turnOff: (viewerId: string, subjectId: string) => Promise<ToggleResult>
  /** Success toast after turning on; receives the write's result. */
  onMessage: (result: TResult) => string
  offMessage: string
  failedMessage: (error: unknown) => string
  /** Called with the new value as soon as the optimistic flip happens. */
  onOptimistic?: (nextOn: boolean) => void
  /** Called with the value that was restored after a failed write. */
  onRollback?: (restoredOn: boolean) => void
}

export interface ToggleRelationResult<TArg> {
  isOn: boolean
  isLoading: boolean
  toggle: (arg: TArg) => Promise<void>
  /** Drop the cached value and query again. */
  refresh: () => void
}

/**
 * A boolean relation between the viewer and a subject with optimistic toggle,
 * rollback on failure, a shared TTL cache, and a login prompt for logged-out
 * viewers. Follow, block and blog-follow are all this hook with different
 * service calls and copy.
 */
export function useToggleRelation<TArg = void, TResult extends ToggleResult = ToggleResult>(
  options: ToggleRelationOptions<TArg, TResult>
): ToggleRelationResult<TArg> {
  const { subjectId, initialValue, cache, label, selfError } = options
  const { user } = useAuth()
  const openLoginPrompt = useLoginModal((s) => s.open)
  const viewerId = user?.identityId
  const isSelf = Boolean(selfError && viewerId && viewerId === subjectId)

  const [isOn, setIsOn] = useState(initialValue ?? false)
  const [isLoading, setIsLoading] = useState(initialValue === undefined)
  // Bumped per load so a slow response cannot overwrite a newer one.
  const requestRef = useRef(0)
  // While a write is pending, `load` must not settle state underneath it.
  const toggleInFlightRef = useRef(false)
  // The viewer and subject `isOn` was last settled for. Anything else (a failed
  // check, or a viewer change with the page still open) leaves `isOn` unknown,
  // and a toggle checks again before writing.
  const knownForRef = useRef<string | null>(null)
  const relationKey = `${viewerId ?? ''}|${subjectId}`
  // The latest callbacks, so `load` does not have to depend on them.
  const optionsRef = useRef(options)
  optionsRef.current = options

  const load = useCallback(
    async (force = false) => {
      const request = ++requestRef.current
      const isCurrent = () => requestRef.current === request

      // The write's own finally block settles isLoading with the real value.
      if (toggleInFlightRef.current) return
      if (!viewerId || !subjectId || isSelf) {
        // Logged out, or no subject yet: the relation cannot hold.
        knownForRef.current = null
        setIsOn(false)
        setIsLoading(false)
        return
      }
      const key = `${viewerId}|${subjectId}`
      if (initialValue !== undefined && !force) {
        // A prefetched value may arrive after this hook already started its
        // own query; the cleanup above orphaned that query, so settle here.
        // A newer cache entry (e.g. from a toggle in another row) wins.
        setIsOn(cache.get(viewerId, subjectId) ?? initialValue)
        knownForRef.current = key
        setIsLoading(false)
        return
      }

      if (!force) {
        const cached = cache.get(viewerId, subjectId)
        if (cached !== null) {
          setIsOn(cached)
          knownForRef.current = key
          setIsLoading(false)
          return
        }
      }

      knownForRef.current = null
      setIsLoading(true)
      try {
        const value = await optionsRef.current.check(viewerId, subjectId)
        if (!isCurrent()) return
        cache.set(viewerId, subjectId, value)
        setIsOn(value)
        knownForRef.current = key
      } catch (error) {
        logger.error(`${label}: status check failed:`, error)
        // Unknown: show the neutral state rather than another viewer's; a toggle checks again.
        if (isCurrent()) setIsOn(false)
      } finally {
        if (isCurrent()) setIsLoading(false)
      }
    },
    [viewerId, subjectId, isSelf, initialValue, cache, label]
  )

  useEffect(() => {
    const requests = requestRef
    load().catch((error) => logger.error(`${label}: load failed:`, error))
    return () => {
      requests.current++
    }
  }, [load, label])

  const toggle = useCallback(
    async (arg: TArg) => {
      if (!viewerId) {
        openLoginPrompt()
        return
      }
      if (!subjectId || isLoading || toggleInFlightRef.current) return
      if (isSelf && selfError) {
        toast.error(selfError)
        return
      }

      const { check, turnOn, turnOff, onMessage, offMessage, failedMessage, onOptimistic, onRollback } = optionsRef.current

      toggleInFlightRef.current = true
      setIsLoading(true)
      const wasOn = isOn
      if (knownForRef.current !== relationKey) {
        try {
          const value = await check(viewerId, subjectId)
          cache.set(viewerId, subjectId, value)
          knownForRef.current = relationKey
          if (value !== isOn) {
            // The button showed the other state: show the real one, and write nothing the viewer did not ask for.
            setIsOn(value)
            toggleInFlightRef.current = false
            setIsLoading(false)
            return
          }
        } catch (error) {
          logger.error(`${label}: status check before toggle failed:`, error)
          toast.error('Could not check this right now. Please try again.')
          toggleInFlightRef.current = false
          setIsLoading(false)
          return
        }
      }
      setIsOn(!wasOn)
      cache.set(viewerId, subjectId, !wasOn)
      onOptimistic?.(!wasOn)

      try {
        const result = wasOn ? await turnOff(viewerId, subjectId) : await turnOn(viewerId, subjectId, arg)
        if (!result.success) {
          throw new Error(result.error || `${label}: write failed`)
        }
        toast.success(wasOn ? offMessage : onMessage(result as TResult))
      } catch (error) {
        setIsOn(wasOn)
        cache.set(viewerId, subjectId, wasOn)
        onRollback?.(wasOn)
        logger.error(`${label}: toggle failed:`, error)
        toast.error(failedMessage(error))
      } finally {
        toggleInFlightRef.current = false
        setIsLoading(false)
      }
    },
    [viewerId, subjectId, relationKey, isLoading, isSelf, isOn, cache, label, selfError, openLoginPrompt]
  )

  const refresh = useCallback(() => {
    if (viewerId) cache.delete(viewerId, subjectId)
    load(true).catch((error) => logger.error(`${label}: refresh failed:`, error))
  }, [viewerId, subjectId, cache, label, load])

  return { isOn, isLoading, toggle, refresh }
}
