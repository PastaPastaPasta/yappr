import type { Metadata } from 'next'
import Link from 'next/link'
import { BrandMark } from '@/components/brand/brand'
import { PageShell } from '@/components/layout/page-shell'

export const metadata: Metadata = { title: 'Page not found' }

export default function NotFound() {
  return (
    <PageShell mainClassName="flex items-center justify-center">
      <div className="px-6 py-24 text-center">
        <div className="mb-6 flex justify-center"><BrandMark size={96} alt="" /></div>
        <p className="text-sm font-semibold uppercase tracking-wider text-yappr-700 dark:text-yappr-400">404</p>
        <h1 className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">This page doesn&apos;t exist</h1>
        <p className="mx-auto mt-3 max-w-sm text-gray-600 dark:text-gray-400">
          The link may be broken, or the page may have moved.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Link
            href="/"
            className="rounded-full bg-yappr-700 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-yappr-800"
          >
            Go home
          </Link>
          <Link
            href="/explore"
            className="rounded-full border border-gray-300 px-5 py-2.5 text-sm font-semibold text-gray-900 transition-colors hover:bg-gray-100 dark:border-gray-700 dark:text-white dark:hover:bg-gray-900"
          >
            Explore
          </Link>
        </div>
      </div>
    </PageShell>
  )
}
