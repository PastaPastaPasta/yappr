export type EmbedTheme = 'light' | 'dark' | 'auto';

export interface YapprEmbedOptions {
  postId: string;
  ownerId?: string;
  theme?: EmbedTheme;
  ipfsGateway?: string;
  dapiSeeds?: string[];
  showPoweredBy?: boolean;
  showViewOnYappr?: boolean;
  mock?: boolean;
}

export interface InlineContent {
  type?: 'text' | 'link';
  text?: string;
  href?: string;
  styles?: {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strike?: boolean;
    code?: boolean;
    textColor?: string;
    backgroundColor?: string;
  };
  content?: InlineContent[];
}

export interface BlockNoteBlock {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  content?: InlineContent[] | string;
  children?: BlockNoteBlock[];
}

export interface BlogPostDocument {
  $id: string;
  $ownerId: string;
  $createdAt?: number;
  $updatedAt?: number;
  blogId: string;
  title: string;
  subtitle?: string;
  content: Uint8Array;
  coverImage?: string;
  labels?: string;
  commentsEnabled?: boolean;
  slug?: string;
  publishedAt?: number;
}

export interface BlogDocument {
  $id: string;
  $ownerId: string;
  $createdAt?: number;
  name: string;
  description?: string;
  headerImage?: string;
  avatar?: string;
  themeConfig?: string;
  labels?: string;
}

export interface IdentityDocument {
  id: string;
  username?: string;
}

export interface FetchContext {
  blogContractId: string;
  dpnsContractId: string;
}

export interface DapiClient {
  getBlogPostById(postId: string, ctx: FetchContext): Promise<BlogPostDocument | null>;
  getBlogById(blogId: string, ctx: FetchContext): Promise<BlogDocument | null>;
  getIdentity(identityId: string): Promise<IdentityDocument | null>;
}

export interface RenderResult {
  html: string;
  blocks: BlockNoteBlock[];
}

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}
