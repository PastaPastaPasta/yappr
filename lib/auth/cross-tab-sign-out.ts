import { SESSION_STORAGE_KEY } from '@/lib/storage-scope'

/** Observe removal, including localStorage.clear(), without reacting to another deployment or a newer login. */
export function observeSignOut(signOut: () => void): () => void {
  const changed = (event: StorageEvent) => {
    if (event.storageArea !== localStorage || (event.key !== SESSION_STORAGE_KEY && event.key !== null)) return
    if (localStorage.getItem(SESSION_STORAGE_KEY) === null) signOut()
  }
  window.addEventListener('storage', changed)
  return () => window.removeEventListener('storage', changed)
}
