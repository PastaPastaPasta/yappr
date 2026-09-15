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

export function isValidPaymentAddress(scheme: string, address: string): boolean {
  const normalizedScheme = scheme.toLowerCase()
  // A custom payment URI may include optional amount, label, or message fields.
  // Validate its destination without changing or discarding the query parameters.
  const destination = address.split('?', 1)[0]
  if (normalizedScheme === 'dash:') return isValidDashAddress(destination, 'mainnet')
  if (normalizedScheme === 'tdash:') return isValidDashAddress(destination, 'testnet')
  return Boolean(address.trim())
}
