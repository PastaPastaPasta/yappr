export interface LinkPreviewData {
  url: string
  title?: string
  description?: string
  image?: string
  imageWidth?: number
  imageHeight?: number
  siteName?: string
  favicon?: string
  /** The URL points straight at an image (by extension or Content-Type). */
  isDirectImage?: boolean
  /** Set when the URL is a YouTube video, for the embedded player. */
  youtubeVideoId?: string
}
