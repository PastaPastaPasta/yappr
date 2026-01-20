import { validateTestIdentities } from './helpers/identity.helpers';

/**
 * Global setup for Playwright tests
 * Runs once before all tests
 */
async function globalSetup(): Promise<void> {
  console.log('🔧 Running global setup...');

  // Validate that all required test identities exist
  try {
    validateTestIdentities();
    console.log('✅ All test identity files found');
  } catch (error) {
    console.error('❌ Test identity validation failed:');
    console.error((error as Error).message);
    throw error;
  }

  console.log('🚀 Global setup complete');
}

export default globalSetup;
