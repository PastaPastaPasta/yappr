/**
 * A fake Evo SDK for the query → index conformance spec: every document read
 * the services send is recorded (contract, doctype and the request shape) and
 * answered with an empty result of the shape the caller expects. Every other
 * SDK namespace answers any call with an empty value, so a reader that also
 * touches identities, names or tokens runs to its document reads.
 */

import type { EvoSDK } from '@dashevo/evo-sdk'
import type { CompositeSubQueryShape, OrderTuple, TimeRangeSelection, WhereTuple } from './query-index-model'

export type CapturedSurface = 'documents' | 'count' | 'ranked' | 'average' | 'compositePage' | 'compositeSub' | 'get'

export interface CapturedRequest {
  surface: CapturedSurface
  /** The reader being driven when the request was sent. */
  reader: string
  dataContractId: string
  documentTypeName: string
  where?: WhereTuple[]
  orderBy?: OrderTuple[]
  groupBy?: string[]
  limit?: number
  startAt?: unknown
  startAfter?: unknown
  timeRange?: TimeRangeSelection[]
  /** Ranked reads. */
  rankedGroupBy?: string
  aggregate?: { type: 'count' } | { type: 'sum' | 'avg'; property: string }
  /** Averages. */
  sumProperty?: string
  /** Composite pages: how many sub-queries ride the page. */
  subQueryCount?: number
  /** Composite sub-queries. */
  subQuery?: CompositeSubQueryShape
  pageAscending?: boolean
}

type AnyRecord = Record<string, unknown>

function idText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'toString' in value) return String(value)
  return String(value)
}

function asWhere(value: unknown): WhereTuple[] | undefined {
  return Array.isArray(value) ? (value as WhereTuple[]) : undefined
}

function asOrderBy(value: unknown): OrderTuple[] | undefined {
  return Array.isArray(value) ? (value as OrderTuple[]) : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

/**
 * Answers every property with a function returning a promise of an empty
 * value, and every call result is itself such a proxy, so any chain of SDK
 * calls outside `documents` resolves quietly.
 */
function quietNamespace(): unknown {
  const handler: ProxyHandler<() => unknown> = {
    get(_target, property) {
      // Not thenable: a namespace awaited by mistake must not hang.
      if (property === 'then') return undefined
      return quietNamespace()
    },
    apply() {
      return Promise.resolve(null)
    },
  }
  return new Proxy(() => undefined, handler)
}

export interface CaptureSdk {
  /** The fake, typed as the SDK the services take (it implements the document reads only). */
  sdk: EvoSDK
  requests: CapturedRequest[]
  /** Label requests sent while `run` executes with `reader`. */
  drive<T>(reader: string, run: () => Promise<T>): Promise<T | undefined>
  /** Readers whose call threw, with the error (the spec reports them). */
  failures: { reader: string; error: unknown }[]
  /** Warnings and errors the services logged, by reader: a reader that swallows a failure logs it. */
  logged: { reader: string; level: 'warn' | 'error'; message: string }[]
  /** The logger the spec installs in place of `@/lib/logger`. */
  logger: Record<'debug' | 'info' | 'warn' | 'error', (...args: unknown[]) => void>
}

export function createCaptureSdk(): CaptureSdk {
  const requests: CapturedRequest[] = []
  const failures: { reader: string; error: unknown }[] = []
  const logged: CaptureSdk['logged'] = []
  let reader = '(outside a driven reader)'
  const log = (level: 'warn' | 'error') => (...args: unknown[]) => {
    const message = args.map((arg) => (arg instanceof Error ? arg.message : typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')
    logged.push({ reader, level, message })
  }

  const record = (request: Omit<CapturedRequest, 'reader'>) => {
    requests.push({ ...request, reader })
  }

  const documentsQuery = (query: AnyRecord) => {
    record({
      surface: 'documents',
      dataContractId: idText(query.dataContractId),
      documentTypeName: String(query.documentTypeName),
      where: asWhere(query.where),
      orderBy: asOrderBy(query.orderBy),
      limit: asNumber(query.limit),
      startAt: query.startAt,
      startAfter: query.startAfter,
      timeRange: Array.isArray(query.timeRange) ? (query.timeRange as TimeRangeSelection[]) : undefined,
    })
    return Promise.resolve(new Map())
  }

  const documents = {
    query: documentsQuery,
    queryWithProof: (query: AnyRecord) => documentsQuery(query).then((data) => ({ data, proof: null, metadata: { timeMs: 0 } })),
    count(query: AnyRecord) {
      record({
        surface: 'count',
        dataContractId: idText(query.dataContractId),
        documentTypeName: String(query.documentTypeName),
        where: asWhere(query.where),
        orderBy: asOrderBy(query.orderBy),
        groupBy: Array.isArray(query.groupBy) ? query.groupBy.map(String) : undefined,
        limit: asNumber(query.limit),
        timeRange: Array.isArray(query.timeRange) ? (query.timeRange as TimeRangeSelection[]) : undefined,
      })
      return Promise.resolve(new Map())
    },
    ranked(query: AnyRecord) {
      record({
        surface: 'ranked',
        dataContractId: idText(query.dataContractId),
        documentTypeName: String(query.documentTypeName),
        where: asWhere(query.where),
        rankedGroupBy: String(query.groupBy),
        aggregate: query.aggregate as CapturedRequest['aggregate'],
        limit: asNumber(query.limit),
        timeRange: Array.isArray(query.timeRange) ? (query.timeRange as TimeRangeSelection[]) : undefined,
      })
      return Promise.resolve({ entries: [], startingRank: 0, groupBy: String(query.groupBy) })
    },
    average(query: AnyRecord, sumProperty: string) {
      record({
        surface: 'average',
        dataContractId: idText(query.dataContractId),
        documentTypeName: String(query.documentTypeName),
        where: asWhere(query.where),
        groupBy: Array.isArray(query.groupBy) ? query.groupBy.map(String) : undefined,
        sumProperty,
      })
      return Promise.resolve(new Map())
    },
    composite(query: AnyRecord) {
      const page = query
      const pageOrder = asOrderBy(page.orderBy)
      // Approximate: Drive walks the page in its path query's direction, which
      // the bound sub-queries' default ordering inherits; the last ordering
      // clause names the deepest level walked.
      const pageAscending = pageOrder?.[pageOrder.length - 1]?.[1] !== 'desc'
      const subQueries = Array.isArray(page.subQueries) ? (page.subQueries as AnyRecord[]) : []
      record({
        surface: 'compositePage',
        dataContractId: idText(page.dataContractId),
        documentTypeName: String(page.documentType),
        where: asWhere(page.where),
        orderBy: pageOrder,
        limit: asNumber(page.limit),
        startAt: page.startAt,
        startAfter: page.startAfter,
        subQueryCount: subQueries.length,
      })
      for (const sub of subQueries) {
        record({
          surface: 'compositeSub',
          dataContractId: idText(sub.dataContractId ?? page.dataContractId),
          documentTypeName: String(sub.documentType),
          subQuery: {
            kind: sub.kind === 'counts' ? 'counts' : 'documents',
            where: asWhere(sub.where),
            orderBy: asOrderBy(sub.orderBy),
            limit: asNumber(sub.limit),
            bind: sub.bind as CompositeSubQueryShape['bind'],
          },
          pageAscending,
        })
      }
      return Promise.resolve({
        pageDocuments: [],
        subResults: subQueries.map((sub) => sub.kind === 'counts'
          ? { kind: 'counts', counts: new Map() }
          : { kind: 'documents', documents: [], missingIds: [], removed: [] }),
      })
    },
    get(dataContractId: unknown, documentTypeName: unknown) {
      record({ surface: 'get', dataContractId: idText(dataContractId), documentTypeName: String(documentTypeName) })
      return Promise.resolve(null)
    },
    getWithProof(dataContractId: unknown, documentTypeName: unknown) {
      record({ surface: 'get', dataContractId: idText(dataContractId), documentTypeName: String(documentTypeName) })
      return Promise.resolve({ data: null, proof: null, metadata: { timeMs: 0 } })
    },
  }

  const sdk = new Proxy({ documents } as AnyRecord, {
    get(target, property) {
      if (property === 'then') return undefined
      if (typeof property === 'string' && property in target) return target[property]
      return quietNamespace()
    },
  })

  return {
    // The one cast of the fake: it stands in for the SDK at the
    // `evoSdkService.getSdk()` seam and answers only what the services read.
    sdk: sdk as unknown as EvoSDK,
    requests,
    failures,
    logged,
    logger: { debug: () => undefined, info: () => undefined, warn: log('warn'), error: log('error') },
    async drive(label, run) {
      const previous = reader
      reader = label
      try {
        return await run()
      } catch (error) {
        failures.push({ reader: label, error })
        return undefined
      } finally {
        reader = previous
      }
    },
  }
}
