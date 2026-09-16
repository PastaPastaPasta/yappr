import { DEVNET_NAME, getConfiguredNetwork, type AppNetwork } from './constants'

/** The bridge names its devnets with the `devnet-` prefix. */
export function identityBridgeUrl(network: AppNetwork = getConfiguredNetwork(), devnetName = DEVNET_NAME): string {
  const bridgeNetwork = network === 'devnet' ? `devnet-${devnetName}` : network
  return `https://bridge.thepasta.org/?network=${encodeURIComponent(bridgeNetwork)}`
}
