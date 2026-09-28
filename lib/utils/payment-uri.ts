import bs58check from 'bs58check'

/** Validate a Dash Base58Check address and ensure its network version matches. */
export function isValidDashAddress(address: string, network: 'mainnet' | 'testnet'): boolean {
  const value = address.trim()
  if (!value) return false

  try {
    const decoded = bs58check.decode(value)
    // Dash P2PKH/P2SH addresses are version byte + 20-byte hash.
    if (decoded.length !== 21) return false
    const version = decoded[0]
    const validVersions = network === 'mainnet' ? [76, 16] : [140, 19]
    return validVersions.includes(version)
  } catch {
    return false
  }
}

const BASE58 = '[1-9A-HJ-NP-Za-km-z]'
// Bech32 is all-lowercase or all-uppercase (QR codes use upper); mixing is not checked.
const BECH32 = '[02-9ac-hj-np-zAC-HJ-NP-Z]'
const bech32 = (hrps: string[], min: number, max?: number) =>
  `(${hrps.flatMap((hrp) => [hrp, hrp.toUpperCase()]).join('|')})1${BECH32}{${min},${max ?? ''}}`

/**
 * The rough shape of each non-Dash destination: alphabet, prefix and length,
 * mainnet and testnet forms. Enough to refuse typos and junk like
 * `bitcoin:notanaddress`; it does not verify checksums.
 */
const DESTINATION_SHAPES: Record<string, RegExp> = {
  // Legacy Base58 runs to 35 characters for testnet P2SH (`2…`).
  'bitcoin:': new RegExp(`^(${BASE58}{25,35}|${bech32(['bc', 'tb', 'bcrt'], 8, 87)})$`),
  'litecoin:': new RegExp(`^(${BASE58}{25,34}|${bech32(['ltc', 'tltc'], 8, 87)})$`),
  'dogecoin:': new RegExp(`^${BASE58}{25,34}$`),
  'bitcoincash:': new RegExp(`^(${BASE58}{25,34}|[qpQP]${BECH32}{41})$`),
  'zcash:': new RegExp(`^(t[1-3m]${BASE58}{33}|${bech32(['zs', 'u', 'ztestsapling', 'utest'], 40)})$`),
  // EIP-681: optional pay- prefix, an address or ENS name, chain id and function.
  'ethereum:': /^(pay-)?(0x[0-9a-fA-F]{40}|[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*\.eth)(@\d+)?(\/\w+)?$/,
  'monero:': new RegExp(`^(${BASE58}{95}|${BASE58}{106})$`),
  'solana:': new RegExp(`^${BASE58}{32,44}$`),
  'tron:': new RegExp(`^T${BASE58}{33}$`),
  'polkadot:': new RegExp(`^${BASE58}{46,48}$`),
  'ripple:': new RegExp(`^(r${BASE58}{24,34}|[XT]${BASE58}{46})$`),
  // A public key, a muxed account, or a federation address (name*domain).
  'stellar:': /^(G[A-Z2-7]{55}|M[A-Z2-7]{68}|[^*\s]+\*[^*\s]+\.[^*\s]+)$/,
  'cardano:': new RegExp(`^(${bech32(['addr', 'addr_test'], 50)}|${BASE58}{50,130})$`),
  // A BOLT11 invoice or LNURL, or a Lightning address (user@domain).
  'lightning:': /^((ln|LN)[a-zA-Z0-9]{10,}|[^\s@]+@[^\s@]+\.[^\s@]+)$/,
}

export function isValidPaymentAddress(scheme: string, address: string): boolean {
  const normalizedScheme = scheme.toLowerCase()
  // A custom payment URI may include optional amount, label, or message fields.
  // Validate its destination without changing or discarding the query parameters.
  const destination = address.split('?', 1)[0].trim()
  if (normalizedScheme === 'dash:') return isValidDashAddress(destination, 'mainnet')
  if (normalizedScheme === 'tdash:') return isValidDashAddress(destination, 'testnet')
  const shape = DESTINATION_SHAPES[normalizedScheme]
  return shape ? shape.test(destination) : Boolean(destination)
}
