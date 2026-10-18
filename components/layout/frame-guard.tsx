'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'

/** Check every ancestor: a same-origin wrapper inside a foreign frame is unsafe too. */
function hasSameOriginAncestors(): boolean {
  try {
    let ancestor: Window = window
    while (ancestor.parent !== ancestor) {
      ancestor = ancestor.parent
      if (ancestor.location.origin !== window.location.origin) return false
    }
    return true
  } catch {
    // Cross-origin and opaque/sandboxed parents cannot expose their location.
    return false
  }
}

export function FrameGuard({ children, basePath = '' }: { children: React.ReactNode; basePath?: string }) {
  const pathname = usePathname()
  const [sameOrigin, setSameOrigin] = useState<boolean | null>(null)

  useEffect(() => {
    // Ancestry is fixed for this document. Preserve providers across SPA navigation.
    setSameOrigin(hasSameOriginAncestors())
  }, [])

  // Server HTML and the first hydration render contain no interactive content.
  // Providers, dialogs and key inputs only mount after verifying the context.
  if (sameOrigin === null) return null
  const appPath = basePath && pathname?.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname
  const isEmbed = appPath === '/embed' || appPath?.startsWith('/embed/')
  if (!sameOrigin && !isEmbed) {
    return <a href={`${basePath}/`} target="_top" rel="noopener noreferrer">Open Yappr in a new tab</a>
  }
  return <>{children}</>
}
