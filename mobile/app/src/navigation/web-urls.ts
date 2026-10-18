/** Build a handoff within the deployment owning the native variant's data. */
export function webUrl(
  config: { webBaseUrl: string },
  path = '',
  query: Record<string, string | undefined> = {},
): string {
  const suffix = Object.entries(query)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return `${config.webBaseUrl}${path}${suffix ? `?${suffix}` : ''}`;
}

/** Root-form links in post content refer to this app's deployment. Explicit prefixes stay explicit. */
export function webHandoffUrl(config: { webBaseUrl: string }, url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.origin !== 'https://yap.pr') return url;
  if (['/staging', '/devnet', '/testing'].some((prefix) => parsed.pathname === prefix || parsed.pathname.startsWith(`${prefix}/`))) {
    return url;
  }
  return `${config.webBaseUrl}${parsed.pathname}${parsed.search}${parsed.hash}`;
}
