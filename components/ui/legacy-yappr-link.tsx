import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline'
import { LEGACY_APP_URL } from '@/lib/constants'

/**
 * Escape hatch shown on empty / end-of-feed states: content created before the
 * v4 contract cutover lives on the previous Yappr deployment. Sends users there
 * for the "old stuff" when they reach the end of what the current app has.
 */
export function LegacyYapprLink({ className = '' }: { className?: string }) {
  return (
    <a
      href={LEGACY_APP_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1.5 text-sm text-yappr-500 hover:text-yappr-600 hover:underline transition-colors ${className}`}
    >
      Looking for older posts? Browse the previous version of Yappr
      <ArrowTopRightOnSquareIcon className="h-4 w-4" />
    </a>
  )
}
