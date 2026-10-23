import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

import { useSessionStore } from '~/data/session';
import { engine } from '~/engine';

/**
 * Saving a delivered file (MARCH-1, MARCH-2). The engine downloads and
 * decrypts it and holds it; this reads it in bounded chunks
 * (`store.deliveredFileChunk`) and appends each to the file, so the file is
 * never one string on the bridge or in Hermes. The finished file is checked
 * against the engine's size and MD5, then handed to the share sheet.
 *
 * Files are written under `<cache>/yappr-deliveries/<account>/<delivery>-<item>-<asset>/`,
 * so two orders' `invoice.pdf` never meet. One save runs at a time. The
 * decrypted copy is deleted once it is shared on iOS (the share sheet has
 * copied it by then); on Android the receiving app may still be reading it
 * after the chooser returns, so it stays until the next save starts or the
 * account signs out ({@link forgetDeliveredFiles}).
 */

const ROOT = 'yappr-deliveries';

/** A file or folder name the cache directory takes: no path separators or control characters. */
const safeFileName = (name: string) =>
  name.replace(/[\\/:\u0000-\u001f]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'download';

export interface DeliveredFileRef {
  orderId: string;
  deliveryId: string;
  itemIndex: number;
  assetIndex: number;
}

const BUSY_MESSAGE = 'Another file is still saving. Try again when it is done.';
const CORRUPT_MESSAGE = "This file didn't save correctly. Try again.";

let saving = false;

const deleteQuietly = (entry: File | Directory) => {
  try {
    if (entry.exists) entry.delete();
  } catch {
    // Cache space the system reclaims anyway.
  }
};

const accountFolder = (identityId: string) => new Directory(Paths.cache, ROOT, safeFileName(identityId));

/**
 * Download, decrypt and write one delivered file, then open the share sheet
 * for it (save to Files, open in…). Resolves once the share sheet closes.
 */
export async function saveDeliveredFile(ref: DeliveredFileRef): Promise<void> {
  if (saving) throw new Error(BUSY_MESSAGE);
  saving = true;
  let folder: Directory | null = null;
  let handle: string | null = null;
  let shared = false;
  try {
    // Leftovers of earlier saves (Android keeps each until the next one).
    deleteQuietly(new Directory(Paths.cache, ROOT));
    const identityId = useSessionStore.getState().session?.identityId ?? 'signed-out';
    const opened = await engine.api.store.openDeliveredFile(ref);
    handle = opened.handle;
    folder = new Directory(accountFolder(identityId), safeFileName(`${ref.deliveryId}-${ref.itemIndex}-${ref.assetIndex}`));
    folder.create({ intermediates: true, idempotent: true });
    const target = new File(folder, safeFileName(opened.name));
    target.create({ overwrite: true });
    for (let offset = 0; offset < opened.size; ) {
      const chunk = await engine.api.store.deliveredFileChunk(opened.handle, offset);
      if (chunk.length === 0) throw new Error(CORRUPT_MESSAGE);
      target.write(chunk, { append: true });
      offset += chunk.length;
    }
    // The chunk that reached the end released the engine's copy.
    handle = null;
    if (target.size !== opened.size || target.md5 !== opened.md5) throw new Error(CORRUPT_MESSAGE);
    await Sharing.shareAsync(target.uri, { dialogTitle: opened.name });
    shared = true;
  } finally {
    saving = false;
    if (handle) engine.api.store.closeDeliveredFile(handle).catch(() => undefined);
    if (folder && (!shared || Platform.OS === 'ios')) deleteQuietly(folder);
  }
}

/** Signing an account out, or removing it, deletes the delivered files it saved (PRD AUTH-11). */
export function forgetDeliveredFiles(identityId: string): void {
  deleteQuietly(accountFolder(identityId));
}
