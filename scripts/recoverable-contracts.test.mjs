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

  it('social v20 is social v19 with replyToReplyId kept in the reply removal record', () => {
    const v19 = read('yappr-social-contract-v19.json');
    // The file registered on testnet on 2026-11-12 stays byte-identical.
    expect(createHash('sha256').update(v19).digest('hex')).toBe('bae9bd60f16b917f39309a8ca2dcc495687ec35174fa9caa08a8b0311e318971');
    const expected = JSON.parse(v19);
    const kept = expected.documentSchemas.reply.moderatorAbilities.deleteKeepsFields;
    expect(kept).toEqual(['rootPostId', '$createdAt', '$updatedAt', '$updatedAtBlockHeight']);
    kept.splice(1, 0, 'replyToReplyId');
    const v20 = JSON.parse(read('yappr-social-contract-v20.json'));
    expect(v20).toEqual(expected);
    // An optional, immutable identifier of the reply itself: a direct reply's record leaves it out.
    const reply = v20.documentSchemas.reply;
    expect(reply.properties.replyToReplyId.type).toBe('identifier');
    expect(reply.required).not.toContain('replyToReplyId');
    expect(reply.immutable).toContain('replyToReplyId');
  });
});
