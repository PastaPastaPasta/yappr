import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { categorizeError } from '@/lib/error-utils'
import { RpcError } from '../../src/protocol/envelope'
import { BUILD_DEFECT_MESSAGE, NOT_DISTINCT_MESSAGE, TOO_YOUNG_MESSAGE, classify, ticketStateFor } from '../../src/writes/classify'
import type { EngineErrorCode } from '../../src/writes/types'
import fixture from '../fixtures/error-vectors.json'

interface Vector {
  name: string
  error: { message: string; name?: string; code?: number }
  expect: { code: EngineErrorCode; consensusCode: number | null; outcome: string; retryable: boolean; state: string; userMessage: string }
}

const vectors = fixture.vectors as Vector[]

/** An Error for prose-only vectors; an SDK-shaped error (WasmSdkError fields) when the vector carries a numeric code. */
function toError(error: Vector['error']): unknown {
  if (error.code === undefined) return new Error(error.message)
  return { name: error.name ?? 'Protocol', message: error.message, code: error.code, kind: 0, isRetriable: false }
}

/** Every code classify() can produce from an SDK or lib error (ENGINE.md §7.3 stages 1 and 2). */
const CLASSIFY_CODES: EngineErrorCode[] = [
  'MODERATION_BARRED', 'MODERATION_NOT_SEATED', 'TOO_LONG', 'RULE_VIOLATION', 'ALREADY_CLAIMED', 'PARENT_TOO_YOUNG',
  'FEE_UNPAYABLE', 'FEE_SHARE_MISMATCH', 'EXPIRED', 'CONTEST', 'FEE_CHANGED', 'NONCE_CONFLICT', 'NOT_RECORDED',
  'PENDING_WRITE', 'STORAGE', 'APP_OUTDATED', 'BUILD_DEFECT', 'IMMUTABLE', 'TARGET_GONE', 'NOT_OWNER', 'STALE',
  'FROZEN', 'INSUFFICIENT_YAPP', 'DUPLICATE', 'RATE_LIMITED', 'TIMEOUT', 'NETWORK', 'NO_KEY', 'UNKNOWN',
]

describe('classify() against the error vectors', () => {
  it.each(vectors.map(vector => [vector.name, vector] as const))('%s', (_name, vector) => {
    const error = toError(vector.error)
    const data = classify(error)
    expect(data).toEqual({
      code: vector.expect.code,
      consensusCode: vector.expect.consensusCode,
      outcome: vector.expect.outcome,
      retryable: vector.expect.retryable,
      userMessage: vector.expect.userMessage,
    })
    expect(ticketStateFor(data)).toBe(vector.expect.state)
    // Same branch as web: the message is categorizeError's, verbatim.
    expect(data.userMessage).toBe(categorizeError(error))
  })

  it('covers every code classify() can produce', () => {
    const covered = new Map<string, number>()
    for (const vector of vectors) covered.set(vector.expect.code, (covered.get(vector.expect.code) ?? 0) + 1)
    expect(CLASSIFY_CODES.filter(code => !covered.has(code))).toEqual([])
    // The coverage table for the PR: code → vector count.
    const dir = process.env.EVIDENCE_DIR
    if (dir) {
      mkdirSync(dir, { recursive: true })
      const rows = CLASSIFY_CODES.map(code => `| ${code} | ${covered.get(code) ?? 0} |`)
      writeFileSync(path.join(dir, 'classify-coverage.md'), ['| code | vectors |', '| --- | --- |', ...rows, ''].join('\n'))
    }
  })

  it('pins the categorizeError strings that stand in for lib\'s module-private predicates', () => {
    expect(categorizeError(new Error('Document type "follow" property "followingId" must differ from "$ownerId", but the two values are equal'))).toBe(NOT_DISTINCT_MESSAGE)
    expect(categorizeError({ code: 40142, message: 'refused' })).toBe(TOO_YOUNG_MESSAGE)
    expect(categorizeError(new Error('VotePoll V1 does not allow the vote choice Lock'))).toBe(BUILD_DEFECT_MESSAGE)
  })
})

describe('classify() for engine errors', () => {
  it('passes the engine\'s own codes through as local, with their own message', () => {
    expect(classify(new RpcError('The post you replied to is not confirmed yet', 'PARENT_UNCONFIRMED'))).toEqual({
      code: 'PARENT_UNCONFIRMED',
      consensusCode: null,
      outcome: 'local',
      retryable: false,
      userMessage: 'The post you replied to is not confirmed yet',
    })
  })

  it('does not read an unknown string code as an engine code', () => {
    expect(classify({ code: 'ECONNRESET', message: 'socket hang up' }).code).toBe('UNKNOWN')
  })

  it('survives a freed wasm error whose getters throw', () => {
    const freed = Object.defineProperty({ message: 'wait timed out' }, 'code', { get: () => { throw new Error('null pointer passed to rust') } })
    expect(classify(freed).code).toBe('TIMEOUT')
  })
})
