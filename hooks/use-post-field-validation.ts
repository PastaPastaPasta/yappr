'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { logger } from '@/lib/logger'
import type { Post } from '@/lib/types'
import {
  postFieldValidator,
  registeredEventName,
  type FieldRegisteredDetail,
  type FieldValidationStatus,
  type PostFieldKind,
} from '@/lib/services/post-field-validation'

export type { FieldValidationStatus }

export interface PostFieldValidationState {
  /** Status per value (storage form: lowercase tag without `#`, username without `@`). */
  validations: Map<string, FieldValidationStatus>
  isLoading: boolean
  /** Drop the cached result and validate again. */
  revalidate: () => void
}

/**
 * Whether each hashtag/cashtag or mention in `post` has its index document on
 * Platform. Re-runs itself when a registration for this post is announced via
 * the `<kind>-registered` window event (recovery modal, compose retry).
 */
export function usePostFieldValidation(kind: PostFieldKind, post: Post | null): PostFieldValidationState {
  const validator = postFieldValidator(kind)
  const postId = post?.id
  const content = post?.content ?? ''
  const values = useMemo(() => (content ? validator.extract(content) : []), [validator, content])

  const [validations, setValidations] = useState<Map<string, FieldValidationStatus>>(new Map())
  const [isLoading, setIsLoading] = useState(false)
  // Bumped on every load, so a response from an earlier load (or from before
  // an unmount) can never overwrite the state of a newer one.
  const requestRef = useRef(0)

  const load = useCallback(() => {
    const request = ++requestRef.current
    const isCurrent = () => requestRef.current === request
    if (!postId || values.length === 0) {
      setValidations(new Map())
      setIsLoading(false)
      return
    }

    setValidations(new Map(values.map((v) => [v, 'pending' as const])))
    setIsLoading(true)

    validator
      .validatePost(postId, content)
      .then((results) => {
        if (isCurrent()) setValidations(results)
      })
      .catch((err) => {
        logger.error(`${kind} validation failed:`, err)
        // Fail open: never flag a value we could not check.
        if (isCurrent()) setValidations(new Map(values.map((v) => [v, 'valid' as const])))
      })
      .finally(() => {
        if (isCurrent()) setIsLoading(false)
      })
  }, [validator, kind, postId, content, values])

  useEffect(() => {
    const requests = requestRef
    load()
    // Any response still in flight for the previous post is stale now.
    return () => {
      requests.current++
    }
  }, [load])

  const revalidate = useCallback(() => {
    if (!postId) return
    validator.invalidate(postId)
    load()
  }, [validator, postId, load])

  useEffect(() => {
    if (!postId) return
    const onRegistered = (event: Event) => {
      if ((event as CustomEvent<FieldRegisteredDetail>).detail?.postId === postId) revalidate()
    }
    const name = registeredEventName(kind)
    window.addEventListener(name, onRegistered)
    return () => window.removeEventListener(name, onRegistered)
  }, [kind, postId, revalidate])

  return { validations, isLoading, revalidate }
}
