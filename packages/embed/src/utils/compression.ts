import { strFromU8, unzlibSync } from 'fflate';
import type { BlockNoteBlock } from '../types';

export function decompressBlockNoteContent(content: Uint8Array): BlockNoteBlock[] {
  if (!content || content.length === 0) {
    return [];
  }

  const uncompressed = unzlibSync(content);
  const decoded = strFromU8(uncompressed);
  const parsed = JSON.parse(decoded) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error('Invalid BlockNote payload, expected an array');
  }

  return parsed as BlockNoteBlock[];
}
