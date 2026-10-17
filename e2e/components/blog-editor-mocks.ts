import type { UseImageUploadResult } from '@/hooks/use-image-upload'

/** The blog editor fixture never uploads: no storage provider is connected. */
export function useImageUpload(): UseImageUploadResult {
  return {
    upload: () => Promise.reject(new Error('No storage provider connected')),
    isUploading: false,
    progress: 0,
    error: null,
    isProviderConnected: false,
    checkProvider: () => Promise.resolve(false),
    clearError: () => undefined,
  }
}
