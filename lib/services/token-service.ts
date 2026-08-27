import { logger } from '@/lib/logger';
import { getEvoSdk } from './evo-sdk-service';
import { signerService, KeyPurpose, SecurityLevel } from './signer-service';
import { Identifier } from '@dashevo/evo-sdk';
import { findMatchingKeyIndex, type IdentityPublicKeyInfo } from '@/lib/crypto/keys';
import type { IdentityPublicKey as WasmIdentityPublicKey } from '@dashevo/wasm-sdk/compressed';
import { YAPPR_CONTRACT_ID, YAPP_TOKEN_POSITION, keyNetwork } from '../constants';
import { extractErrorMessage } from '../error-utils';

export interface TokenResult {
  success: boolean;
  error?: string;
  errorCode?: 'INVALID_KEY' | 'INSUFFICIENT_CREDITS' | 'BELOW_MINIMUM' | 'NOT_AUTHORIZED' | 'NETWORK_ERROR' | 'NEEDS_CRITICAL_KEY';
}

/** Minimum YAPP per direct purchase — enforced on-chain by the SetPrices tier, mirrored here for UX. */
export const MIN_YAPP_PURCHASE = BigInt(100);

class TokenService {
  private tokenIdCache: string | null = null;

  /** Resolve (and cache) the YAPP token id from the contract + position. */
  async getTokenId(): Promise<string> {
    if (this.tokenIdCache) return this.tokenIdCache;
    const sdk = await getEvoSdk();
    this.tokenIdCache = await sdk.tokens.calculateId(YAPPR_CONTRACT_ID, YAPP_TOKEN_POSITION);
    return this.tokenIdCache;
  }

  /**
   * Look up a token entry from an SDK result keyed by token id. The evo-sdk
   * facade types these Maps as keyed by wasm `Identifier`, so a plain
   * `map.get(base58String)` can miss; match by string form of the key.
   */
  private tokenMapGet<V>(result: unknown, tokenId: string): V | undefined {
    if (result instanceof Map) {
      const direct = result.get(tokenId);
      if (direct !== undefined) return direct as V;
      let found: V | undefined;
      (result as Map<unknown, V>).forEach((v, k) => {
        if (found !== undefined) return;
        const key = typeof k === 'string'
          ? k
          : String((k as { base58?: () => string })?.base58?.() ?? k);
        if (key === tokenId) found = v;
      });
      return found;
    }
    return (result as Record<string, V>)?.[tokenId];
  }

  /**
   * Current YAPP balance (whole tokens, decimals=0) for an identity.
   * Throws on a fetch failure so callers can distinguish "unknown" (e.g. a
   * transient DAPI error) from a genuine zero balance — do not swallow to 0.
   */
  async getBalance(identityId: string): Promise<bigint> {
    const [sdk, tokenId] = await Promise.all([getEvoSdk(), this.getTokenId()]);
    const balances = await sdk.tokens.identityBalances(identityId, [tokenId]);
    return this.tokenMapGet<bigint>(balances, tokenId) ?? BigInt(0);
  }

  /**
   * Price in credits to buy one YAPP (the SetPrices tier value). Null if not for
   * sale. Fetched fresh each call so `maxTotalCost` never uses a stale price.
   */
  async getPricePerToken(): Promise<bigint | null> {
    try {
      const sdk = await getEvoSdk();
      const tokenId = await this.getTokenId();
      const prices = await sdk.tokens.directPurchasePrices([tokenId]);
      const info = this.tokenMapGet<{ currentPrice?: string }>(prices, tokenId);
      if (!info) return null;
      const current = info.currentPrice;
      if (current === undefined) return null;
      return BigInt(current);
    } catch (error) {
      logger.error('Error fetching YAPP price:', error);
      return null;
    }
  }

  /**
   * Buy `amount` YAPP for the buyer, spending at most `maxTotalCost` credits.
   * `maxTotalCost` is the cost the user approved in the UI (caller passes the
   * quoted total), so a mid-flight price increase is rejected on-chain rather
   * than silently overspending.
   *
   * Drive only accepts a CRITICAL auth key for direct purchase (it spends
   * credits). If the stored login key is HIGH, this returns
   * NEEDS_CRITICAL_KEY without broadcasting; the UI should prompt for the
   * CRITICAL key and retry with `criticalKeyWif` (used to sign, never stored).
   */
  async buyYapp(buyerId: string, amount: bigint, maxTotalCost: bigint, criticalKeyWif?: string): Promise<TokenResult> {
    if (amount < MIN_YAPP_PURCHASE) {
      return { success: false, error: `Minimum purchase is ${MIN_YAPP_PURCHASE} YAPP`, errorCode: 'BELOW_MINIMUM' };
    }

    try {
      const sdk = await getEvoSdk();
      const { signer, identityKey } = await this.getAuthSigner(buyerId, {
        requireCritical: true,
        overrideWif: criticalKeyWif,
      });

      await sdk.tokens.directPurchase({
        dataContractId: new Identifier(YAPPR_CONTRACT_ID),
        tokenPosition: YAPP_TOKEN_POSITION,
        buyerId: new Identifier(buyerId),
        amount,
        maxTotalCost,
        identityKey,
        signer,
      } as Parameters<typeof sdk.tokens.directPurchase>[0]);

      return { success: true };
    } catch (error) {
      return this.toResult(error, 'Purchase failed');
    }
  }

  /**
   * Freeze an identity's YAPP balance (moderation — blocks posting + transfers).
   * Signed by the token authority (contract owner) identity.
   */
  async freeze(authorityId: string, frozenIdentityId: string, publicNote?: string): Promise<TokenResult> {
    return this.authorityAction('freeze', authorityId, frozenIdentityId, publicNote);
  }

  /** Unfreeze a previously frozen identity (reinstate). */
  async unfreeze(authorityId: string, frozenIdentityId: string, publicNote?: string): Promise<TokenResult> {
    return this.authorityAction('unfreeze', authorityId, frozenIdentityId, publicNote);
  }

  /** Destroy (burn) a frozen identity's YAPP balance — the slash. Requires a prior freeze. */
  async destroyFrozen(authorityId: string, frozenIdentityId: string, publicNote?: string): Promise<TokenResult> {
    return this.authorityAction('destroyFrozen', authorityId, frozenIdentityId, publicNote);
  }

  private async authorityAction(
    action: 'freeze' | 'unfreeze' | 'destroyFrozen',
    authorityId: string,
    frozenIdentityId: string,
    publicNote?: string
  ): Promise<TokenResult> {
    try {
      const sdk = await getEvoSdk();
      const { signer, identityKey } = await this.getAuthSigner(authorityId);

      const options = {
        dataContractId: new Identifier(YAPPR_CONTRACT_ID),
        tokenPosition: YAPP_TOKEN_POSITION,
        authorityId: new Identifier(authorityId),
        frozenIdentityId: new Identifier(frozenIdentityId),
        publicNote,
        identityKey,
        signer,
      };

      if (action === 'freeze') {
        await sdk.tokens.freeze(options as Parameters<typeof sdk.tokens.freeze>[0]);
      } else if (action === 'unfreeze') {
        await sdk.tokens.unfreeze(options as Parameters<typeof sdk.tokens.unfreeze>[0]);
      } else {
        await sdk.tokens.destroyFrozen(options as Parameters<typeof sdk.tokens.destroyFrozen>[0]);
      }
      return { success: true };
    } catch (error) {
      return this.toResult(error, `${action} failed`);
    }
  }

  /**
   * Build an IdentitySigner + matching AUTHENTICATION key for an identity.
   * Uses `overrideWif` when given (a key the user just entered), otherwise the
   * private key from secure storage. Mirrors tip-service's transfer-key flow.
   * With `requireCritical`, only a CRITICAL key may match — throws the
   * NEEDS_CRITICAL_KEY marker otherwise so callers can prompt for one.
   */
  private async getAuthSigner(
    identityId: string,
    opts?: { requireCritical?: boolean; overrideWif?: string }
  ) {
    let wif = opts?.overrideWif?.trim();
    if (!wif) {
      const { getPrivateKey } = await import('../secure-storage');
      const stored = getPrivateKey(identityId);
      if (!stored) {
        const { promptForAuthKey } = await import('../auth-utils');
        promptForAuthKey();
        throw new Error('Private key not found — please re-authenticate');
      }
      wif = stored.trim();
    }

    const sdk = await getEvoSdk();
    const identity = await sdk.identities.fetch(identityId);
    if (!identity) throw new Error('Identity not found');

    const allowedLevels = opts?.requireCritical
      ? [SecurityLevel.CRITICAL]
      : [SecurityLevel.CRITICAL, SecurityLevel.HIGH];
    const authKey = this.findMatchingAuthKey(wif, identity.publicKeys, allowedLevels);
    if (!authKey) {
      throw new Error(
        opts?.requireCritical
          ? 'critical key required'
          : 'No matching AUTHENTICATION key (CRITICAL/HIGH) found for the stored private key'
      );
    }

    return signerService.createSignerFromWasmKey(wif, authKey);
  }

  /** Find the AUTHENTICATION key at an allowed security level that matches the provided WIF. */
  private findMatchingAuthKey(
    wif: string,
    wasmPublicKeys: WasmIdentityPublicKey[],
    allowedLevels: number[]
  ): WasmIdentityPublicKey | null {
    const network = keyNetwork();
    // Filter to the allowed levels BEFORE matching so a lower-security key
    // derived from the same WIF (e.g. a MEDIUM key at a lower id after a
    // rotation) can't win the match and mask a valid key.
    const authKeys = wasmPublicKeys.filter(k =>
      !k.disabledAt &&
      k.purposeNumber === KeyPurpose.AUTHENTICATION &&
      allowedLevels.includes(k.securityLevelNumber)
    );
    if (authKeys.length === 0) return null;

    const keyInfos: IdentityPublicKeyInfo[] = authKeys.map(key => ({
      id: key.keyId,
      type: key.keyTypeNumber,
      purpose: key.purposeNumber,
      securityLevel: key.securityLevelNumber,
      data: new Uint8Array(key.data.match(/.{1,2}/g)?.map(b => parseInt(b, 16)) || []),
    }));

    const match = findMatchingKeyIndex(wif, keyInfos, network);
    if (!match) return null;
    return authKeys.find(k => k.keyId === match.keyId) || null;
  }

  private toResult(error: unknown, fallback: string): TokenResult {
    const msg = extractErrorMessage(error);
    logger.error(`${fallback}:`, msg);
    const lower = msg.toLowerCase();
    // Local marker from getAuthSigner, or Drive's rejection ("Invalid public
    // key security level HIGH. The state transition requires one of CRITICAL").
    if (
      lower.includes('critical key required') ||
      (lower.includes('invalid public key security level') && lower.includes('critical'))
    ) {
      return {
        success: false,
        error: 'This action needs your CRITICAL key to authorize',
        errorCode: 'NEEDS_CRITICAL_KEY',
      };
    }
    if (lower.includes('not authorized') || lower.includes('noone')) {
      return { success: false, error: 'Not authorized to perform this action', errorCode: 'NOT_AUTHORIZED' };
    }
    // Insufficient Dash credits to pay for the purchase (various phrasings /
    // the compact `IdentityInsufficientBalanceError` name).
    if (
      (lower.includes('enough') && lower.includes('credit')) ||
      lower.includes('insufficientbalance') ||
      ((lower.includes('insufficient') || lower.includes('not enough')) && lower.includes('balance'))
    ) {
      return { success: false, error: 'Insufficient Dash credits to complete the purchase', errorCode: 'INSUFFICIENT_CREDITS' };
    }
    if (lower.includes('underminimum') || lower.includes('under minimum') || lower.includes('minimum sale')) {
      return { success: false, error: `Minimum purchase is ${MIN_YAPP_PURCHASE} YAPP`, errorCode: 'BELOW_MINIMUM' };
    }
    if (lower.includes('userpricetoolow') || lower.includes('price too low') || lower.includes('price changed')) {
      return { success: false, error: 'The YAPP price changed — please reopen and confirm the new cost', errorCode: 'NETWORK_ERROR' };
    }
    // Only classify as a key problem when the local signer genuinely didn't match —
    // NOT on transient consensus/proof errors that merely contain "key"/"signature"
    // (e.g. "no quorum public key found", "signature verification for proof failed").
    if (lower.includes('no matching authentication key') || lower.includes('private key not found')) {
      return { success: false, error: 'No suitable signing key for this identity', errorCode: 'INVALID_KEY' };
    }
    return { success: false, error: `${fallback}: ${msg}`, errorCode: 'NETWORK_ERROR' };
  }
}

export const tokenService = new TokenService();
