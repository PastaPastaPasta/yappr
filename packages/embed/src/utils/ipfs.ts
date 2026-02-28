const DEFAULT_GATEWAY = 'https://ipfs.io/ipfs/';

export function resolveIpfsUrl(uri?: string, gateway = DEFAULT_GATEWAY): string | undefined {
  if (!uri) {
    return undefined;
  }

  if (uri.startsWith('ipfs://')) {
    const path = uri.replace(/^ipfs:\/\//, '');
    return `${gateway.replace(/\/$/, '')}/${path}`;
  }

  return uri;
}

export function getDefaultIpfsGateway(): string {
  return DEFAULT_GATEWAY;
}
