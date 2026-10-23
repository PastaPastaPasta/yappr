import type { SessionDTO } from '@engine/api';
import { createHash, randomBytes } from 'crypto';
import { Platform } from 'react-native';

import { useSessionStore } from '~/data/session';

import { forgetDeliveredFiles, saveDeliveredFile } from './delivered-files';

/**
 * A stand-in for the engine's held delivered files: `open` holds the
 * plaintext, `chunk` hands it out in `CHUNK`-byte pieces, as
 * `store.deliveredFileChunk` does (MARCH-1).
 */
const CHUNK = 1000;
const mockFiles = {
  held: new Map<string, Uint8Array>(),
  plaintext: new Uint8Array(0),
  name: 'invoice.pdf',
  /** Tampers with what a chunk read returns. */
  corrupt: null as null | ((chunk: Uint8Array, offset: number) => Uint8Array),
};
const mockStore = {
  openDeliveredFile: jest.fn(async (ref: { deliveryId: string }) => {
    const handle = `h-${ref.deliveryId}`;
    mockFiles.held.set(handle, mockFiles.plaintext);
    return { handle, name: mockFiles.name, size: mockFiles.plaintext.length, md5: createHash('md5').update(mockFiles.plaintext).digest('hex') };
  }),
  deliveredFileChunk: jest.fn(async (handle: string, offset: number) => {
    const bytes = mockFiles.held.get(handle);
    if (!bytes) throw new Error('This file is no longer open. Save it again.');
    const chunk = bytes.slice(offset, offset + CHUNK);
    if (offset + chunk.length >= bytes.length) mockFiles.held.delete(handle);
    return mockFiles.corrupt ? mockFiles.corrupt(chunk, offset) : chunk;
  }),
  closeDeliveredFile: jest.fn(async (handle: string) => {
    mockFiles.held.delete(handle);
  }),
};
jest.mock('~/engine', () => ({ engine: { api: { get store() { return mockStore; } } } }));
const mockShare = jest.fn(async (_uri: string, _options?: unknown) => undefined);
jest.mock('expo-sharing', () => ({ shareAsync: (uri: string, options?: unknown) => mockShare(uri, options) }));

const { __fs: fs } = jest.requireMock<{ __fs: { files: Map<string, Uint8Array> } }>('expo-file-system');

const ACCOUNT = 'AliceId111111111111111111111111111111111111';
const session = (identityId: string): SessionDTO => ({
  identityId, network: 'devnet', username: 'alice', credits: 1n, hasEncryptionKey: true, method: 'key',
});
const ref = (deliveryId: string, assetIndex = 0) => ({ orderId: 'Order1', deliveryId, itemIndex: 0, assetIndex });
const sharedUri = (call = 0) => mockShare.mock.calls[call][0];
const savedFiles = () => [...fs.files.keys()];

/** The bytes the share sheet was given, read when it opened (iOS deletes them once it closes). */
let sharedBytes: Uint8Array[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  fs.files.clear();
  mockFiles.held.clear();
  mockFiles.corrupt = null;
  mockFiles.name = 'invoice.pdf';
  mockFiles.plaintext = new Uint8Array(randomBytes(4 * CHUNK + 321));
  sharedBytes = [];
  mockShare.mockImplementation(async (uri: string) => {
    sharedBytes.push(fs.files.get(uri)!);
  });
  useSessionStore.setState({ session: session(ACCOUNT) });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('saveDeliveredFile', () => {
  it('appends the file chunk by chunk, shares it, and deletes it once shared (iOS)', async () => {
    await saveDeliveredFile(ref('DeliveryA', 2));
    expect(mockStore.deliveredFileChunk.mock.calls.map(([, offset]) => offset)).toEqual([0, 1000, 2000, 3000, 4000]);
    expect(sharedUri()).toBe(`file:///cache/yappr-deliveries/${ACCOUNT}/DeliveryA-0-2/invoice.pdf`);
    expect(sharedBytes[0]).toEqual(mockFiles.plaintext);
    // The engine's copy went with the last chunk; nothing is left to close, and nothing stays in the cache.
    expect(mockStore.closeDeliveredFile).not.toHaveBeenCalled();
    expect(savedFiles()).toEqual([]);
  });

  it('saves two deliveries with the same file name to different places', async () => {
    await saveDeliveredFile(ref('DeliveryA'));
    const first = mockFiles.plaintext;
    mockFiles.plaintext = new Uint8Array(randomBytes(1500));
    await saveDeliveredFile(ref('DeliveryB'));
    expect(sharedUri(0)).not.toBe(sharedUri(1));
    expect(sharedBytes).toEqual([first, mockFiles.plaintext]);
  });

  it('keeps the shared file on Android until the next save or a sign-out', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    await saveDeliveredFile(ref('DeliveryA'));
    expect(savedFiles()).toEqual([sharedUri(0)]);
    // The next save sweeps it.
    await saveDeliveredFile(ref('DeliveryB'));
    expect(savedFiles()).toEqual([sharedUri(1)]);
    // Another account's sign-out leaves it; this account's deletes it.
    forgetDeliveredFiles('BobId11111111111111111111111111111111111111');
    expect(savedFiles()).toHaveLength(1);
    forgetDeliveredFiles(ACCOUNT);
    expect(savedFiles()).toEqual([]);
  });

  it('refuses a file that did not assemble to the size and MD5 the engine declared, and deletes it', async () => {
    // A chunk delivered twice: the file grows past its size.
    mockFiles.corrupt = (chunk, offset) => (offset === CHUNK ? new Uint8Array([...chunk.slice(0, 10), ...chunk]) : chunk);
    await expect(saveDeliveredFile(ref('DeliveryA'))).rejects.toThrow("didn't save correctly");
    expect(mockShare).not.toHaveBeenCalled();
    expect(savedFiles()).toEqual([]);

    // Same length, a flipped byte: only the MD5 can tell.
    mockFiles.corrupt = (chunk, offset) => (offset === 0 ? chunk.map((byte, i) => (i === 5 ? byte ^ 1 : byte)) : chunk);
    await expect(saveDeliveredFile(ref('DeliveryA'))).rejects.toThrow("didn't save correctly");
    expect(mockShare).not.toHaveBeenCalled();
  });

  it('closes the engine copy and deletes the partial file when a chunk read fails', async () => {
    mockStore.deliveredFileChunk.mockImplementationOnce(async () => new Uint8Array(CHUNK)).mockRejectedValueOnce(new Error('Engine restarted'));
    await expect(saveDeliveredFile(ref('DeliveryA'))).rejects.toThrow('Engine restarted');
    expect(mockStore.closeDeliveredFile).toHaveBeenCalledWith('h-DeliveryA');
    expect(savedFiles()).toEqual([]);
  });

  it('runs one save at a time', async () => {
    let release!: () => void;
    mockShare.mockImplementationOnce(() => new Promise<undefined>((resolve) => { release = () => resolve(undefined); }));
    const first = saveDeliveredFile(ref('DeliveryA'));
    await expect(saveDeliveredFile(ref('DeliveryB'))).rejects.toThrow('Another file is still saving');
    while (!release) await Promise.resolve();
    release();
    await first;
    expect(mockStore.openDeliveredFile).toHaveBeenCalledTimes(1);
    // The next one goes through.
    await saveDeliveredFile(ref('DeliveryB'));
    expect(mockStore.openDeliveredFile).toHaveBeenCalledTimes(2);
  });
});
