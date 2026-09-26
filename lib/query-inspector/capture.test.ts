import { describe, expect, it } from 'vitest'
import { recordedParams } from './capture'

describe('recordedParams', () => {
  it('redacts the plaintext message and writer key of the moderation request builders', () => {
    for (const method of ['moderationCharters.buildJoinRequest', 'moderationCharters.buildResignationRequest']) {
      const params = recordedParams(method, [{
        electedCharterId: 'charter',
        message: 'only the leader may read this',
        writerEncryptionKey: { __wbg_ptr: 1 },
      }])
      expect(params).toEqual({ electedCharterId: 'charter', message: '[redacted]', writerEncryptionKey: '[redacted]' })
    }
  })

  it('leaves other methods and absent fields untouched', () => {
    expect(recordedParams('documents.query', [{ message: 'public' }])).toEqual({ message: 'public' })
    expect(recordedParams('moderationCharters.buildJoinRequest', [{ submittedCharterId: 'p' }]))
      .toEqual({ submittedCharterId: 'p' })
  })
})
