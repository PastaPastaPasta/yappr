import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import { removalFieldsMatch } from './battery-moderation.mjs';
import { expandSchemas } from './schema-shorthands.mjs';
import { fixtureHeights } from './social-shapes.mjs';

const CUTS = [
  ['blog', 'yappr-blog-contract.json'],
  ['blog', 'yappr-blog-contract-v11.json'],
  ['storefront', 'yappr-storefront-contract.json'],
  ['storefront', 'yappr-storefront-contract-v12.json'],
];

describe('feature batteries', () => {
  it.each(CUTS)('%s accepts --contract-file %s offline', (family, file) => {
    const result = spawnSync(process.execPath, [`scripts/verify-${family}.mjs`, '--contract-file', `contracts/${file}`, '--self-test'], { encoding: 'utf8', timeout: 10000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  for (const [, file] of CUTS.filter(([, file]) => /v11|v12/.test(file))) {
    const schemas = expandSchemas(JSON.parse(readFileSync(new URL(`../contracts/${file}`, import.meta.url))).documentSchemas);
    for (const [type, schema] of Object.entries(schemas)) {
      if (!schema.moderatorAbilities?.delete || schema.moderatorAbilities.deleteKeepsRecord === false) continue;
      it(`${file} ${type} compares exactly the document's kept values`, () => {
        const fields = schema.moderatorAbilities.deleteKeepsFields;
        const source = Object.fromEntries(fields.map((field) => [field, field.startsWith('$') ? 9007199254740993n : new Uint8Array(32).fill(1)]));
        const document = { toObject: () => ({ ...source, content: 'not kept' }) };
        const kept = Object.fromEntries(Object.entries(source).map(([field, value]) => [field, field.startsWith('$') ? String(value) : bs58.encode(value)]));
        expect(removalFieldsMatch(schema, document, kept)).toBe(true);
        expect(removalFieldsMatch(schema, document, { ...kept, content: 'extra' })).toBe(false);
        for (const field of fields) {
          const missing = { ...kept };
          delete missing[field];
          if (schema.required.includes(field)) expect(removalFieldsMatch(schema, missing, missing)).toBe(false);
          expect(removalFieldsMatch(schema, document, missing)).toBe(false);
          expect(removalFieldsMatch(schema, document, { ...kept, [field]: field.startsWith('$') ? 9007199254740992n : new Uint8Array(32).fill(2) })).toBe(false);
        }
      });
    }
  }

  it('limits additive updates to the deployment cut before connecting', () => {
    for (const [entry, topology, selected, expected] of [
      ['social', 'CONTRACT', 'v16', 'v19'], ['blog', 'BLOG', 'v8', 'v11'], ['storefront', 'STOREFRONT', 'v9', 'v12'],
    ]) {
      const result = spawnSync(process.execPath, ['scripts/update-contract-additive.mjs', '--entry', entry], {
        env: { ...process.env, NETWORK: 'devnet', [`NEXT_PUBLIC_${topology}_TOPOLOGY`]: selected }, encoding: 'utf8', timeout: 10000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`only updates its own ${expected} cut`);
      expect(result.stderr).toContain(`NEXT_PUBLIC_${topology}_TOPOLOGY=${selected}`);
    }
  });

  it('adds only the fixture heights required by the document type', () => {
    expect(fixtureHeights({ required: ['$createdAt'] })).toEqual({});
    expect(fixtureHeights({ required: ['$createdAtBlockHeight'] })).toEqual({ $createdAtBlockHeight: 1n });
    expect(fixtureHeights({ required: ['$updatedAtBlockHeight'] })).toEqual({ $updatedAtBlockHeight: 1n });
    expect(fixtureHeights({ required: ['$createdAtBlockHeight', '$updatedAtBlockHeight'] })).toEqual({ $createdAtBlockHeight: 1n, $updatedAtBlockHeight: 1n });
  });
});
