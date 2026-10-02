// Waits PAUSE_MS milliseconds: a user's moment before "Try again" after a transient
// failure (sakura's lag), so the retry is not made while the SDK still fails at once.
// Maestro has no sleep, Maestro's JavaScript has no timers, and extendedWaitUntil can't
// stand in: its timeout counts from the last tap or typed text, not from the wait itself,
// so a wait long after the last interaction returns at once.
const until = Date.now() + Number(PAUSE_MS);
while (Date.now() < until) {
  // busy wait
}
