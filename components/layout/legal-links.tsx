'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { COMMUNITY_RULES_HREF, SUPPORT_EMAIL, SUPPORT_MAILTO } from '@/lib/legal'
import { cn } from '@/lib/utils'

interface LegalLink {
  href: string
  label: string
  external?: boolean
}

const TERMS: LegalLink = { href: '/terms', label: 'Terms' }
const PRIVACY: LegalLink = { href: '/privacy', label: 'Privacy' }
const RULES: LegalLink = { href: COMMUNITY_RULES_HREF, label: 'Rules' }
const ABOUT: LegalLink = { href: '/about', label: 'About' }
const COOKIES: LegalLink = { href: '/cookies', label: 'Cookies' }
const CONTACT: LegalLink = { href: SUPPORT_MAILTO, label: 'Contact', external: true }

const ALL_LINKS = [TERMS, RULES, PRIVACY, COOKIES, ABOUT, CONTACT]
/** What the one-line sidebar footer shows; the rest sit behind its "More". */
const INLINE_LINKS = [TERMS, PRIVACY, RULES, ABOUT]
const OVERFLOW_LINKS = [COOKIES, CONTACT]

function LinkItem({ link, className, onNavigate }: { link: LegalLink; className?: string; onNavigate?: () => void }) {
  return link.external
    ? <a href={link.href} className={className}>{link.label}</a>
    : <Link href={link.href} onClick={onNavigate} className={className}>{link.label}</Link>
}

/**
 * The small row of legal and contact links: the mobile menu, Settings and the
 * landing page's phone footer show them all, wrapping as needed.
 */
export function LegalLinks({ className, onNavigate }: { className?: string; onNavigate?: () => void }) {
  return (
    <nav aria-label="Legal" className={cn('flex flex-wrap justify-center gap-x-3 gap-y-1 text-xs text-gray-600 dark:text-gray-400', className)}>
      {ALL_LINKS.map((link) => (
        <LinkItem key={link.label} link={link} onNavigate={onNavigate} className="hover:underline" />
      ))}
    </nav>
  )
}

/** A dropdown of legal links behind any trigger. */
function LegalMenu({ links, trigger, label }: { links: LegalLink[]; trigger: ReactNode; label: string }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild aria-label={label}>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="start"
          sideOffset={6}
          className="z-50 min-w-[160px] rounded-xl border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-800 dark:bg-neutral-900"
        >
          {links.map((link) => (
            <DropdownMenu.Item key={link.label} asChild>
              <LinkItem
                link={link}
                className="block cursor-pointer px-4 py-2 text-sm outline-none hover:bg-gray-100 focus:bg-gray-100 dark:hover:bg-gray-800 dark:focus:bg-gray-800"
              />
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/** The wide sidebar's footer: one line, with Cookies and Contact under "More". */
export function InlineLegalLinks({ className }: { className?: string }) {
  return (
    <nav aria-label="Legal" className={cn('flex flex-nowrap items-center gap-x-3 whitespace-nowrap text-xs text-gray-600 dark:text-gray-400', className)}>
      {INLINE_LINKS.map((link) => (
        <LinkItem key={link.label} link={link} className="hover:underline" />
      ))}
      <LegalMenu
        links={OVERFLOW_LINKS}
        label="More links"
        trigger={<button type="button" className="hover:underline">More</button>}
      />
    </nav>
  )
}

/** The narrow sidebar's footer: every legal link behind one icon button. */
export function LegalLinksMenu({ trigger }: { trigger: ReactNode }) {
  return <LegalMenu links={ALL_LINKS} label="Legal and contact" trigger={trigger} />
}

/** The support address as an underlined mail link, for body copy. */
export function SupportEmailLink() {
  return (
    <a href={SUPPORT_MAILTO} className="underline">
      {SUPPORT_EMAIL}
    </a>
  )
}
