'use client'

import { forwardRef } from 'react'
import { fieldLimits } from '@/lib/field-limits'
import type { ModeratedContractKey } from '@/lib/moderated-contracts'
import { fitTextChange, fitsText, textBytes, type TextLimits } from '@/lib/text-limits'
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
function Counter({ value, limits }: { value: unknown; limits: TextLimits }) {
  const text = typeof value === 'string' ? value : ''
  return <span className="block text-right text-xs text-gray-500" aria-live="polite">
    {limits.maxLength !== undefined && `${[...text].length}/${limits.maxLength} characters`}
    {limits.maxBytes != null && ` · ${textBytes(text)}/${limits.maxBytes} bytes`}
  </span>
}
export const LimitedInput = forwardRef<HTMLInputElement, InputProps & LimitProps>(function LimitedInput(
  { contract, document, field, limits: explicit, maxLength, onChange, ...props }, ref
) {
  const limits = limitsOf({ contract, document, field, limits: explicit })
  const effective = { ...limits, maxLength: limits.maxLength ?? maxLength }
  return <span className="block min-w-0 flex-1"><Input {...props} ref={ref} onChange={(event) => {
    event.target.value = fitTextChange(typeof props.value === 'string' ? props.value : '', event.target.value, value => fitsText(value, effective))
    onChange?.(event)
  }} /><Counter value={props.value} limits={effective} /></span>
})
export const LimitedTextarea = forwardRef<HTMLTextAreaElement, TextareaProps & LimitProps>(function LimitedTextarea(
  { contract, document, field, limits: explicit, maxLength, onChange, ...props }, ref
) {
  const limits = limitsOf({ contract, document, field, limits: explicit })
  const effective = { ...limits, maxLength: limits.maxLength ?? maxLength }
  return <span className="block w-full"><Textarea {...props} ref={ref} onChange={(event) => {
    event.target.value = fitTextChange(typeof props.value === 'string' ? props.value : '', event.target.value, value => fitsText(value, effective))
    onChange?.(event)
  }} /><Counter value={props.value} limits={effective} /></span>
})
