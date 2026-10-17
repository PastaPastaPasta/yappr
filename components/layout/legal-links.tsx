import Link from 'next/link'
import { COMMUNITY_RULES_HREF, SUPPORT_MAILTO } from '@/lib/legal'
import { cn } from '@/lib/utils'

const LINKS = [
  { href: '/terms', label: 'Terms' },
  { href: COMMUNITY_RULES_HREF, label: 'Rules' },
  { href: '/privacy', label: 'Privacy' },
  { href: '/cookies', label: 'Cookies' },
  { href: '/about', label: 'About' },
]

/**
 * The small row of legal and contact links every layout carries: the left
 * sidebar from tablet width up, the mobile menu below it, and the landing page.
 */
export function LegalLinks({ className, onNavigate }: { className?: string; onNavigate?: () => void }) {
  return (
    <nav aria-label="Legal" className={cn('flex flex-wrap justify-center gap-x-3 gap-y-1 text-xs text-gray-500', className)}>
      {LINKS.map((link) => (
        <Link key={link.href} href={link.href} onClick={onNavigate} className="hover:underline">
          {link.label}
        </Link>
      ))}
      <a href={SUPPORT_MAILTO} className="hover:underline">Contact</a>
    </nav>
  )
}
