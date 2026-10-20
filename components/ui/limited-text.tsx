'use client'

import { forwardRef, useState } from 'react'
import { fieldLimits } from '@/lib/field-limits'
import type { ModeratedContractKey } from '@/lib/moderated-contracts'
import { fitTextChange, fitsText, type TextLimits } from '@/lib/text-limits'
import { Input, type InputProps } from './input'
import { Textarea, type TextareaProps } from './textarea'

interface LimitProps {
  contract?: ModeratedContractKey
  document?: string
  field?: string
  limits?: TextLimits
}
function limitsOf({ contract = 'social', document = 'post', field = 'content', limits }: LimitProps): TextLimits {
  return limits ?? fieldLimits(contract, document, field)
}
/** Share of the limit at which the counter appears, as on X and Bluesky. */
const COUNTER_FROM = 0.8

function Counter({ value, limits, shortened }: { value: unknown; limits: TextLimits; shortened: boolean }) {
  const length = [...(typeof value === 'string' ? value : '')].length
  const max = limits.maxLength
  const nearLimit = max !== undefined && length >= max * COUNTER_FROM
  return <span className="block text-right text-xs text-gray-500" aria-live="polite">
    {max !== undefined && (nearLimit || shortened) && `${length}/${max} characters`}
    {shortened && <span className="block">Text was shortened to fit. Some characters take more space.</span>}
  </span>
}
export const LimitedInput = forwardRef<HTMLInputElement, InputProps & LimitProps>(function LimitedInput(
  { contract, document, field, limits: explicit, maxLength, onChange, ...props }, ref
) {
  const [shortened, setShortened] = useState(false)
  const limits = limitsOf({ contract, document, field, limits: explicit })
  const effective = { ...limits, maxLength: limits.maxLength ?? maxLength }
  return <span className="block min-w-0 flex-1"><Input {...props} ref={ref} onChange={(event) => {
    const attempted = event.target.value
    event.target.value = fitTextChange(typeof props.value === 'string' ? props.value : '', event.target.value, value => fitsText(value, effective))
    setShortened(attempted !== event.target.value)
    onChange?.(event)
  }} /><Counter value={props.value} limits={effective} shortened={shortened} /></span>
})
export const LimitedTextarea = forwardRef<HTMLTextAreaElement, TextareaProps & LimitProps>(function LimitedTextarea(
  { contract, document, field, limits: explicit, maxLength, onChange, ...props }, ref
) {
  const [shortened, setShortened] = useState(false)
  const limits = limitsOf({ contract, document, field, limits: explicit })
  const effective = { ...limits, maxLength: limits.maxLength ?? maxLength }
  return <span className="block w-full"><Textarea {...props} ref={ref} onChange={(event) => {
    const attempted = event.target.value
    event.target.value = fitTextChange(typeof props.value === 'string' ? props.value : '', event.target.value, value => fitsText(value, effective))
    setShortened(attempted !== event.target.value)
    onChange?.(event)
  }} /><Counter value={props.value} limits={effective} shortened={shortened} /></span>
})
