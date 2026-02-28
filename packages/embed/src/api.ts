import { CACHE_TTL, clearStaleCache, readCache, writeCache } from './cache/cache';
import { createDapiClient } from './dapi/client';
import { BLOG_CONTRACT_ID, DEFAULT_DAPI_SEEDS, DPNS_CONTRACT_ID } from './dapi/seeds';
import { renderBlocks } from './renderer/blocks';
import { ensureStylesMounted } from './renderer/styles';
import { applyThemeVariables, resolveTheme } from './theme/theme';
import type { BlogDocument, BlogPostDocument, IdentityDocument, YapprEmbedOptions } from './types';
import { decompressBlockNoteContent } from './utils/compression';
import { getDefaultIpfsGateway, resolveIpfsUrl } from './utils/ipfs';

const VIEW_BASE_URL = 'https://yappr.org/post/';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) {
    return url;
  }
  return '#';
}

function formatDate(timestamp?: number): string {
  if (!timestamp) {
    return 'Unknown publish date';
  }
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    }).format(new Date(timestamp));
  } catch {
    return 'Unknown publish date';
  }
}

function getOptionsWithDefaults(options: YapprEmbedOptions): Required<YapprEmbedOptions> {
  return {
    ...options,
    ownerId: options.ownerId ?? '',
    theme: options.theme ?? 'auto',
    ipfsGateway: options.ipfsGateway ?? getDefaultIpfsGateway(),
    dapiSeeds: options.dapiSeeds ?? DEFAULT_DAPI_SEEDS,
    showPoweredBy: options.showPoweredBy ?? true,
    showViewOnYappr: options.showViewOnYappr ?? true,
    mock: options.mock ?? false
  };
}

function renderState(element: HTMLElement, message: string, isError = false): void {
  element.innerHTML = `<div class="yappr-embed"><div class="yappr-embed__state ${isError ? 'yappr-embed__error' : ''}">${message}</div></div>`;
}

function buildFooter(postId: string, showPoweredBy: boolean, showViewOnYappr: boolean): string {
  const links: string[] = [];
  if (showPoweredBy) {
    links.push('<a href="https://yappr.org" target="_blank" rel="noopener noreferrer">Powered by Yappr</a>');
  }
  if (showViewOnYappr) {
    links.push(`<a href="${VIEW_BASE_URL}${encodeURIComponent(postId)}" target="_blank" rel="noopener noreferrer">View on Yappr</a>`);
  }
  return links.join('<span>•</span>');
}

async function fetchPost(postId: string, options: Required<YapprEmbedOptions>): Promise<BlogPostDocument | null> {
  if (!options.mock && BLOG_CONTRACT_ID === 'BLOG_CONTRACT_ID_PLACEHOLDER') {
    throw new Error('Blog contract ID is not configured yet. Use mock mode for now.');
  }

  const cacheKey = `post:${postId}`;
  const cached = readCache<BlogPostDocument>(cacheKey);
  if (cached) {
    return {
      ...cached,
      content: new Uint8Array(cached.content)
    };
  }

  const client = createDapiClient({ mock: options.mock, seeds: options.dapiSeeds });
  const fetched = await client.getBlogPostById(postId, {
    blogContractId: BLOG_CONTRACT_ID,
    dpnsContractId: DPNS_CONTRACT_ID
  });

  if (fetched) {
    writeCache(cacheKey, fetched, CACHE_TTL.post);
  }

  return fetched;
}

async function fetchBlog(blogId: string, options: Required<YapprEmbedOptions>): Promise<BlogDocument | null> {
  const cacheKey = `blog:${blogId}`;
  const cached = readCache<BlogDocument>(cacheKey);
  if (cached) {
    return cached;
  }

  const client = createDapiClient({ mock: options.mock, seeds: options.dapiSeeds });
  const fetched = await client.getBlogById(blogId, {
    blogContractId: BLOG_CONTRACT_ID,
    dpnsContractId: DPNS_CONTRACT_ID
  });

  if (fetched) {
    writeCache(cacheKey, fetched, CACHE_TTL.blog);
  }

  return fetched;
}

async function fetchIdentity(ownerId: string, options: Required<YapprEmbedOptions>): Promise<IdentityDocument | null> {
  const cacheKey = `identity:${ownerId}`;
  const cached = readCache<IdentityDocument>(cacheKey);
  if (cached) {
    return cached;
  }

  const client = createDapiClient({ mock: options.mock, seeds: options.dapiSeeds });
  const fetched = await client.getIdentity(ownerId);
  if (fetched) {
    writeCache(cacheKey, fetched, CACHE_TTL.identity);
  }

  return fetched;
}

function buildEmbedHtml(
  post: BlogPostDocument,
  contentHtml: string,
  identity: IdentityDocument | null,
  options: Required<YapprEmbedOptions>
): string {
  const coverImage = resolveIpfsUrl(post.coverImage, options.ipfsGateway);
  const authorName = identity?.username ?? post.$ownerId;
  const metadata = [authorName, formatDate(post.publishedAt ?? post.$createdAt)].filter(Boolean).join(' • ');
  const safeCover = coverImage ? sanitizeUrl(coverImage) : undefined;

  return `
<div class="yappr-embed">
  ${safeCover ? `<img class="yappr-embed__cover" src="${escapeHtml(safeCover)}" alt="${escapeHtml(post.title)}" loading="lazy" />` : ''}
  <article class="yappr-embed__body">
    <h1 class="yappr-embed__title">${escapeHtml(post.title)}</h1>
    ${post.subtitle ? `<p class="yappr-embed__subtitle">${escapeHtml(post.subtitle)}</p>` : ''}
    <div class="yappr-embed__meta">${escapeHtml(metadata)}</div>
    <section class="yappr-embed__content">${contentHtml}</section>
  </article>
  <footer class="yappr-embed__footer">${buildFooter(post.$id, options.showPoweredBy, options.showViewOnYappr)}</footer>
</div>
  `.trim();
}

export async function render(element: HTMLElement, rawOptions: YapprEmbedOptions): Promise<void> {
  const options = getOptionsWithDefaults(rawOptions);

  if (!options.postId) {
    renderState(element, 'Missing post ID.', true);
    return;
  }

  ensureStylesMounted();
  clearStaleCache();
  renderState(element, 'Loading post...');

  try {
    const post = await fetchPost(options.postId, options);

    if (!post) {
      renderState(element, 'Post not found.');
      return;
    }

    const [blog, identity] = await Promise.all([
      fetchBlog(post.blogId, options),
      fetchIdentity(options.ownerId || post.$ownerId, options)
    ]);

    const theme = resolveTheme(options.theme, blog?.themeConfig);
    const blocks = decompressBlockNoteContent(post.content);
    const rendered = renderBlocks(blocks);

    element.innerHTML = buildEmbedHtml(post, rendered.html, identity, options);
    const container = element.querySelector('.yappr-embed') as HTMLElement | null;
    if (container) {
      applyThemeVariables(container, theme.variables);
      container.setAttribute('data-theme', theme.mode);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    renderState(element, `Unable to load post: ${message}`, true);
  }
}

export const YapprEmbed = {
  render
};
