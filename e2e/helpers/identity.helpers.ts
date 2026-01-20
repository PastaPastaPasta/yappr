import { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { TestIdentity, saveIdentity } from '../test-data/identities';

/**
 * Faucet URL for creating test identities
 */
const FAUCET_URL = 'https://faucet.thepasta.org';

/**
 * Create a new test identity using the faucet
 * Note: This is a placeholder - actual implementation depends on faucet API
 */
export async function createTestIdentity(name: string): Promise<TestIdentity> {
  // This would call the faucet API to create a new funded identity
  // For now, throw an error as identities should be pre-created
  throw new Error(
    `Creating new identities via faucet not implemented. ` +
    `Please create identity "${name}" manually at ${FAUCET_URL}`
  );
}

/**
 * Check if identity file exists
 */
export function identityFileExists(identityNumber: 1 | 2 | 3): boolean {
  const filePath = path.join(process.cwd(), `testing-identity-${identityNumber}.json`);
  return fs.existsSync(filePath);
}

/**
 * Validate that all required test identities exist
 */
export function validateTestIdentities(): void {
  const required = [1, 2, 3] as const;
  const missing: number[] = [];

  for (const num of required) {
    if (!identityFileExists(num)) {
      missing.push(num);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing test identity files: ${missing.map(n => `testing-identity-${n}.json`).join(', ')}. ` +
      `Please create them at ${FAUCET_URL}`
    );
  }
}

/**
 * Mark identity as having private feed enabled
 */
export function markPrivateFeedEnabled(
  identityNumber: 1 | 2 | 3,
  identity: TestIdentity
): void {
  identity.privateFeedEnabled = true;
  identity.privateFeedEnabledAt = new Date().toISOString().split('T')[0];
  saveIdentity(identityNumber, identity);
}

/**
 * Mark identity as having a profile
 */
export function markHasProfile(
  identityNumber: 1 | 2 | 3,
  identity: TestIdentity,
  displayName: string
): void {
  identity.hasProfile = true;
  identity.displayName = displayName;
  saveIdentity(identityNumber, identity);
}

/**
 * Generate a random encryption key (32 bytes hex)
 */
export function generateEncryptionKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Get the balance of an identity via the page (requires being logged in)
 */
export async function getBalance(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    // Look for balance display in the UI
    const balanceEl = document.querySelector('[data-testid="balance"]') ||
      document.querySelector('.balance');
    return balanceEl?.textContent || null;
  });
}

/**
 * Verify identity has sufficient balance for operations
 */
export async function verifySufficientBalance(page: Page, minimumDash: number = 0.01): Promise<boolean> {
  const balance = await getBalance(page);
  if (!balance) return false;

  const numericBalance = parseFloat(balance.replace(/[^\d.]/g, ''));
  return numericBalance >= minimumDash;
}
