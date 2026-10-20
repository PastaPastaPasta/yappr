/** Pages that contain information, with no account controls or Platform reads. */
export const STATIC_ROUTES = ['/terms', '/privacy', '/cookies', '/about', '/about/private-feeds']

export function isStaticRoute(pathname: string): boolean {
  return STATIC_ROUTES.includes(pathname.replace(/\/$/, ''))
}
