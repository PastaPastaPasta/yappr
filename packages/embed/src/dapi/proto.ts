import { decodeBase58 } from '../utils/base58';

function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  let current = value >>> 0;

  while (current >= 0x80) {
    bytes.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }

  bytes.push(current);
  return bytes;
}

function decodeVarint(data: Uint8Array, offset: number): { value: number; offset: number } {
  let result = 0;
  let shift = 0;
  let currentOffset = offset;

  while (currentOffset < data.length) {
    const byte = data[currentOffset];
    result |= (byte & 0x7f) << shift;
    currentOffset += 1;

    if ((byte & 0x80) === 0) {
      return { value: result, offset: currentOffset };
    }

    shift += 7;
  }

  throw new Error('Invalid varint encoding');
}

function fieldTag(fieldNumber: number, wireType: number): number {
  return (fieldNumber << 3) | wireType;
}

function encodeStringField(fieldNumber: number, value: string): number[] {
  const encoded = new TextEncoder().encode(value);
  return [fieldTag(fieldNumber, 2), ...encodeVarint(encoded.length), ...encoded];
}

function encodeBytesField(fieldNumber: number, value: Uint8Array): number[] {
  return [fieldTag(fieldNumber, 2), ...encodeVarint(value.length), ...value];
}

function encodeMessageField(fieldNumber: number, bytes: Uint8Array): number[] {
  return [fieldTag(fieldNumber, 2), ...encodeVarint(bytes.length), ...bytes];
}

function encodeCborValue(value: unknown): Uint8Array {
  const bytes: number[] = [];

  function writeTypeAndLength(majorType: number, length: number): void {
    if (length < 24) {
      bytes.push((majorType << 5) | length);
      return;
    }
    if (length <= 0xff) {
      bytes.push((majorType << 5) | 24, length);
      return;
    }
    if (length <= 0xffff) {
      bytes.push((majorType << 5) | 25, (length >> 8) & 0xff, length & 0xff);
      return;
    }
    throw new Error('Unsupported CBOR length');
  }

  function write(inner: unknown): void {
    if (Array.isArray(inner)) {
      writeTypeAndLength(4, inner.length);
      inner.forEach(write);
      return;
    }

    if (inner instanceof Uint8Array) {
      writeTypeAndLength(2, inner.length);
      bytes.push(...inner);
      return;
    }

    if (typeof inner === 'string') {
      const encoded = new TextEncoder().encode(inner);
      writeTypeAndLength(3, encoded.length);
      bytes.push(...encoded);
      return;
    }

    if (typeof inner === 'number' && Number.isInteger(inner) && inner >= 0) {
      writeTypeAndLength(0, inner);
      return;
    }

    if (inner === null) {
      bytes.push(0xf6);
      return;
    }

    throw new Error('Unsupported CBOR value for MVP encoder');
  }

  write(value);
  return new Uint8Array(bytes);
}

export interface DocumentsQuery {
  contractId: string;
  documentType: string;
  where?: unknown;
  limit?: number;
}

export function encodeGetDocumentsRequest(query: DocumentsQuery): Uint8Array {
  const v0Fields: number[] = [];

  v0Fields.push(...encodeBytesField(1, decodeBase58(query.contractId)));
  v0Fields.push(...encodeStringField(2, query.documentType));

  if (query.where) {
    const where = encodeCborValue(query.where);
    v0Fields.push(...encodeBytesField(3, where));
  }

  if (query.limit && query.limit > 0) {
    v0Fields.push(fieldTag(5, 0), ...encodeVarint(query.limit));
  }

  const v0Bytes = new Uint8Array(v0Fields);
  const request = new Uint8Array(encodeMessageField(1, v0Bytes));
  return request;
}

function parseDelimitedAt(data: Uint8Array, offset: number): { value: Uint8Array; offset: number } {
  const lengthDecoded = decodeVarint(data, offset);
  const start = lengthDecoded.offset;
  const end = start + lengthDecoded.value;
  if (end > data.length) {
    throw new Error('Invalid length-delimited field');
  }
  return {
    value: data.slice(start, end),
    offset: end
  };
}

export function decodeGetDocumentsResponse(frame: Uint8Array): Uint8Array[] {
  let offset = 0;
  let v0: Uint8Array | null = null;

  while (offset < frame.length) {
    const tag = decodeVarint(frame, offset);
    offset = tag.offset;

    const fieldNumber = tag.value >> 3;
    const wireType = tag.value & 0x7;

    if (fieldNumber === 1 && wireType === 2) {
      const parsed = parseDelimitedAt(frame, offset);
      v0 = parsed.value;
      offset = parsed.offset;
      continue;
    }

    if (wireType === 2) {
      const skipped = parseDelimitedAt(frame, offset);
      offset = skipped.offset;
    } else if (wireType === 0) {
      offset = decodeVarint(frame, offset).offset;
    } else {
      throw new Error('Unsupported wire type in response');
    }
  }

  if (!v0) {
    return [];
  }

  const docs: Uint8Array[] = [];
  offset = 0;

  while (offset < v0.length) {
    const tag = decodeVarint(v0, offset);
    offset = tag.offset;

    const fieldNumber = tag.value >> 3;
    const wireType = tag.value & 0x7;

    if (fieldNumber === 1 && wireType === 2) {
      const parsed = parseDelimitedAt(v0, offset);
      docs.push(parsed.value);
      offset = parsed.offset;
      continue;
    }

    if (wireType === 2) {
      const skipped = parseDelimitedAt(v0, offset);
      offset = skipped.offset;
    } else if (wireType === 0) {
      offset = decodeVarint(v0, offset).offset;
    } else {
      throw new Error('Unsupported wire type in documents response');
    }
  }

  return docs;
}

export function encodeGrpcWebFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(payload.length + 5);
  frame[0] = 0;
  const view = new DataView(frame.buffer);
  view.setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

export function decodeGrpcWebFrames(raw: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let offset = 0;

  while (offset + 5 <= raw.length) {
    const isTrailer = (raw[offset] & 0x80) !== 0;
    const length = new DataView(raw.buffer, raw.byteOffset + offset + 1, 4).getUint32(0, false);
    const start = offset + 5;
    const end = start + length;
    if (end > raw.length) {
      break;
    }

    if (!isTrailer) {
      frames.push(raw.slice(start, end));
    }

    offset = end;
  }

  return frames;
}
