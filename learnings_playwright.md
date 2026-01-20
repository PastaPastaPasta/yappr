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
