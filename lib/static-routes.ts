/** These pages contain information, with no account controls or Platform reads. */
export function isStaticRoute(pathname: string): boolean {
  return ['/terms', '/privacy', '/cookies', '/about', '/about/private-feeds'].includes(pathname.replace(/\/$/, ''))
}
