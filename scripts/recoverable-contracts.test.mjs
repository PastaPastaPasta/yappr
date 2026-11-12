import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HISTORICAL_RELEASE_CUTS } from './app-connect-set.mjs';

const CUTS = [
  ['social v19', HISTORICAL_RELEASE_CUTS.social, 'yappr-social-contract-v19.json', ['post', 'reply', 'yapprProfile']],
  ['blog v11', HISTORICAL_RELEASE_CUTS.blog, 'yappr-blog-contract-v11.json', ['blog', 'blogPost', 'blogComment']],
  ['storefront v12', HISTORICAL_RELEASE_CUTS.storefront, 'yappr-storefront-contract-v12.json', ['store', 'storeItem', 'storeReview', 'itemReview']],
];
const read = (file) => readFileSync(new URL(`../contracts/${file}`, import.meta.url));

describe('recoverable removal contract cuts', () => {
  it.each(CUTS)('%s changes only the required and kept system values', (name, historical, current, types) => {
    const bytes = read(historical.file);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(historical.sha256);
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
