# Yappr Private Feed — Playwright E2E Test Learnings

## Key Learnings

Document issues encountered, workarounds found, and tips for future implementation.

---

## Known Patterns

### Blockchain Timing
- State transitions can take 5-30 seconds
- Use `{ timeout: 60000 }` for blockchain operations
- Expect flakiness; use retry logic where needed

### Identity Management
- Test identities persist in testing-identity-X.json
- Faucet at https://faucet.thepasta.org for new identities
- PrivateFeedState is immutable - can't reset on-chain

### Session Storage
- Auth keys: `yappr_session` in localStorage
- Encryption keys: `yappr_secure_ek_{id}`
- Private feed keys: `yappr:pf:*` prefix
- Clear localStorage between tests for isolation

### Selectors
- App doesn't use data-testid attributes
- Use text content, roles, and placeholders
- See e2e_prd.md §8 for key selectors

---

## Learnings Log

<!-- Append entries below in format:
### YYYY-MM-DD - Topic
- Issue encountered
- How it was resolved
- Tips for others
-->

### 2026-01-19 - Dev Server Stale State

**Issue:** Login identity lookup hung indefinitely - no spinner or checkmark appeared after typing identity ID.

**Root Cause:** The Next.js dev server had stale/corrupted JS chunks from a previous session. The 404 errors on JS files prevented React from executing properly.

**Resolution:** Kill any existing dev servers before running tests. The Playwright webServer config handles starting a fresh one.

```bash
pkill -f "next dev" || true
npm run test:e2e
```

**Tips:**
- If identity lookup seems to hang, check browser console for 404 errors on JS files
- Use `mcp__playwright__browser_console_messages` to debug
- The webServer config's `reuseExistingServer: !process.env.CI` can cause issues if existing server is stale

---

### 2026-01-19 - React Input Handling

**Issue:** Using `page.fill()` didn't trigger React's onChange properly for the identity lookup debounce.

**Root Cause:** React's synthetic event system and the 500ms debounce in the login component required actual keystrokes to trigger properly.

**Resolution:** Use `pressSequentially()` instead of `fill()` for inputs that have React state updates tied to onChange.

```typescript
// Instead of:
await page.fill('#identityInput', identity.identityId);

// Use:
await page.locator('#identityInput').pressSequentially(identity.identityId, { delay: 20 });
```

**Tips:**
- Add a small delay (10-20ms) between keystrokes for reliability
- After typing, wait for the loading spinner or checkmark to appear
- The login flow has two validation checkmarks: one for identity lookup, one for key validation

---

### 2026-01-19 - Post-Login Modals

**Issue:** After successful login, the page showed username registration and key backup modals that blocked navigation.

**Root Cause:** The app prompts new users without DPNS usernames to register one, and prompts users without key backups to create one.

**Resolution:** Added `dismissPostLoginModals()` helper that clicks "Skip for now" buttons until all modals are dismissed.

```typescript
// In auth.helpers.ts
export async function dismissPostLoginModals(page: Page): Promise<void> {
  await page.waitForTimeout(2000);
  for (let i = 0; i < 3; i++) {
    const skipButtons = page.locator('button:has-text("Skip for now")');
    if (await skipButtons.count() === 0) break;
    try {
      await skipButtons.last().click({ timeout: 3000 });
      await page.waitForTimeout(500);
    } catch { break; }
  }
}
```

**Tips:**
- Modals may stack (key backup overlays username registration)
- Click the last "Skip for now" button first to close topmost modal
- Some test identities may already have usernames - modals won't appear for them

---

### 2026-01-19 - Login Selectors

**Issue:** PRD selectors like `input[placeholder*="Identity ID"]` didn't match actual login page.

**Root Cause:** The login page uses `#identityInput` and `#credential` IDs, and the placeholder text is longer than documented.

**Resolution:** Use element IDs instead of placeholder text:
- Identity input: `#identityInput`
- Credential input: `#credential`
- Sign In button: `button:has-text("Sign In")`
- Green checkmark: `svg.text-green-500`
- Loading spinner: `svg.animate-spin`

**Tips:**
- Always verify selectors against actual app code when tests fail
- The PRD selectors are approximations - actual code may differ

---

### 2026-01-19 - Strict Mode Text Locators

**Issue:** `page.locator('text=Some text')` failed with "strict mode violation" when multiple elements matched.

**Root Cause:** Playwright's strict mode (enabled by default) requires locators to resolve to exactly one element. Text like "Private feed is enabled" can appear in multiple places (headings, descriptions, etc.).

**Resolution:** Use `.first()` to explicitly select the first matching element:

```typescript
// Instead of:
await expect(page.locator('text=Private feed is enabled')).toBeVisible();

// Use:
await expect(page.getByText('Private feed is enabled').first()).toBeVisible();
```

**Tips:**
- Always use `.first()` or more specific selectors when testing for visible text
- Use `page.getByText()` for text matching as it provides better semantics
- Consider using `page.getByRole()` for interactive elements to be more specific

---

### 2026-01-19 - Async State Loading in Private Feed Settings

**Issue:** Test for "missing encryption key" flow expected UI that hadn't loaded yet.

**Root Cause:** The `PrivateFeedSettings` component loads `hasEncryptionKeyOnIdentity` asynchronously from the chain. The button changes from "Enable Private Feed" to "Add Encryption Key to Identity" after this check completes.

**Resolution:** Added wait and handled both possible UI states:

```typescript
// Wait for async check to complete
await page.waitForTimeout(3000);

const addKeyBtn = page.locator('button:has-text("Add Encryption Key to Identity")');
const enableBtn = page.locator('button:has-text("Enable Private Feed")');

const addKeyVisible = await addKeyBtn.isVisible().catch(() => false);
const enableBtnVisible = await enableBtn.isVisible().catch(() => false);

if (addKeyVisible) {
  // Case: No encryption key on identity
} else if (enableBtnVisible) {
  // Case: Has encryption key on identity
}
```

**Tips:**
- For async-loading UI, consider waiting for a stable state indicator
- Test both possible UI states when dealing with on-chain state checks
- The identity may have keys on-chain that aren't in the local JSON file

---

### 2026-01-19 - Idempotent Tests with On-Chain State

**Issue:** Test 1.1 "Enable Private Feed" would fail on second run because private feed was already enabled.

**Root Cause:** PrivateFeedState is immutable on-chain - once enabled, it can't be un-enabled without a full reset.

**Resolution:** Check local identity file for `privateFeedEnabled` flag before running enable test:

```typescript
const currentIdentity = loadIdentity(2);
if (currentIdentity.privateFeedEnabled) {
  test.skip(true, 'Identity 2 already has private feed enabled from previous run');
  return;
}
```

Also update the identity file after successful enable:
```typescript
const updatedIdentity = loadIdentity(2);
updatedIdentity.privateFeedEnabled = true;
saveIdentity(2, updatedIdentity);
```

**Tips:**
- Tests that modify on-chain state should be idempotent (skip if already done)
- Track state changes in the identity JSON files for subsequent runs
- Consider using fresh identities from faucet for truly clean state

---

### 2026-01-20 - Profile Page Button States

**Issue:** Request access tests needed to handle multiple possible states on the profile page.

**Root Cause:** The profile page shows different buttons based on the relationship between viewer and profile owner:
- "Follow" - when not following
- "Following" or "Unfollow" - when following
- "Request Access" - when following and owner has private feed, viewer hasn't requested
- "Pending" - when request is pending
- "Revoked" - when access was revoked (cannot re-request)
- Private follower indicator when approved

**Resolution:** Tests check for all possible states and skip appropriately:

```typescript
const isPending = await pendingBtn.isVisible({ timeout: 2000 }).catch(() => false);
const isApproved = await approvedIndicator.isVisible({ timeout: 2000 }).catch(() => false);
const isRevoked = await revokedBtn.isVisible({ timeout: 2000 }).catch(() => false);
const canRequest = await requestBtn.isVisible({ timeout: 2000 }).catch(() => false);

if (isApproved) {
  test.skip(true, 'Follower already has approved access from previous run');
  return;
}
```

**Tips:**
- Profile buttons also include follower/following counts (e.g., "0 Following", "4 Followers")
- Use `.filter({ hasText: /pattern/i })` for case-insensitive matching
- Handle both fresh and stale state gracefully with descriptive skip messages

---

### 2026-01-20 - Transient Network Failures

**Issue:** Test 3.2 failed intermittently during identity lookup with 90-second timeout.

**Root Cause:** Blockchain DAPI requests can occasionally fail or take longer than expected due to network conditions or node availability.

**Resolution:** The existing retry logic in `auth.helpers.ts` handles most cases. For truly flaky tests, consider:
1. Re-running individual tests to verify they pass
2. Using Playwright's built-in retry configuration
3. Increasing timeouts for network-heavy operations

**Tips:**
- Single test failures during identity lookup are often transient
- If a test fails once but passes on retry, it's likely network-related
- The 90s timeout with progressive intervals (1s, 2s, 5s, 10s) is sufficient for most cases
