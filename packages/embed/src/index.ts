import { YapprEmbed, render } from './api';
import type { YapprEmbedOptions } from './types';

function parseBooleanValue(input: string | null | undefined, fallback: boolean): boolean {
  if (input == null) {
    return fallback;
  }
  return input === 'true';
}

function initDeclarativeEmbeds(): void {
  if (typeof document === 'undefined') {
    return;
  }

  const nodes = document.querySelectorAll<HTMLElement>('[data-yappr-post]');
  nodes.forEach((element) => {
    const postId = element.dataset.yapprPost;
    if (!postId) {
      return;
    }

    const options: YapprEmbedOptions = {
      postId,
      theme: (element.dataset.yapprTheme as YapprEmbedOptions['theme']) ?? 'auto',
      ownerId: element.dataset.yapprOwner,
      ipfsGateway: element.dataset.yapprIpfsGateway,
      showPoweredBy: parseBooleanValue(element.dataset.yapprPoweredBy, true),
      showViewOnYappr: parseBooleanValue(element.dataset.yapprViewLink, true),
      mock: parseBooleanValue(element.dataset.yapprMock, false)
    };

    void render(element, options);
  });
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDeclarativeEmbeds);
  } else {
    initDeclarativeEmbeds();
  }

  (window as Window & { YapprEmbed?: typeof YapprEmbed }).YapprEmbed = YapprEmbed;
}

export { YapprEmbed, render };
export type { YapprEmbedOptions };
