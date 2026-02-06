export function TestnetDowntimeBanner() {
  return (
    <div className="bg-red-600 text-white px-2 sm:px-4 text-xs sm:text-sm fixed top-[32px] sm:top-[40px] left-0 right-0 z-50 h-[32px] sm:h-[40px] flex items-center justify-center">
      <div className="max-w-7xl mx-auto text-center whitespace-nowrap overflow-hidden">
        <span className="font-bold">OFFLINE</span>
        <span className="opacity-80 mx-1">|</span>
        <span className="font-medium">
          <span className="hidden sm:inline">Dash Platform testnet is currently down for maintenance. Yappr will not function until it is restored.</span>
          <span className="sm:hidden">Testnet down for maintenance</span>
        </span>
      </div>
    </div>
  )
}
