import { appendLog, getLogs } from './logs';
import { redact } from './redact';

/** Known secrets of each shape ENGINE.md §11.2 lists; none may reach the ring buffer. */
const SECRETS = {
  testnetWif: 'cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy',
  mainnetWif: 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn',
  hexKey: 'e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35',
  base64Key: 'q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA=',
  dashKey: 'dash-key:v1?pk=02a1b2c3&app=yappr&nonce=9f8e',
  dashSt: 'dash-st:AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA',
  prefixedHex: '0xe8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35',
  namedHex: 'key_e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35',
  base64url: 'q83vEjRWeJCrze8SNFZ4kKvN7xI0Vn-Qq83vEjRW_JA',
  bytes: JSON.stringify(Object.fromEntries(Array.from({ length: 32 }, (_, i) => [String(i), (i * 37) % 256]))),
};

describe('engine log redaction', () => {
  it.each(Object.entries(SECRETS))('redacts a %s', (_kind, secret) => {
    const line = redact(`signing with ${secret} now`);
    expect(line).not.toContain(secret);
    expect(line.startsWith('signing with ')).toBe(true);
  });

  it('keeps identity ids, document ids and ordinary text', () => {
    const line = 'identity 5DbLwAxGBzUzo81VewMUwn4b5P4bpv9FNFybi25XB5Bk posted 47 posts in 1234 ms';
    expect(redact(line)).toBe(line);
  });

  it('redacts a key that straddles the line limit before truncating', () => {
    appendLog('error', 'engine', `${'.'.repeat(1990)}${SECRETS.hexKey}`);
    expect(getLogs().at(-1)?.message).not.toContain(SECRETS.hexKey.slice(0, 10));
  });

  it('redacts lines on their way into the ring buffer', () => {
    for (const secret of Object.values(SECRETS)) appendLog('error', 'engine', `failed: ${JSON.stringify({ secret })}`);
    const text = getLogs()
      .map((entry) => entry.message)
      .join('\n');
    for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
  });
});
