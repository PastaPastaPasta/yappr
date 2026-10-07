'use client'

/** A row of pill-shaped tabs choosing one of `options` (the blog discovery sorts). */
export function PillTabs<K extends string>({ options, value, onChange, label }: {
  options: readonly { key: K; label: string }[]
  value: K
  onChange: (key: K) => void
  /** The tablist's accessible name. */
  label: string
}) {
  return (
    <div className="flex items-center gap-1" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          role="tab"
          aria-selected={value === option.key}
          onClick={() => onChange(option.key)}
          className={`rounded-full px-3 py-1 text-sm font-medium transition ${
            value === option.key
              ? 'bg-yappr-500 text-white'
              : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
