# @yappr/embed

Standalone embed widget for rendering Yappr blog posts on any website.

## Quick Start (Script Tag)

```html
<script src="https://cdn.jsdelivr.net/npm/@yappr/embed/dist/yappr-embed.min.js"></script>
<div data-yappr-post="DOCUMENT_ID" data-yappr-mock="true"></div>
```

Auto-init runs on `DOMContentLoaded` and discovers all `[data-yappr-post]` nodes.

## npm Install

```bash
npm install @yappr/embed
```

```ts
import { YapprEmbed } from '@yappr/embed';

await YapprEmbed.render(document.getElementById('embed-root')!, {
  postId: 'DOCUMENT_ID',
  theme: 'auto',
  mock: true
});
```

## React Wrapper Example

```tsx
import { useEffect, useRef } from 'react';
import { YapprEmbed } from '@yappr/embed';

export function YapprPost({ postId }: { postId: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    void YapprEmbed.render(ref.current, {
      postId,
      theme: 'auto'
    });
  }, [postId]);

  return <div ref={ref} />;
}
```

## API

```ts
YapprEmbed.render(element, {
  postId: string,
  ownerId?: string,
  theme?: 'light' | 'dark' | 'auto',
  ipfsGateway?: string,
  dapiSeeds?: string[],
  showPoweredBy?: boolean,
  showViewOnYappr?: boolean,
  mock?: boolean
});
```

## Data Attributes (Declarative)

- `data-yappr-post`
- `data-yappr-theme`
- `data-yappr-owner`
- `data-yappr-ipfs-gateway`
- `data-yappr-powered-by`
- `data-yappr-view-link`
- `data-yappr-mock`

## Build

```bash
cd packages/embed
npm install
npm run lint
npm run build
```

Build outputs:

- `dist/yappr-embed.min.js` (UMD)
- `dist/yappr-embed.esm.js` (ESM)

## CSP Requirements

Allow:

- `script-src` for the embed asset origin
- `style-src` for inline style injection (`'unsafe-inline'` or nonce-based strategy)
- `img-src` for IPFS gateway domains
- `connect-src` for Dash DAPI seed nodes on `https://*:1443`

Example:

```text
connect-src https://seed-1.testnet.networks.dash.org:1443;
img-src https://ipfs.io data:;
```

## IPFS Gateway

Default gateway: `https://ipfs.io/ipfs/`

Override:

```ts
YapprEmbed.render(el, {
  postId: '...',
  ipfsGateway: 'https://w3s.link/ipfs/'
});
```

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 15+

The bundle targets ES2020 and relies on `fetch`, `Intl`, and `localStorage`.
