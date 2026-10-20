import type { ReactNode } from 'react'

/**
 * Shows a blog post in its reading theme without touching the reader's app
 * theme: the theme lives on this wrapper, so it ends where the post does.
 * `dark` turns Tailwind's dark variant on inside; `theme-light` turns it off
 * (see the dark-mode variant in tailwind.config.js) and restores the light
 * colour variables (app/globals.css). color-scheme keeps native controls in step.
 */
export function BlogReadingScope({ theme, children }: { theme: 'light' | 'dark'; children: ReactNode }) {
  return <div className={theme === 'dark' ? 'dark' : 'theme-light'} style={{ colorScheme: theme }}>{children}</div>
}
