import { identifierStringToDocumentBytes } from './sdk-helpers'

/** Build a schema-complete directMessage document payload. */
export function buildDirectMessageDocumentData(
  recipientId: string,
  conversationId: Uint8Array,
  encryptedContent: Uint8Array
): Record<string, unknown> {
  return {
    recipientId: identifierStringToDocumentBytes(recipientId),
    conversationId,
    encryptedContent,
  }
}
