import { useSyncExternalStore } from 'react'

// Mirror the Next route subscription, including client-side navigation.
const subscribe = (callback: () => void) => {
  window.addEventListener('popstate', callback)
  return () => window.removeEventListener('popstate', callback)
}
export function usePathname() {
  return useSyncExternalStore(subscribe, () => window.location.pathname)
}
