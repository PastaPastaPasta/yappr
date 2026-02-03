/**
 * NSFW Detection Service
 *
 * Singleton service that lazily loads TensorFlow.js + NSFWJS model
 * and classifies images client-side. All processing stays in the browser.
 *
 * - Model: quantized MobileNet (~5 MB) from NSFWJS CDN
 * - Caches results in-memory (classification is deterministic)
 * - Deduplicates concurrent model loads
 * - Falls back gracefully on CORS errors
 */

import { isIpfsProtocol, ipfsToGatewayUrl, getAllGatewayUrls } from '@/lib/utils/ipfs-gateway'

export interface NsfwPrediction {
  drawing: number
  hentai: number
  neutral: number
  porn: number
  sexy: number
}

export interface NsfwResult {
  predictions: NsfwPrediction
  isNsfw: boolean
  flaggedCategories: string[]
}

type NsfwModel = {
  classify: (img: HTMLImageElement) => Promise<Array<{ className: string; probability: number }>>
}

const MODEL_URL = 'https://nsfwjs.com/quant_nsfw_mobilenet/'

class NsfwDetectionService {
  private model: NsfwModel | null = null
  private loadPromise: Promise<NsfwModel> | null = null
  private cache = new Map<string, NsfwPrediction>()

  async loadModel(): Promise<NsfwModel> {
    if (this.model) return this.model

    // Deduplicate concurrent loads
    if (this.loadPromise) return this.loadPromise

    this.loadPromise = (async () => {
      const tf = await import('@tensorflow/tfjs')
      const nsfwjs = await import('nsfwjs')

      // Prefer WebGL backend, fall back to CPU
      try {
        await tf.setBackend('webgl')
        await tf.ready()
      } catch {
        await tf.setBackend('cpu')
        await tf.ready()
      }

      const model = await nsfwjs.load(MODEL_URL, { type: 'graph' })
      this.model = model as unknown as NsfwModel
      return this.model
    })()

    try {
      return await this.loadPromise
    } catch (error) {
      // Allow retry on failure
      this.loadPromise = null
      throw error
    }
  }

  private resolveUrl(imageUrl: string): string {
    if (isIpfsProtocol(imageUrl)) {
      return ipfsToGatewayUrl(imageUrl)
    }
    return imageUrl
  }

  private loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = document.createElement('img')
      img.crossOrigin = 'anonymous'
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error(`Failed to load image: ${url}`))
      img.src = url
    })
  }

  async classify(imageUrl: string): Promise<NsfwPrediction> {
    const resolvedUrl = this.resolveUrl(imageUrl)

    // Check cache
    const cached = this.cache.get(resolvedUrl)
    if (cached) return cached

    const model = await this.loadModel()

    // Blob URLs (compose preview) work directly — no CORS issues
    if (resolvedUrl.startsWith('blob:')) {
      const img = await this.loadImage(resolvedUrl)
      const predictions = await this.classifyImage(model, img)
      this.cache.set(resolvedUrl, predictions)
      return predictions
    }

    // Try primary URL first
    try {
      const img = await this.loadImage(resolvedUrl)
      const predictions = await this.classifyImage(model, img)
      this.cache.set(resolvedUrl, predictions)
      return predictions
    } catch {
      // On CORS failure, try all gateway URLs if it was an IPFS URL
      if (isIpfsProtocol(imageUrl)) {
        const gatewayUrls = getAllGatewayUrls(imageUrl)
        for (const gatewayUrl of gatewayUrls) {
          if (gatewayUrl === resolvedUrl) continue
          try {
            const img = await this.loadImage(gatewayUrl)
            const predictions = await this.classifyImage(model, img)
            this.cache.set(resolvedUrl, predictions)
            return predictions
          } catch {
            continue
          }
        }
      }
      throw new Error('Failed to classify image: all sources failed')
    }
  }

  private async classifyImage(
    model: NsfwModel,
    img: HTMLImageElement
  ): Promise<NsfwPrediction> {
    const rawPredictions = await model.classify(img)

    const predictions: NsfwPrediction = {
      drawing: 0,
      hentai: 0,
      neutral: 0,
      porn: 0,
      sexy: 0,
    }

    for (const p of rawPredictions) {
      const key = p.className.toLowerCase() as keyof NsfwPrediction
      if (key in predictions) {
        predictions[key] = p.probability
      }
    }

    return predictions
  }

  evaluateResult(predictions: NsfwPrediction, threshold: number): NsfwResult {
    const nsfwScore = predictions.porn + predictions.hentai + predictions.sexy
    const isNsfw = nsfwScore > threshold

    const flaggedCategories: string[] = []
    if (predictions.porn > threshold / 3) flaggedCategories.push('porn')
    if (predictions.hentai > threshold / 3) flaggedCategories.push('hentai')
    if (predictions.sexy > threshold / 3) flaggedCategories.push('sexy')

    return { predictions, isNsfw, flaggedCategories }
  }
}

export const nsfwDetectionService = new NsfwDetectionService()
