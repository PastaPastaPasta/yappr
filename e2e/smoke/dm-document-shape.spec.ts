import { expect, test } from '@playwright/test'
import { buildDirectMessageDocumentData } from '../../lib/services/direct-message-data'

test('directMessage payload includes the recipient index field', () => {
  const payload = buildDirectMessageDocumentData(
    '3NdmhtrNQA83jfUMTotE2pZyxSoYd1JxYqabNFdNRwGu',
    new Uint8Array(10),
    new Uint8Array([1, 2, 3])
  )

  expect(payload.recipientId).toBeInstanceOf(Uint8Array)
  expect((payload.recipientId as Uint8Array)).toHaveLength(32)
  expect((payload.conversationId as Uint8Array)).toHaveLength(10)
  expect(payload.encryptedContent).toEqual(new Uint8Array([1, 2, 3]))
})
