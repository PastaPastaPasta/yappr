/** Address of a public asset on this deployment (Next Image does not prefix string sources). */
export function publicAsset(path: string): string {
  return `${(process.env.NEXT_PUBLIC_BASE_PATH || '').replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}
