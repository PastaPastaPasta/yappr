// The fixture has no Next.js router, so links render as plain anchors.
import { createElement, type ReactNode } from 'react'

export default function Link({
  href,
  children,
  className,
}: {
  href: string
  children?: ReactNode
  className?: string
}) {
  return createElement('a', { href, className }, children)
}
