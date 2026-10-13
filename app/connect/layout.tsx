import { APP_RETURN_SCRIPT } from '@/lib/app-connect/callback-channel'

/**
 * The wallet's return page. A request the Yappr app made goes straight back
 * to the app: the inline script runs as the static HTML is parsed, before the
 * page hydrates (see `APP_RETURN_SCRIPT`); the page itself is the fallback.
 */
export default function ConnectLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: APP_RETURN_SCRIPT }} />
      {children}
    </>
  )
}
