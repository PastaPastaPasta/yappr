export type EmbedTheme = 'light' | 'dark'

export interface EmbedConfig {
  postId: string
  ownerId?: string
  theme?: EmbedTheme
  ipfsGateway?: string
  appUrl?: string
  height?: number
}

export interface EmbedRenderOptions {
  ipfsGateway?: string
}

export interface EmbedBlock {
  id?: string
  type?: string
  props?: Record<string, unknown>
  content?: unknown
  children?: EmbedBlock[]
  [key: string]: unknown
}
