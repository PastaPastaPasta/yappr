/** Shared guidance beside moderation actions that this sign-in cannot authorize. */
export function ModerationKeyNotice({ authorized }: { authorized: boolean }) {
  if (authorized) return null
  return (
    <p role="note" className="rounded-lg bg-amber-50 dark:bg-amber-950 p-3 text-sm text-amber-900 dark:text-amber-100" data-testid="moderation-key-notice">
      Moderation actions need your account&apos;s CRITICAL key. Sign out, then sign in with that key or a passkey that holds it.
      {' '}As a moderator, you can save this key in a passkey from Settings after signing in with it.
    </p>
  )
}
