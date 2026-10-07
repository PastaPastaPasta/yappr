import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { dpnsRecordOwner } from './dpns-record-owner';

const victim = '2'.repeat(32);
const attacker = '3'.repeat(32);

describe('dpnsRecordOwner', () => {
  it('returns the identity a name points at when that identity registered it', () => {
    expect(dpnsRecordOwner({ $ownerId: victim, records: { identity: victim }, label: 'alice' })).toBe(victim);
  });

  it('ignores a forged name whose record points at another identity', () => {
    expect(dpnsRecordOwner({ $ownerId: attacker, records: { identity: victim }, label: 'aaa' })).toBeNull();
  });

  it('ignores a document without an owner or without a record', () => {
    expect(dpnsRecordOwner({ records: { identity: victim }, label: 'alice' })).toBeNull();
    expect(dpnsRecordOwner({ $ownerId: victim, label: 'alice' })).toBeNull();
    expect(dpnsRecordOwner({ $ownerId: victim, records: {}, label: 'alice' })).toBeNull();
  });

  it('compares identifiers across encodings', () => {
    const bytes = bs58.decode(victim);
    expect(dpnsRecordOwner({ $ownerId: victim, records: { identity: bytes } })).toBe(victim);
    expect(dpnsRecordOwner({ $ownerId: attacker, records: { identity: bytes } })).toBeNull();
  });

  it('reads the legacy record fields and the wrapped document shape', () => {
    expect(dpnsRecordOwner({ $ownerId: victim, records: { dashUniqueIdentityId: victim } })).toBe(victim);
    expect(dpnsRecordOwner({ $ownerId: victim, records: { dashAliasIdentityId: victim } })).toBe(victim);
    expect(dpnsRecordOwner({ ownerId: victim, data: { records: { identity: victim } } })).toBe(victim);
    expect(dpnsRecordOwner({ ownerId: attacker, data: { records: { identity: victim } } })).toBeNull();
  });
});
