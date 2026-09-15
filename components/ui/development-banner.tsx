import { getConfiguredNetwork } from '@/lib/constants'

const NETWORK_SENTENCE: Record<string, string> = {
  testnet: 'Running on Dash Platform Testnet. Data may be reset.',
  devnet: 'Running on a Dash Platform devnet. Data may be reset.',
  mainnet: 'Running on Dash Platform Mainnet.',
}

export function DevelopmentBanner() {
  const network = getConfiguredNetwork()

  return (
    <div className="bg-amber-500 text-black px-2 sm:px-4 text-xs sm:text-sm fixed top-0 left-0 right-0 z-50 h-[32px] sm:h-[40px] flex items-center justify-center">
      <div className="max-w-7xl mx-auto text-center whitespace-nowrap overflow-hidden">
        <span className="font-bold">{network.toUpperCase()}</span>
        <span className="opacity-80 mx-1">|</span>
        <span className="font-medium">
          <span className="hidden sm:inline">{NETWORK_SENTENCE[network]}</span>
          <span className="sm:hidden">Data may be reset</span>
        </span>
      </div>
    </div>
  )
}
