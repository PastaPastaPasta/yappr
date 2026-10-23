// The preset's test environment, which also clears the timers a test file left pending once it is
// torn down (see the timer tracking at the top of jest.setup.js). An `afterAll` hook is too early
// for some: TanStack Query schedules a cache entry's 7 day gcTime when a fetch settles, which can
// be after the file's own hooks have run.
const BaseEnvironment = require(require('jest-expo/jest-preset').testEnvironment);

const PENDING_TIMERS = Symbol.for('yappr.jest.pendingTimers');

class Environment extends BaseEnvironment {
  async teardown() {
    this.global[PENDING_TIMERS]?.close();
    await super.teardown();
  }
}

module.exports = Environment;
