import bs58 from 'bs58'
import { IdentityPublicKey, PrivateKey, ensureInitialized } from '@dashevo/evo-sdk'
import { describe, expect, it, vi } from 'vitest'
import { createBattery, contractFileSha256, contractTarget, recordedTestContract, testContractNetworkKey, withTestContract } from '../scripts/battery-lib.mjs'
import { createDocWriter, ensureTokens } from '../scripts/seed/feature-seed-lib.mjs'
import { parseArgs } from '../scripts/clean-test-content.mjs'
import { blogPostTombstone, cleanBlog, cleanPollr, cleanStorefront, contentOf, createdSince, withStatus } from '../scripts/surface-cleanup.mjs'

// The pure half of the feature-surface cleanup (scripts/surface-cleanup.mjs) and of the batteries'
// test contracts (scripts/battery-lib.mjs). The chain half runs in the blog, storefront and pollr
// batteries' end-of-run cleanup and in clean-test-content.mjs --surface.

const id = (fill: number) => new Uint8Array(32).fill(fill)
const b58 = (fill: number) => bs58.encode(id(fill))

describe('what a surface cleanup writes', () => {
  it('drops the system fields and the absent ones from a stored document, and writes its integers as numbers', () => {
    expect(contentOf({ $id: id(1), $ownerId: id(2), $revision: 3n, $createdAt: undefined, title: 't', basePrice: 1000n, sku: undefined, variants: { prices: [100n, 353n], selectors: [Uint8Array.of(1, 2)] } }))
      .toEqual({ title: 't', basePrice: 1000, variants: { prices: [100, 353], selectors: [Uint8Array.of(1, 2)] } })
  })

  it('keeps an integer past 2^53 a BigInt rather than rounding it', () => {
    expect(contentOf({ big: 2n ** 60n })).toEqual({ big: 2n ** 60n })
  })

  it('tombstones a published blog post: deleted, comments off, blogId as bytes, slug and publishedAt kept', () => {
    const stored = { $id: id(1), $revision: 2n, blogId: id(4), slug: 'first-x', publishedAt: 1700000000000n, title: 'First', data0: id(9), labels: ['a'], commentsEnabled: true }
    expect(blogPostTombstone(stored)).toEqual({ deleted: true, commentsEnabled: false, blogId: id(4), slug: 'first-x', publishedAt: 1700000000000 })
  })

  it('tombstones a draft without inventing a publishedAt, whether blogId reads as base58 or bytes', () => {
    expect(blogPostTombstone({ blogId: b58(4), slug: 'draft-x', title: 'Draft' })).toEqual({ deleted: true, commentsEnabled: false, blogId: id(4), slug: 'draft-x' })
  })

  it('deletes an item and closes a store by resending every field with the new status', () => {
    const item = { $id: id(1), $revision: 1n, storeId: id(5), title: 'Widget', status: 'active', basePrice: 1000n, currency: 'USD', variants: { selectors: [Uint8Array.of(1, 2)] } }
    expect(withStatus(item, 'deleted')).toEqual({ storeId: id(5), title: 'Widget', status: 'deleted', basePrice: 1000, currency: 'USD', variants: { selectors: [Uint8Array.of(1, 2)] } })
    expect(withStatus({ $id: id(2), name: 'Ann Store', status: 'active', category: 'battery-goods' }, 'closed')).toEqual({ name: 'Ann Store', status: 'closed', category: 'battery-goods' })
  })
})

describe('which documents a surface cleanup touches', () => {
  const owners = new Set([b58(7)])

  it('takes the owners\' documents created at or after since, owners read as bytes or base58', () => {
    const rows = [
      { $id: id(1), $ownerId: id(7), $createdAt: 2000n },
      { $id: id(2), $ownerId: b58(7), $createdAt: 3000 },
      { $id: id(3), $ownerId: id(7), $createdAt: 1999n },
      { $id: id(4), $ownerId: id(8), $createdAt: 5000n },
    ]
    expect(createdSince(rows, { owners, since: 2000 }).map((row: { $id: unknown }) => row.$id)).toEqual([id(1), id(2)])
  })

  it('never takes a document with no readable creation time', () => {
    expect(createdSince([{ $id: id(1), $ownerId: id(7) }], { owners, since: 0 })).toEqual([])
  })
})

/**
 * A read-only stand-in for a battery bound to one contract: `queryDocs` answers `==` and `>=`
 * clauses off canned rows (a derived property such as `blogPostId.$ownerId` is a plain field
 * here), `countBy` counts them. A plan never writes, so nothing else is needed.
 */
function fakeBattery(rows: Record<string, Array<Record<string, unknown>>>, { release = false } = {}) {
  const value = (v: unknown) => (v instanceof Uint8Array ? bs58.encode(v) : v)
  const matches = (row: Record<string, unknown>, where: Array<[string, string, unknown]>) => where.every(([field, op, operand]) =>
    op === '==' ? value(row[field]) === operand
      : typeof operand === 'string'
        ? Buffer.compare(bs58.decode(String(value(row[field]))), bs58.decode(operand)) >= 0
        : Number(row[field]) >= Number(operand))
  const queryDocs = async (docType: string, { where }: { where: Array<[string, string, unknown]> }) => (rows[docType] ?? []).filter((row) => matches(row, where))
  const schemas = { blogPost: { properties: release ? { live: { const: true } } : {} }, poll: { indices: release ? [] : [{ properties: [{ $ownerId: 'asc' }] }] } };
  return {
    readback: async <T>(fn: () => Promise<T>) => fn(),
    sdk: { contracts: { fetch: async () => ({ toJSON: () => ({ documentSchemas: schemas }) }) } },
    fetchDocument: async (docType: string, docId: string) => {
      const row = (rows[docType] ?? []).find((entry) => value(entry.$id) === docId);
      return row ? { toObject: () => row } : null;
    },
    queryDocs, countBy: async (docType: string, where: Array<[string, string, unknown]>) => (await queryDocs(docType, { where })).length }
}

describe('what a surface cleanup plans', () => {
  const persona = { ownerId: b58(7), label: 'persona200' }
  const since = 5000

  it('storefront: closes a store the run created, gives a reopened one its status back, and counts only the run\'s orders', async () => {
    const battery = fakeBattery({
      store: [
        { $id: id(1), $ownerId: id(7), $createdAt: 6000n, status: 'active', name: 'Ann Store' },
        { $id: id(2), $ownerId: id(7), $createdAt: 10n, status: 'active', name: 'Old Store' },
      ],
      storeItem: [
        { $id: id(3), $ownerId: id(7), $createdAt: 6000n, storeId: id(1), status: 'active' },
        { $id: id(4), $ownerId: id(7), $createdAt: 6000n, storeId: id(1), status: 'deleted' },
      ],
      storeOrder: [
        { $id: id(5), $ownerId: id(7), $createdAt: 6000n, storeId: id(1) },
        { $id: id(6), $ownerId: id(9), $createdAt: 6000n, storeId: id(2) },
      ],
    })
    const report = await cleanStorefront({ battery, owners: [persona], since, reopened: new Map([[b58(2), 'paused']]), live: false })
    expect(report.done).toEqual({ "storeItem (status 'deleted')": 1, "store (status 'closed')": 1, "store (status 'paused')": 1 })
    expect(report.leftovers).toEqual([expect.objectContaining({ type: 'storeOrder', count: 1 })])
  })

  it('pollr: plans to delete a poll without ballots and leaves one with a withdrawn ballot', async () => {
    const battery = fakeBattery({
      poll: [
        { $id: id(1), $ownerId: id(7), $createdAt: 6000n, question: 'Untouched x?' },
        { $id: id(2), $ownerId: id(7), $createdAt: 6000n, question: 'Withdrawn x?' },
        { $id: id(3), $ownerId: id(7), $createdAt: 10n, question: 'Seeded?' },
      ],
      vote: [{ $id: id(4), $ownerId: id(8), $createdAt: 6000n, pollId: id(2) }],
    })
    const report = await cleanPollr({ battery, contractId: b58(9), owners: [persona], since, live: false })
    expect(report.found).toEqual({ poll: 2 })
    expect(report.done).toEqual({ poll: 1 })
    expect(report.leftovers).toEqual([expect.objectContaining({ type: 'poll', id: b58(2), name: 'Withdrawn x?' })])
  })

  it('pollr v8 cleans explicitly named polls by id without any poll query, scoped by owner and time', async () => {
    const battery = fakeBattery({ poll: [
      { $id: id(1), $ownerId: id(7), $createdAt: 6000n },
      { $id: id(2), $ownerId: id(8), $createdAt: 6000n },
      { $id: id(3), $ownerId: id(7), $createdAt: 10n },
    ] }, { release: true });
    const query = battery.queryDocs;
    battery.queryDocs = async (type, q) => { if (type === 'poll') throw new Error('no poll index'); return query(type, q); };
    const report = await cleanPollr({ battery, contractId: b58(9), owners: [persona], since, live: false, pollIds: [b58(1), b58(2), b58(3), b58(4)] });
    expect(report.found).toEqual({ poll: 1 });
    expect(report.done).toEqual({ poll: 1 });
    const missing = await cleanPollr({ battery, contractId: b58(9), owners: [persona], since, live: false });
    expect(missing.failed).toEqual([expect.objectContaining({ label: 'poll discovery', error: expect.stringContaining('--poll-ids') })]);
  });

  it('blog cleanup finds owned comments when the other author has only tombstoned posts', async () => {
    const battery = fakeBattery({
      blog: [{ $id: id(1), $ownerId: id(8), $createdAt: 1000n }],
      blogPost: [{ $id: id(2), $ownerId: id(8), $createdAt: 2000n, blogId: id(1), deleted: true }],
      blogComment: [{ $id: id(3), $ownerId: id(7), $createdAt: 6000n, 'blogPostId.$ownerId': b58(8) }],
    }, { release: true });
    const report = await cleanBlog({ battery, contractId: b58(9), owners: [persona], since, live: false });
    expect(report.done.blogComment).toBe(1);
  });

  it('blog cleanup finds comments on tombstones even after the target blog is removed', async () => {
    const battery = fakeBattery({
      blogPost: [{ $id: id(2), $ownerId: id(8), $createdAt: 2000n, blogId: id(1), deleted: true }],
      blogComment: [
        { $id: id(3), $ownerId: id(7), $createdAt: 6000n, 'blogPostId.$ownerId': b58(8) },
        { $id: id(4), $ownerId: id(9), $createdAt: 6000n, 'blogPostId.$ownerId': b58(8) },
        { $id: id(5), $ownerId: id(7), $createdAt: 1000n, 'blogPostId.$ownerId': b58(8) },
      ],
    }, { release: true });
    const report = await cleanBlog({ battery, contractId: b58(9), owners: [persona], since, live: false });
    expect(report.found.blogComment).toBe(1);
    expect(report.done.blogComment).toBe(1);
    expect(report.failed).toEqual([]);
  });

  it('blog v9 pins live on both listings and preserves publishedAt on tombstones', async () => {
    const battery = fakeBattery({
      blog: [{ $id: id(1), $ownerId: id(7), $createdAt: 6000n }],
      blogPost: [{ $id: id(2), $ownerId: id(7), $createdAt: 6000n, blogId: id(1), slug: 'a', publishedAt: 5500, live: true }],
    }, { release: true });
    const query = battery.queryDocs;
    let listings = 0;
    battery.queryDocs = async (type, q) => {
      if (type === 'blogPost') { expect(q.where[0]).toEqual(['live', '==', true]); listings += 1; }
      return query(type, q);
    };
    const report = await cleanBlog({ battery, contractId: b58(9), owners: [persona], since, live: false });
    expect(report.done['blogPost (tombstone)']).toBe(1);
    expect(listings).toBe(1);
  });

  it('blog: tombstones live posts only, and leaves the run\'s blog up without a moderator', async () => {
    const rows = {
      blog: [{ $id: id(1), $ownerId: id(7), $createdAt: 6000n, name: 'Battery x' }],
      blogPost: [
        { $id: id(2), $ownerId: id(7), $createdAt: 6000n, blogId: id(1), slug: 'a' },
        { $id: id(3), $ownerId: id(7), $createdAt: 6000n, blogId: id(1), slug: 'b', deleted: true },
      ],
      blogComment: [{ $id: id(4), $ownerId: id(7), $createdAt: 6000n, 'blogPostId.$ownerId': id(7) }],
      blogFollow: [{ $id: id(5), $ownerId: id(7), $createdAt: 10n, blogId: id(1) }],
    }
    const report = await cleanBlog({ battery: fakeBattery(rows), contractId: b58(9), owners: [persona], since, live: false })
    expect(report.done).toEqual({ blogComment: 1, 'blogPost (tombstone)': 1 })
    expect(report.leftovers).toEqual([expect.objectContaining({ type: 'blog', id: b58(1) })])
    const moderated = await cleanBlog({ battery: fakeBattery(rows), contractId: b58(9), owners: [persona], since, moderator: { label: 'maker' }, live: false })
    expect(moderated.done['blog (removed by maker)']).toBe(1)
    expect(moderated.leftovers).toEqual([])
  })
})

describe('the battery test contracts', () => {
  const sha256 = 'a'.repeat(64)
  const entry = { contractId: b58(1), sha256, file: 'pollr-contract.json' }

  it('keys a devnet by its name, other networks by theirs', () => {
    expect(testContractNetworkKey('devnet', 'sakura')).toBe('devnet:sakura')
    expect(testContractNetworkKey('testnet', null)).toBe('testnet')
  })

  it('reuses a contract registered from the same file, and asks for a new one when the file changed or none exists', () => {
    const registry = { 'devnet:sakura': { pollr: entry } }
    expect(recordedTestContract(registry, { networkKey: 'devnet:sakura', name: 'pollr', sha256 })).toEqual({ state: 'current', entry })
    expect(recordedTestContract(registry, { networkKey: 'devnet:sakura', name: 'pollr', sha256: 'b'.repeat(64) }).state).toBe('stale')
    expect(recordedTestContract(registry, { networkKey: 'devnet:other', name: 'pollr', sha256 }).state).toBe('missing')
    expect(recordedTestContract({}, { networkKey: 'devnet:sakura', name: 'pollr', sha256 }).state).toBe('missing')
  })

  it('records a new contract without touching the other networks or names', () => {
    const registry = { testnet: { pollr: entry }, 'devnet:sakura': { blog: entry } }
    const fresh = { ...entry, contractId: b58(2) }
    expect(withTestContract(registry, { networkKey: 'devnet:sakura', name: 'pollr', entry: fresh }))
      .toEqual({ testnet: { pollr: entry }, 'devnet:sakura': { blog: entry, pollr: fresh } })
  })

  it('hashes a contract file as its bytes', () => {
    expect(contractFileSha256('pollr-contract.json')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('runs on the test contract unless --live-contract names the published one', () => {
    const base = { liveContract: false, registerTestContract: false, contract: null, fromEnv: 'E', deployed: 'D', envName: 'POLLR_CONTRACT_ID' }
    expect(contractTarget(base)).toEqual({ live: false })
    expect(contractTarget({ ...base, registerTestContract: true })).toEqual({ live: false })
    expect(contractTarget({ ...base, liveContract: true })).toEqual({ live: true, contractId: 'E' })
    expect(contractTarget({ ...base, liveContract: true, contract: 'C' })).toEqual({ live: true, contractId: 'C' })
    expect(contractTarget({ ...base, liveContract: true, fromEnv: null })).toEqual({ live: true, contractId: 'D' })
  })

  it('refuses a stray --contract, registering with --live-contract, and a live run with no contract', () => {
    const base = { liveContract: false, registerTestContract: false, contract: null, fromEnv: null, deployed: null, envName: 'POLLR_CONTRACT_ID' }
    expect(() => contractTarget({ ...base, contract: 'C' })).toThrow(/--live-contract/)
    expect(() => contractTarget({ ...base, liveContract: true, registerTestContract: true, deployed: 'D' })).toThrow(/--register-test-contract/)
    expect(() => contractTarget({ ...base, liveContract: true })).toThrow(/POLLR_CONTRACT_ID/)
  })
})

describe('the cleanup CLI on the feature surfaces', () => {
  const since = '2026-10-13T15:42:00Z'

  it('reads surfaces, personas (optionally naming the identity) and the moderator', () => {
    const args = parseArgs(['--plan', '--surface', 'blog,pollr', '--personas', '210,230:abc', '--since', since, '--moderator', 'maker'])
    expect(args.surfaces).toEqual(['blog', 'pollr'])
    expect(args.personas).toEqual([{ index: 210, id: null }, { index: 230, id: 'abc' }])
    expect(args.moderator).toBe('maker')
  })

  it('keeps social the default surface, and takes it beside the others', () => {
    expect(parseArgs(['--plan', '--bots', '0']).surfaces).toEqual(['social'])
    expect(parseArgs(['--plan', '--surface', 'social,storefront', '--bots', '0', '--personas', '200', '--since', since]).surfaces).toEqual(['social', 'storefront'])
  })

  it('needs personas and since for a feature surface', () => {
    expect(() => parseArgs(['--live', '--surface', 'blog', '--since', since])).toThrow(/--personas/)
    expect(() => parseArgs(['--live', '--surface', 'blog', '--personas', '210'])).toThrow(/--since/)
  })

  it('refuses flags that do not apply to the surfaces named', () => {
    expect(() => parseArgs(['--plan', '--surface', 'wiki', '--personas', '1', '--since', since])).toThrow(/one of social/)
    expect(() => parseArgs(['--plan', '--surface', 'pollr', '--bots', '0', '--personas', '1', '--since', since])).toThrow(/add social/)
    expect(() => parseArgs(['--plan', '--surface', 'pollr', '--personas', '1', '--since', since, '--moderator', 'maker'])).toThrow(/add blog/)
    expect(() => parseArgs(['--plan', '--bots', '0', '--personas', '1'])).toThrow(/apply to --surface/)
    expect(() => parseArgs(['--plan', '--surface', 'blog', '--personas', '1', '--since', since, '--contract', 'abc'])).toThrow(/social contract/)
  })
})


describe('battery rejection verdicts', () => {
  it.each([
    'grpc error: Some resource has been exhausted: rate limited',
    '504 Gateway Timeout',
    'deadline exceeded',
    'request timed out',
    'quorum not found',
    'invalid quorum',
    'no available addresses',
    'Failed to wait for state transition result',
  ])('does not count transport failure as a broad schema refusal: %s', (error) => {
    const battery = createBattery({ handle: { sdk: {} }, contractId: b58(9), socialId: b58(9) });
    battery.expectRejected('invalid schema', { ok: false, error }, /[\s\S]+/);
    expect(battery.failures).toBe(1);
  });

  it('still accepts an actual schema refusal', () => {
    const battery = createBattery({ handle: { sdk: {} }, contractId: b58(9), socialId: b58(9) });
    battery.expectRejected('invalid schema', { ok: false, error: 'JsonSchemaError: minItems' }, /[\s\S]+/);
    expect(battery.failures).toBe(0);
  });

  it('accepts an explicit consensus refusal inside a confirmation-wait wrapper', () => {
    const battery = createBattery({ handle: { sdk: {} }, contractId: b58(9), socialId: b58(9) });
    battery.expectRejected('invalid reference', { ok: false, error: 'Failed to wait for state transition result: state transition broadcast error: referenced identity not found | code=40120' }, /40120/);
    expect(battery.failures).toBe(0);
  });
});

describe('unpriced no-index seeder recovery', () => {
  it('keeps the facade path for signer-only DM actors', async () => {
    await ensureInitialized();
    const facade = vi.fn(async () => ({ id: b58(4) }));
    const actor = { ownerId: b58(7), identityKey: {}, signer: {}, lock: <T>(operation: () => Promise<T>) => operation() };
    const writer = createDocWriter({
      handle: { sdk: { documents: {
        create: facade, get: async () => ({}), query: async () => new Map(),
      } }, reconnect: async () => {} },
      contractId: b58(9), entropyFor: () => id(3), paymentInfo: () => ({}), wait: async () => {},
    });
    const created = await writer.createDoc(actor, 'dmInvite', 'signer-only-invite', { bucket: 1 });
    expect(created.id).toBe(b58(4));
    expect(facade).toHaveBeenCalledTimes(1);
  });

  it('cleans a no-index poll that becomes visible only after every acceptance read failed', async () => {
    await ensureInitialized();
    const key = PrivateKey.fromHex('01'.repeat(32), 'testnet');
    const actor = {
      ownerId: b58(7), wif: key.toWIF(), signer: {}, label: 'delayed-poll-owner',
      identityKey: new IdentityPublicKey({ keyId: 1, purpose: 'authentication', securityLevel: 'high', keyType: 'ecdsa_secp256k1', data: key.getPublicKey().toBytes() }),
    };
    const since = Date.now();
    let visible = false;
    const broadcast = vi.fn(async () => { throw new Error('504 Gateway Timeout'); });
    const remove = vi.fn(async () => { visible = false; });
    const get = vi.fn(async (_contract: string, _type: string, docId: string) => visible ? {
      toObject: () => ({ $id: docId, $ownerId: actor.ownerId, $createdAt: since, question: 'Delayed poll?' }),
    } : null);
    const battery = createBattery({ handle: { sdk: {
      wasm: { getIdentityContractNonce: async () => 0n },
      stateTransitions: { broadcastAndWait: broadcast },
      contracts: { fetch: async () => ({ toJSON: () => ({ documentSchemas: { poll: { indices: [] } } }) }) },
      documents: { get, query: async () => { throw new Error('where clause on non indexed property'); }, count: async () => ({ '': 0 }), delete: remove },
    } }, contractId: b58(9), socialId: b58(9) });
    vi.useFakeTimers();
    try {
      const pending = battery.attemptCreate(actor, 'poll', { question: 'Delayed poll?' });
      await vi.runAllTimersAsync();
      const outcome = await pending;
      expect(outcome.ok).toBe(false);
      expect(get).toHaveBeenCalledTimes(3);
      expect(battery.createdDocuments.get('poll')).toEqual(new Set([outcome.id]));
      expect(broadcast).toHaveBeenCalledTimes(1);
      visible = true;
      const cleanup = cleanPollr({ battery, contractId: b58(9), owners: [actor], since, live: true });
      await vi.runAllTimersAsync();
      const report = await cleanup;
      expect(report.found.poll).toBe(1);
      expect(report.done.poll).toBe(1);
      expect(report.failed).toEqual([]);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(visible).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidates a primed facade nonce cache after recovering a manual create with lost confirmation', async () => {
    await ensureInitialized();
    const key = PrivateKey.fromHex('01'.repeat(32), 'testnet');
    const actor = {
      ownerId: b58(7), wif: key.toWIF(), signer: {},
      identityKey: new IdentityPublicKey({ keyId: 1, purpose: 'authentication', securityLevel: 'high', keyType: 'ecdsa_secp256k1', data: key.getPublicKey().toBytes() }),
      lock: <T>(operation: () => Promise<T>) => operation(),
    };
    let chainNonce = 0n;
    let cachedNonce: bigint | null = null;
    let landed = false;
    const replace = vi.fn(async () => {
      const next = (cachedNonce ?? chainNonce) + 1n;
      if (next !== chainNonce + 1n) throw new Error('nonce already present at tip');
      cachedNonce = next;
      chainNonce = next;
    });
    await replace(); // Prime the facade cache before switching to a manual create.
    const refresh = vi.fn(async () => { cachedNonce = null; });
    const broadcast = vi.fn(async () => {
      chainNonce += 1n;
      landed = true;
      throw new Error('504 Gateway Timeout');
    });
    const writer = createDocWriter({
      handle: { sdk: {
        wasm: { getIdentityContractNonce: async () => chainNonce, refreshIdentityNonce: refresh },
        stateTransitions: { broadcastAndWait: broadcast },
        documents: { replace, get: async () => landed ? {} : null, query: async () => { throw new Error('where clause on non indexed property'); } },
      }, reconnect: async () => {} },
      contractId: b58(9), entropyFor: () => id(3), paymentInfo: () => ({}), wait: async () => {},
    });
    const created = await writer.createDoc(actor, 'poll', 'lost-confirmation', { question: 'Question?' });
    expect(created.id).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(1);
    await expect(replace()).resolves.toBeUndefined();
    expect(chainNonce).toBe(3n);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('retains the ID before a landed poll create loses its confirmation, without creating another poll', async () => {
    await ensureInitialized();
    const key = PrivateKey.fromHex('01'.repeat(32), 'testnet');
    const actor = {
      ownerId: b58(7), wif: key.toWIF(),
      identityKey: new IdentityPublicKey({ keyId: 1, purpose: 'authentication', securityLevel: 'high', keyType: 'ecdsa_secp256k1', data: key.getPublicKey().toBytes() }),
      lock: <T>(operation: () => Promise<T>) => operation(),
    };
    let landed = false;
    const broadcast = vi.fn(async () => { landed = true; throw new Error('504 Gateway Timeout'); });
    const facade = vi.fn(async () => { throw new Error('504 Gateway Timeout'); });
    const get = vi.fn(async () => landed ? {} : null);
    const writer = createDocWriter({
      handle: { sdk: {
        wasm: { getIdentityContractNonce: async () => 0n, refreshIdentityNonce: async () => {} },
        stateTransitions: { broadcastAndWait: broadcast },
        documents: { create: facade, get, query: async () => { throw new Error('where clause on non indexed property'); } },
      }, reconnect: async () => {} },
      contractId: b58(9), entropyFor: () => id(3), paymentInfo: () => ({}), wait: async () => {},
    });
    const created = await writer.createDoc(actor, 'poll', 'unpriced-poll', { question: 'Question?' });
    expect(created.id).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(facade).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledWith(b58(9), 'poll', created.id);
  });
});

describe('claim-only battery funding', () => {
  it('uses the actor claim despite a stale ledger marker and falls back to credits without trying an owner mint', async () => {
    await ensureInitialized();
    let balance = 0n;
    const claim = vi.fn(async () => { balance = 100n; });
    const mint = vi.fn();
    const sdk = {
      tokens: { balances: async () => new Map([[b58(7), balance]]), claim, mint },
      contracts: { fetch: async () => ({ toJSON: () => ({ tokens: { '0': { manualMintingRules: { authorizedToMakeChange: { $type: 'noOne' } } } } }) }) },
    };
    const battery = createBattery({ handle: { sdk }, contractId: b58(9), socialId: b58(9) });
    const actor = { ownerId: b58(7), label: 'actor', identityKey: {}, signer: {}, starterClaimed: true, paysCredits: false };
    await ensureTokens(battery, b58(8), new Map([[7, actor]]), new Map([[7, 200n]]));
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ identityId: actor.ownerId, distributionType: 'oncePerIdentity' }));
    expect(mint).not.toHaveBeenCalled();
    expect(actor.paysCredits).toBe(true);
  });
});
