import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CUTS = [
  ['social v19', 'yappr-social-contract-v17.json', 'yappr-social-contract-v19.json', '77cf4308d40d916ce9f128e84f584344b57e3525c30d4d20509bf3a4485196bf', ['post', 'reply', 'yapprProfile']],
  ['blog v11', 'yappr-blog-contract.json', 'yappr-blog-contract-v11.json', '448fb9ea4a9b6b4f4c0e0224dfe5ba610514d18793b6927255f3a7c67631504c', ['blog', 'blogPost', 'blogComment']],
  ['storefront v12', 'yappr-storefront-contract.json', 'yappr-storefront-contract-v12.json', '69daf9799cb4f34552e4fce3ec7963a66f6f492f37d45baee4f6c83880bf05dc', ['store', 'storeItem', 'storeReview', 'itemReview']],
];
const read = (file) => readFileSync(new URL(`../contracts/${file}`, import.meta.url));

describe('recoverable removal contract cuts', () => {
  it.each(CUTS)('%s changes only the required and kept system values', (name, historical, current, sha256, types) => {
    const bytes = read(historical);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
    const original = JSON.parse(bytes);
    const expected = structuredClone(original);
    const changed = [];
    for (const [type, schema] of Object.entries(expected.documentSchemas)) {
      if (!schema.moderatorAbilities?.delete || schema.moderatorAbilities.deleteKeepsRecord === false) continue;
      changed.push(type);
      const system = schema.documentsMutable === false
        ? ['$createdAt', '$createdAtBlockHeight']
        : ['$createdAt', '$updatedAt', '$updatedAtBlockHeight'];
      schema.required = [...system, ...schema.required.filter((field) => !system.includes(field))];
      schema.moderatorAbilities.deleteKeepsFields = [...new Set([...(schema.moderatorAbilities.deleteKeepsFields ?? []), ...system])];
    }
    expect(changed).toEqual(types);
    const cut = JSON.parse(read(current));
    expect(cut).toEqual(expected);
    expect(cut.documentSchemas.report).toEqual(original.documentSchemas.report);
  });
});
