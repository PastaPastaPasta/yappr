import { logger } from '@/lib/logger';
/**
 * Digital product files: encrypted in the browser before they leave it, and
 * decrypted in the buyer's browser after download. The IPFS provider and the
 * gateways only ever see ciphertext (lib/crypto/digital-delivery.ts).
 */

import { getUploadProvider, UploadErrorCode, UploadException } from '../upload';
import { getAllGatewayUrls } from '../utils/ipfs-gateway';
import { base64ToBytes, bytesToBase64 } from '../bytes';
import { decryptDigitalFile, encryptDigitalFile, FILE_CIPHERTEXT_OVERHEAD } from '../crypto/digital-delivery';
import { MAX_DIGITAL_FILE_BYTES } from './digital-delivery-plan';
import type { DigitalAsset } from '../../types';

export type DigitalFileAsset = Extract<DigitalAsset, { kind: 'file' }>;

/**
 * How long one gateway may go without sending anything (its headers, or the
 * next part of the file) before the next is tried. An idle deadline, not a
 * total one: a large download that keeps arriving is never cut off.
 */
const GATEWAY_IDLE_TIMEOUT_MS = 30_000;

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Encrypt `file` under a fresh key and pin the ciphertext with the identity's upload provider. */
export async function uploadEncryptedFile(
  identityId: string,
  file: File,
  onProgress?: (percent: number) => void
): Promise<DigitalFileAsset> {
  if (file.size > MAX_DIGITAL_FILE_BYTES) {
    throw new UploadException(UploadErrorCode.INVALID_FILE, `Files must be under ${formatFileSize(MAX_DIGITAL_FILE_BYTES)}`);
  }
  const provider = await getUploadProvider(identityId);
  if (!provider) {
    throw new UploadException(UploadErrorCode.NOT_CONNECTED, 'No storage provider connected. Connect one in Settings to upload files.');
  }

  const { ciphertext, key } = encryptDigitalFile(new Uint8Array(await file.arrayBuffer()));
  const sealed = new File([ciphertext], `${file.name}.enc`, { type: 'application/octet-stream' });
  const result = await provider.uploadFile(sealed, { maxBytes: MAX_DIGITAL_FILE_BYTES + FILE_CIPHERTEXT_OVERHEAD, onProgress });

  return {
    kind: 'file',
    name: file.name,
    size: file.size,
    url: result.url,
    key: bytesToBase64(key),
    ...(file.type ? { mime: file.type } : {}),
  };
}

/** The most ciphertext a delivered file can be: the largest file a seller may attach, sealed. */
const MAX_DOWNLOAD_BYTES = MAX_DIGITAL_FILE_BYTES + FILE_CIPHERTEXT_OVERHEAD;

const tooLarge = () => new Error(`The file is larger than ${formatFileSize(MAX_DIGITAL_FILE_BYTES)}, so it was not downloaded`);

/**
 * A response body, read only up to `maxBytes`. The URL is seller-written and
 * the server answering it untrusted: neither an advertised size nor
 * Content-Length bounds what it sends, so the stream is counted as it
 * arrives and cancelled once it passes the cap, before it can exhaust memory.
 * `onChunk` is called as each part arrives.
 */
async function readBounded(response: Response, maxBytes: number, onChunk: () => void): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk();
    received += value.length;
    if (received > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/**
 * One gateway's copy of the ciphertext. The attempt is aborted whenever the
 * gateway goes GATEWAY_IDLE_TIMEOUT_MS without sending anything, whether it
 * never answers or answers and then stalls mid-file, so the next gateway
 * gets its turn.
 */
async function downloadCiphertext(url: string): Promise<Uint8Array> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const extendDeadline = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), GATEWAY_IDLE_TIMEOUT_MS);
  };
  extendDeadline();
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await readBounded(response, MAX_DOWNLOAD_BYTES, extendDeadline);
  } finally {
    clearTimeout(timer);
    // Release whatever this attempt left open (an unread error body); a no-op once the body was read.
    controller.abort();
  }
}

/**
 * Download and decrypt a delivered file, trying each IPFS gateway in turn.
 * A gateway that answers with the wrong bytes fails authentication and the
 * next one is tried, so a bad gateway can never hand the buyer a tampered file.
 */
export async function fetchDecryptedFile(asset: DigitalFileAsset): Promise<Blob> {
  const key = base64ToBytes(asset.key);
  // A non-ipfs:// URL comes back as itself.
  const urls = getAllGatewayUrls(asset.url);
  // The URL may carry the seller's secret (a token in its path or query): it
  // is never logged, and errors keep only their kind and URL-free message.
  let lastError: Error | null = null;
  for (const [attempt, url] of urls.entries()) {
    try {
      const plaintext = decryptDigitalFile(await downloadCiphertext(url), key);
      // Never the seller's MIME type: an html/svg blob on this origin must not render if `download` is ignored.
      return new Blob([plaintext], { type: 'application/octet-stream' });
    } catch (error) {
      const reason = error instanceof Error ? `${error.name}: ${error.message.split(url).join('<url>')}` : 'unknown error';
      logger.warn(`Digital file download attempt ${attempt + 1} of ${urls.length} failed (${reason})`);
      lastError = new Error(reason);
    }
  }
  throw new Error('Could not download this file from any IPFS gateway. Try again in a few minutes.', { cause: lastError });
}

/** Hand a blob to the browser as a download named `name`. */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke after the click has been handled; revoking synchronously can cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
