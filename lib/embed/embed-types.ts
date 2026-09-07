export type EmbedTheme = 'light' | 'dark'

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
