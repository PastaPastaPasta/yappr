/** Every deployment on a network shares a bundled snapshot; keep their union. */
export function snapshotEnvFiles(network) {
  if (network === 'devnet') return ['.env.devnet']
  if (network === 'testnet') return ['.env.testing', '.env.testnet']
  return []
}

export function snapshotContractIds(envs, extraIds, dashpayId, seededTopologies) {
  const ids = new Set(extraIds.split(',').map(id => id.trim()).filter(Boolean))
  for (const env of envs) {
    for (const [name, value] of Object.entries(env)) {
      if (/^NEXT_PUBLIC_.*CONTRACT_ID$/.test(name) && value) ids.add(value)
    }
    // The App Connect anchor is also a contract, despite its env key's name.
    if (env.NEXT_PUBLIC_APP_CONNECT_APP_ID) ids.add(env.NEXT_PUBLIC_APP_CONNECT_APP_ID)
    if (seededTopologies.includes(env.NEXT_PUBLIC_CONTRACT_TOPOLOGY)) ids.add(dashpayId)
  }
  return [...ids].sort()
}
