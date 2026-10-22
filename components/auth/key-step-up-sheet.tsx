'use client'

import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import { EyeIcon, EyeSlashIcon, KeyIcon } from '@heroicons/react/24/outline'
import { Modal, ModalTitle } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { answerKeyStepUp, cancelKeyStepUp, currentKeyStepUp, subscribeKeyStepUp } from '@/lib/auth/key-step-up'

/**
 * Asks for a key the session does not hold, when an action needs it
 * (lib/auth/key-step-up.ts). The request checks the key against the identity
 * before the sheet closes; a key that does not fit says why and stays open.
 * Nothing typed here is stored, and the field is cleared when the sheet closes.
 */
export function KeyStepUpSheet() {
  const request = useSyncExternalStore(subscribeKeyStepUp, currentKeyStepUp, () => null)
  const inputId = useId()
  const [value, setValue] = useState('')
  const [shown, setShown] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    setValue('')
    setShown(false)
    setError(null)
    setChecking(false)
  }, [request])

  if (!request) return null

  const submit = async () => {
    if (!value.trim() || checking) return
    setChecking(true)
    setError(null)
    const problem = await request.validate(value)
    setChecking(false)
    if (problem) {
      setError(problem)
      return
    }
    const answer = value
    setValue('')
    answerKeyStepUp(request, answer)
  }

  return (
    <Modal open onOpenChange={(open) => { if (!open) cancelKeyStepUp() }} className="w-[460px] max-w-[92vw]">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          submit().catch(() => setChecking(false))
        }}
        className="space-y-4"
        data-testid="key-step-up"
      >
        <ModalTitle><KeyIcon className="h-5 w-5" aria-hidden="true" /> {request.title}</ModalTitle>
        <p className="text-sm text-gray-600 dark:text-gray-400">{request.description}</p>
        <div className="space-y-1.5">
          <label htmlFor={inputId} className="text-sm font-medium">{request.label}</label>
          <div className="flex gap-2">
            <Input
              id={inputId}
              type={shown ? 'text' : 'password'}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              value={value}
              onChange={(event) => { setValue(event.target.value); setError(null) }}
              aria-invalid={error !== null}
              aria-describedby={error ? `${inputId}-error` : undefined}
              className="font-mono"
            />
            <Button type="button" variant="outline" size="icon" onClick={() => setShown(!shown)} aria-label={shown ? 'Hide key' : 'Show key'}>
              {shown ? <EyeSlashIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
            </Button>
          </div>
          {error && <p id={`${inputId}-error`} role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => cancelKeyStepUp()}>Cancel</Button>
          <Button type="submit" disabled={!value.trim() || checking}>{checking ? 'Checking…' : 'Continue'}</Button>
        </div>
      </form>
    </Modal>
  )
}
