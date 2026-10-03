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

/** How long one gateway may take to start answering before the next is tried. */
const GATEWAY_RESPONSE_TIMEOUT_MS = 30_000;

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

async function fetchWithResponseTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATEWAY_RESPONSE_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
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
  let lastError: unknown = null;
  for (const url of urls) {
    try {
      const response = await fetchWithResponseTimeout(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const plaintext = decryptDigitalFile(new Uint8Array(await response.arrayBuffer()), key);
      // Never the seller's MIME type: an html/svg blob on this origin must not render if `download` is ignored.
      return new Blob([plaintext], { type: 'application/octet-stream' });
    } catch (error) {
      logger.warn(`Digital file download from ${url} failed:`, error);
      lastError = error;
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
