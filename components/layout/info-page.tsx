'use client'

import type { ComponentType, ReactNode } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { ArrowLeftIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { cn } from '@/lib/utils'

type Icon = ComponentType<{ className?: string }>

interface InfoPageProps {
  icon: Icon
  title: string
  subtitle: string
  /** Extra header content under the subtitle, e.g. a stats row. */
  headerExtra?: ReactNode
  /** Where the top-left link goes and what it says. */
  back?: { href: string; label: string }
  /** Centre column width; the contract viewer needs the wide one. */
  width?: 'prose' | 'wide'
  /** Printed in the footer as "Last updated: …". */
  updated?: string
  /** Vertical gap between sections. */
  spacing?: 'normal' | 'loose'
  children: ReactNode
}

/**
 * The standalone card page used for about, legal and contract content: a
 * back link, a gradient title band, and the sections a page passes in.
 */
export function InfoPage({ icon: TitleIcon, title, subtitle, headerExtra, back = { href: '/', label: 'Back to Yappr' }, width = 'prose', updated, spacing = 'normal', children }: InfoPageProps) {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <div className={cn('mx-auto px-4 py-8', width === 'wide' ? 'max-w-7xl' : 'max-w-4xl')}>
        <div className="mb-8">
          <Link href={back.href} className="inline-flex items-center gap-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
            <ArrowLeftIcon className="h-4 w-4" />
            {back.label}
          </Link>
        </div>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="bg-white dark:bg-neutral-900 rounded-2xl shadow-lg overflow-hidden">
          <div className="bg-gradient-yappr p-8 text-white">
            <div className="flex items-center gap-3 mb-4">
              <TitleIcon className="h-8 w-8" />
              <h1 className="text-3xl font-bold">{title}</h1>
            </div>
            <p className={cn('text-lg opacity-90', headerExtra && 'mb-6')}>{subtitle}</p>
            {headerExtra}
          </div>

          <div className={cn('p-8', spacing === 'loose' ? 'space-y-10' : 'space-y-8')}>
            {children}
            {updated && (
              <div className="pt-6 border-t border-gray-200 dark:border-gray-800">
                <p className="text-sm text-gray-500">Last updated: {updated}</p>
              </div>
            )}
          </div>
        </motion.div>
      </div>
    </div>
  )
}

interface InfoSectionProps {
  title: string
  icon?: Icon
  /** Icon colour; the default is neutral. */
  iconClassName?: string
  children: ReactNode
}

/** A titled section of an InfoPage; body copy is styled by the page. */
export function InfoSection({ title, icon: SectionIcon, iconClassName, children }: InfoSectionProps) {
  return (
    <section>
      {SectionIcon ? (
        <div className="flex items-center gap-2 mb-3">
          <SectionIcon className={cn('h-5 w-5 text-gray-500', iconClassName)} />
          <h2 className="text-xl font-semibold">{title}</h2>
        </div>
      ) : (
        <h2 className="text-xl font-semibold mb-3">{title}</h2>
      )}
      {children}
    </section>
  )
}

/** Body copy inside an InfoSection. */
export function Prose({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('text-gray-600 dark:text-gray-400 leading-relaxed', className)}>{children}</div>
}

/** The amber "this is testnet" box at the top of the legal pages. */
export function TestnetNotice({ children }: { children: ReactNode }) {
  return (
    <div className="bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800 rounded-xl p-6">
      <div className="flex items-start gap-4">
        <ExclamationTriangleIcon className="h-6 w-6 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
        <div>
          <h2 className="font-semibold text-amber-800 dark:text-amber-200 mb-2">Testnet Notice</h2>
          <p className="text-amber-700 dark:text-amber-300 text-sm">{children}</p>
        </div>
      </div>
    </div>
  )
}
