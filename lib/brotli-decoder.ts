/** A small WASM brotli decoder for browsers whose DecompressionStream cannot
 * read brotli (Chrome, Android). Imported dynamically, so never in the main bundle. */
import initDecoder, { BrotliDecStream, BrotliStreamResultCode } from 'brotli-dec-wasm/web'

const OUTPUT_CHUNK = 1 << 20

let ready: Promise<unknown> | undefined

/** A streaming brotli decoder. Corrupt, truncated or trailing input errors the stream. */
export async function brotliDecoderStream(): Promise<TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>> {
  // The glue fetches its WASM from the URL the bundler emitted next to it.
  ready ??= initDecoder().catch((error: unknown) => {
    ready = undefined // A failed load can be tried again.
    throw error
  })
  await ready
  const decoder = new BrotliDecStream()
  let code: BrotliStreamResultCode = BrotliStreamResultCode.NeedsMoreInput
  return new TransformStream({
    transform(chunk, controller) {
      try {
        let input = chunk
        while (code !== BrotliStreamResultCode.ResultSuccess && (input.length > 0 || code === BrotliStreamResultCode.NeedsMoreOutput)) {
          const result = decoder.dec(input, OUTPUT_CHUNK)
          code = result.code
          input = input.subarray(result.input_offset)
          // A fresh copy out of the decoder's memory, so backed by an ArrayBuffer.
          const out = result.buf as Uint8Array<ArrayBuffer>
          result.free()
          if (out.length > 0) controller.enqueue(out)
        }
        if (input.length > 0) throw new Error('Unexpected data after the brotli stream')
      } catch (error) {
        // An errored stream gets no further calls, so this is the only release.
        decoder.free()
        throw error
      }
    },
    flush() {
      decoder.free()
      if (code !== BrotliStreamResultCode.ResultSuccess) throw new Error('Truncated brotli stream')
    },
  })
}
