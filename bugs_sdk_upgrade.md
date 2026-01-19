# SDK Upgrade Bug Reports

## Purpose
Track bugs discovered during the SDK upgrade from dev.9 to dev.11.

---

<!-- No open bugs currently -->

---

## RESOLVED BUGS

### BUG-SDK-001: Key Selection Mismatch During Document Creation (FIXED)

**Status**: RESOLVED
**Resolution Date**: 2026-01-19
**Severity**: CRITICAL
**Phase**: Phase 2 (State Transition Service)

#### Root Cause
The bug manifested in two ways:
1. **Security Level Error**: When selecting a signing key, the code picked MASTER (0) security level keys, but document operations only allow CRITICAL (1) or HIGH (2) keys.
2. **Key Mismatch Error**: After fixing #1, the code selected CRITICAL keys based on security level alone, but the stored private key might correspond to a different identity key (e.g., HIGH key).

The WASM signer uses the public key hash to look up private keys. If the selected identity key doesn't match the private key in the signer, signing fails with "No private key found for public key hash".

#### Solution
1. Added new `findMatchingSigningKey()` method that:
   - Derives the public key from the stored private key WIF
   - Computes the hash160 of the public key
   - Matches it against each identity public key's data
   - Verifies the matched key has appropriate security level (CRITICAL or HIGH) and purpose (AUTHENTICATION)
2. Updated all document operations (create, update, delete) to use this method instead of selecting keys by security level alone.

#### Files Modified
- `lib/services/state-transition-service.ts` - Added `findMatchingSigningKey()` method and updated all document operations

---

<!-- Add bug reports below as they are discovered -->
