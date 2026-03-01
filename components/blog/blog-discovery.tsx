'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline'
import { blogService } from '@/lib/services'
import { dpnsService } from '@/lib/services/dpns-service'
import type { Blog } from '@/lib/types'
import { IpfsImage } from '@/components/ui/ipfs-image'

interface BlogWithUsername extends Blog {
  username: string | null
}

export function BlogDiscovery() {
  const [blogs, setBlogs] = useState<BlogWithUsername[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const allBlogs = await blogService.getAllBlogs(100)
        if (cancelled) return

        const ownerIds = Array.from(new Set(allBlogs.map((b) => b.ownerId)))
        const usernameMap = await dpnsService.resolveUsernamesBatch(ownerIds)
        if (cancelled) return

        setBlogs(
          allBlogs.map((blog) => ({
            ...blog,
            username: usernameMap.get(blog.ownerId) ?? null,
          }))
        )
      } catch {
        if (!cancelled) setError('Failed to load blogs')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load().catch(() => {
      if (!cancelled) {
        setLoading(false)
        setError('Failed to load blogs')
      }
    })

    return () => {
      cancelled = true
    }
  }, [])

  const filtered = useMemo(() => {
    if (!search.trim()) return blogs
    const q = search.trim().toLowerCase()
    return blogs.filter(
      (b) =>
        b.name.toLowerCase().startsWith(q) ||
        (b.username && b.username.toLowerCase().startsWith(q))
    )
  }, [blogs, search])

  return (
    <div className="space-y-4 p-4">
      <div className="text-center">
        <h1 className="text-2xl font-bold">Blogs</h1>
        <p className="mt-1 text-sm text-gray-400">
          Discover long-form content published on Yappr
        </p>
      </div>

      <div className="relative">
        <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
        <input
          type="text"
          placeholder="Search blogs by name or username..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-lg border border-gray-700 bg-neutral-900 py-2 pl-9 pr-3 text-sm text-white placeholder-gray-500 outline-none focus:border-yappr-500 focus:ring-1 focus:ring-yappr-500"
        />
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="animate-pulse rounded-xl border border-gray-800 p-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-gray-800" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-1/3 rounded bg-gray-800" />
                  <div className="h-3 w-2/3 rounded bg-gray-800" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <p className="text-center text-sm text-gray-500">{error}</p>
      ) : filtered.length === 0 ? (
        <p className="text-center text-sm text-gray-500">
          {search.trim() ? 'No blogs match your search.' : 'No blogs have been created yet.'}
        </p>
      ) : (
        <div className="space-y-2">
          {filtered.map((blog) => (
            <Link key={blog.id} href={`/blog?blog=${encodeURIComponent(blog.id)}`} className="block">
              <div className="flex items-start gap-3 rounded-xl border border-gray-800 bg-neutral-950 p-4 transition hover:border-gray-600">
                {blog.avatar ? (
                  <IpfsImage
                    src={blog.avatar}
                    alt={blog.name}
                    className="h-10 w-10 flex-shrink-0 rounded-full object-cover"
                  />
                ) : (
                  <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-yappr-500 to-yappr-700 text-sm font-bold text-white">
                    {blog.name.charAt(0).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <h3 className="truncate font-semibold text-white">
                    {blog.name}
                  </h3>
                  {blog.username && (
                    <p className="text-xs text-yappr-400">@{blog.username}</p>
                  )}
                  {blog.description && (
                    <p className="mt-1 line-clamp-2 text-sm text-gray-400">
                      {blog.description}
                    </p>
                  )}
                  {blog.labels && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {blog.labels.split(',').slice(0, 4).map((label) => {
                        const trimmed = label.trim()
                        return (
                          <span
                            key={trimmed}
                            className="rounded-full bg-gray-800 px-2 py-0.5 text-[11px] text-gray-400"
                          >
                            {trimmed}
                          </span>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
