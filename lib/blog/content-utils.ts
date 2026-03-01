export function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((item) => extractText(item)).filter(Boolean).join(' ')
  }
  if (content && typeof content === 'object') {
    const node = content as Record<string, unknown>
    const textParts: string[] = []
    if (typeof node.text === 'string') textParts.push(node.text)
    if (Array.isArray(node.content)) textParts.push(extractText(node.content))
    if (Array.isArray(node.children)) textParts.push(extractText(node.children))
    return textParts.filter(Boolean).join(' ')
  }
  return ''
}

export function parseLabels(value?: string): string[] {
  if (!value) return []
  return Array.from(new Set(value.split(',').map((item) => item.trim()).filter(Boolean)))
}

export function labelsToCsv(items: string[]): string {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean))).join(',')
}

export function estimateReadingTime(content: unknown): number {
  const text = extractText(content)
  const words = text.split(/\s+/).filter(Boolean).length
  return Math.max(1, Math.ceil(words / 238))
}
