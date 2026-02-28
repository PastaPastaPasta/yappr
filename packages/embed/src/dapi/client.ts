import { strToU8, zlibSync } from 'fflate';
import type {
  BlogDocument,
  BlogPostDocument,
  DapiClient,
  FetchContext,
  IdentityDocument
} from '../types';
import { decodeBase58, encodeBase58 } from '../utils/base58';
import {
  decodeGetDocumentsResponse,
  decodeGrpcWebFrames,
  encodeGetDocumentsRequest,
  encodeGrpcWebFrame,
  type DocumentsQuery
} from './proto';
import { DEFAULT_DAPI_SEEDS } from './seeds';

interface ClientConfig {
  seeds?: string[];
  mock?: boolean;
}

interface ParsedDocument {
  $id: string;
  $ownerId: string;
  $createdAt?: number;
  $updatedAt?: number;
  [key: string]: unknown;
}

function parseDocumentBytes(data: Uint8Array): ParsedDocument | null {
  const decoder = new TextDecoder();
  try {
    const raw = decoder.decode(data);
    const parsed = JSON.parse(raw) as ParsedDocument;
    if (parsed && typeof parsed.$id === 'string') {
      return parsed;
    }
  } catch {
    // Keep MVP parser tolerant until contract and wire shape settle.
  }
  return null;
}

async function postGrpcWeb(seed: string, servicePath: string, payload: Uint8Array): Promise<Uint8Array[]> {
  const response = await fetch(`${seed}${servicePath}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/grpc-web+proto',
      'x-grpc-web': '1'
    },
    body: encodeGrpcWebFrame(payload).buffer as ArrayBuffer
  });

  if (!response.ok) {
    throw new Error(`DAPI request failed (${response.status})`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  return decodeGrpcWebFrames(bytes);
}

async function getDocumentsRaw(seed: string, query: DocumentsQuery): Promise<Uint8Array[]> {
  const request = encodeGetDocumentsRequest(query);
  const frames = await postGrpcWeb(seed, '/org.dash.platform.dapi.v0.Platform/getDocuments', request);
  if (frames.length === 0) {
    return [];
  }
  return decodeGetDocumentsResponse(frames[0]);
}

function makeMockContent(): Uint8Array {
  const blocks = [
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Yappr embeds render decentralized posts directly from Dash Platform.'
        }
      ]
    },
    {
      type: 'callout',
      props: { variant: 'tip' },
      content: [{ type: 'text', text: 'This content is mock data for the MVP demo.' }]
    },
    {
      type: 'divider',
      props: { variant: 'fade' }
    },
    {
      type: 'heading',
      props: { level: 2 },
      content: [{ type: 'text', text: 'Highlights' }]
    },
    {
      type: 'bulletListItem',
      content: [{ type: 'text', text: 'No React runtime required' }]
    },
    {
      type: 'bulletListItem',
      content: [{ type: 'text', text: 'Scoped styles to avoid host-page conflicts' }]
    },
    {
      type: 'bulletListItem',
      content: [{ type: 'text', text: 'Mock and live DAPI clients share one interface' }]
    },
    {
      type: 'backgroundSection',
      content: [{ type: 'text', text: 'Swap to live mode when the blog contract is deployed on testnet.' }]
    }
  ];

  return zlibSync(strToU8(JSON.stringify(blocks)));
}

function createMockClient(): DapiClient {
  const mockPostId = '8M27Qje4Z5YqFTAZ8fN7r1MDE5xysYbWfVz9m4g4xWVe';
  const mockBlogId = '9N2W2xU6aKqyTxRF5vq7UC9pSRV7hcYk4GzW1chEa2w2';
  const mockOwnerId = 'A9J8HahMEci9esSMfRZ2Vwd2Q5YwD8kY2ibvL4AnCk5Y';

  const mockPost: BlogPostDocument = {
    $id: mockPostId,
    $ownerId: mockOwnerId,
    $createdAt: Date.now() - 1000 * 60 * 60 * 24,
    blogId: mockBlogId,
    title: 'Introducing the Yappr Embed Widget',
    subtitle: 'Portable post previews for any site',
    content: makeMockContent(),
    coverImage: 'ipfs://bafybeigdyrzt4xw2xlf3rh4sqcdwqct5k4kgx6lf63q2kvmf5u3q7mbx2e/cover.png',
    labels: 'product,embed,dash',
    commentsEnabled: true,
    slug: 'introducing-yappr-embed',
    publishedAt: Date.now() - 1000 * 60 * 60 * 20
  };

  const mockBlog: BlogDocument = {
    $id: mockBlogId,
    $ownerId: mockOwnerId,
    name: 'Yappr Engineering',
    description: 'Product and protocol updates',
    themeConfig: JSON.stringify({
      link: '#0b5ed7',
      surface: '#f3f8ff'
    })
  };

  const mockIdentity: IdentityDocument = {
    id: mockOwnerId,
    username: 'yappr-dev'
  };

  return {
    async getBlogPostById(postId: string): Promise<BlogPostDocument | null> {
      if (postId === mockPostId || postId === 'demo-post') {
        return mockPost;
      }
      return {
        ...mockPost,
        $id: postId
      };
    },

    async getBlogById(blogId: string): Promise<BlogDocument | null> {
      if (blogId === mockBlogId) {
        return mockBlog;
      }
      return {
        ...mockBlog,
        $id: blogId
      };
    },

    async getIdentity(identityId: string): Promise<IdentityDocument | null> {
      if (identityId === mockIdentity.id) {
        return mockIdentity;
      }
      return {
        id: identityId,
        username: undefined
      };
    }
  };
}

function toPostDocument(document: ParsedDocument): BlogPostDocument | null {
  if (typeof document.title !== 'string' || typeof document.blogId !== 'string') {
    return null;
  }

  const contentBytes =
    document.content instanceof Uint8Array
      ? document.content
      : typeof document.content === 'string'
        ? strToU8(document.content)
        : new Uint8Array();

  return {
    $id: document.$id,
    $ownerId: document.$ownerId,
    $createdAt: typeof document.$createdAt === 'number' ? document.$createdAt : undefined,
    $updatedAt: typeof document.$updatedAt === 'number' ? document.$updatedAt : undefined,
    blogId: document.blogId,
    title: document.title,
    subtitle: typeof document.subtitle === 'string' ? document.subtitle : undefined,
    content: contentBytes,
    coverImage: typeof document.coverImage === 'string' ? document.coverImage : undefined,
    labels: typeof document.labels === 'string' ? document.labels : undefined,
    commentsEnabled: typeof document.commentsEnabled === 'boolean' ? document.commentsEnabled : undefined,
    slug: typeof document.slug === 'string' ? document.slug : undefined,
    publishedAt: typeof document.publishedAt === 'number' ? document.publishedAt : undefined
  };
}

function toBlogDocument(document: ParsedDocument): BlogDocument | null {
  if (typeof document.name !== 'string') {
    return null;
  }

  return {
    $id: document.$id,
    $ownerId: document.$ownerId,
    $createdAt: typeof document.$createdAt === 'number' ? document.$createdAt : undefined,
    name: document.name,
    description: typeof document.description === 'string' ? document.description : undefined,
    headerImage: typeof document.headerImage === 'string' ? document.headerImage : undefined,
    avatar: typeof document.avatar === 'string' ? document.avatar : undefined,
    themeConfig: typeof document.themeConfig === 'string' ? document.themeConfig : undefined,
    labels: typeof document.labels === 'string' ? document.labels : undefined
  };
}

function idWhereClause(base58Id: string): unknown {
  return [['$id', '==', decodeBase58(base58Id)]];
}

function decodeMaybeBase58(bytes: Uint8Array): string {
  return encodeBase58(bytes);
}

function createLiveClient(config: ClientConfig): DapiClient {
  const seed = (config.seeds && config.seeds[0]) || DEFAULT_DAPI_SEEDS[0];

  return {
    async getBlogPostById(postId: string, ctx: FetchContext): Promise<BlogPostDocument | null> {
      const documents = await getDocumentsRaw(seed, {
        contractId: ctx.blogContractId,
        documentType: 'blogPost',
        where: idWhereClause(postId),
        limit: 1
      });

      const parsed = documents
        .map(parseDocumentBytes)
        .filter((entry): entry is ParsedDocument => Boolean(entry))
        .map(toPostDocument)
        .filter((entry): entry is BlogPostDocument => Boolean(entry));

      return parsed[0] ?? null;
    },

    async getBlogById(blogId: string, ctx: FetchContext): Promise<BlogDocument | null> {
      const documents = await getDocumentsRaw(seed, {
        contractId: ctx.blogContractId,
        documentType: 'blog',
        where: idWhereClause(blogId),
        limit: 1
      });

      const parsed = documents
        .map(parseDocumentBytes)
        .filter((entry): entry is ParsedDocument => Boolean(entry))
        .map(toBlogDocument)
        .filter((entry): entry is BlogDocument => Boolean(entry));

      return parsed[0] ?? null;
    },

    async getIdentity(identityId: string): Promise<IdentityDocument | null> {
      try {
        return {
          id: identityId,
          username: decodeMaybeBase58(decodeBase58(identityId)).slice(0, 12)
        };
      } catch {
        return {
          id: identityId,
          username: undefined
        };
      }
    }
  };
}

export function createDapiClient(config: ClientConfig = {}): DapiClient {
  if (config.mock) {
    return createMockClient();
  }

  return createLiveClient(config);
}
