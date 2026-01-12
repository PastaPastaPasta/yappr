export function DevelopmentBanner() {
  return (
    <div className="bg-amber-500 text-black px-4 py-2 text-sm fixed top-0 left-0 right-0 z-50">
      <div className="max-w-7xl mx-auto text-center">
        <span className="font-bold">TESTNET</span>
        {' '}
        <span className="opacity-80">|</span>
        {' '}
        <span className="font-medium">Running on Dash Platform Testnet. Data may be reset.</span>
      </div>
    </div>
  )
}