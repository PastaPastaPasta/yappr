/**
 * Redaction for engine log lines before they reach the ring buffer or the
 * Metro console (ENGINE.md §11.2). The engine forwards its console verbatim,
 * so the host is the last line of defence: nothing that looks like key
 * material survives.
 */

const BASE58 = '1-9A-HJ-NP-Za-km-z';

const RULES: [RegExp, (match: string, ...groups: string[]) => string][] = [
  // dash-key: / dash-st: URIs carry ephemeral keys and unsigned transitions.
  [/\b(dash-(?:key|st)):[^\s"'<>]+/gi, (_match, scheme) => `${scheme}:<redacted>`],
  // WIFs: base58, 51–52 characters, starting with a WIF prefix (testnet c/9, mainnet 5/K/L).
  [new RegExp(`(?<![${BASE58}])[c95KL][${BASE58}]{50,51}(?![${BASE58}])`, 'g'), () => '<wif>'],
  // 32-byte keys, hashes and shared secrets in hex (and longer hex runs).
  [/\b[0-9a-fA-F]{64,}\b/g, () => '<hex>'],
  // base64 of 40+ characters with a +, / or = (a padded 32-byte key is 44). Base58 ids have none.
  [/[A-Za-z0-9+/]{40,}={0,2}/g, (match) => (/[+/=]/.test(match) ? '<base64>' : match)],
];

export function redact(text: string): string {
  return RULES.reduce((out, [pattern, replace]) => out.replace(pattern, replace), text);
}
