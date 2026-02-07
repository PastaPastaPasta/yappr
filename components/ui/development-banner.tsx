export function DevelopmentBanner() {
  return (
    <div className="bg-yappr-500 text-white px-2 sm:px-4 text-xs sm:text-sm fixed top-0 left-0 right-0 z-50 h-[32px] sm:h-[40px] flex items-center justify-center">
      <div className="max-w-7xl mx-auto text-center whitespace-nowrap overflow-hidden">
        <span className="font-bold">TESTNET</span>
        <span className="opacity-70 mx-1">|</span>
        <span className="font-medium">
          <span className="hidden sm:inline">Running on Dash Platform Testnet. Data may be reset.</span>
          <span className="sm:hidden">Data may be reset</span>
        </span>
      </div>
    </div>
  )
}
