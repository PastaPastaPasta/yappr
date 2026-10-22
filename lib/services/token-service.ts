import { logger } from '@/lib/logger';
import { getEvoSdk } from './evo-sdk-service';
import { signerService } from './signer-service';
import { Identifier } from '@dashevo/wasm-sdk';
import { matchIdentityKey } from '@/lib/crypto/keys';
import { KeyPurpose, SecurityLevel } from '@/lib/crypto/identity-keys';
import type { IdentityPublicKey as WasmIdentityPublicKey } from '@dashevo/wasm-sdk/compressed';
import { TOKEN_HISTORY_CONTRACT_ID, YAPPR_CONTRACT_ID, YAPP_TOKEN_POSITION, keyNetwork } from '../constants';
import { starterGrantAmount, yappIsLocked } from '../contract-topology';
import { UNCONFIRMED_WRITE_MESSAGE, extractErrorMessage, isOncePerIdentityAlreadyClaimedError, sentWriteOutcomeUnknown } from '../error-utils';
import { withSdkSignedWrite } from './identity-nonce';
import { SigningUnavailableError, assertRawKeyCovers, hasAppConnectSession, reportSigningFailure, reportSigningSuccess, resolveSigningKey, type SigningKey } from '@/lib/auth/signing-keys';
import { tokenSigningRequest } from '@/lib/app-connect/signing-plan';
import { CRITICAL_KEY_REQUIRED, CriticalKeyCancelledError, availableCriticalKey, criticalKeyFor, criticalKeySession } from '@/lib/auth/critical-key';
import { starterClaimFromHistory, type StarterClaimState } from '@/lib/starter-grant';
import { normalizeSDKResponse, type DocumentOrderByClause, type DocumentWhereClause } from './sdk-helpers';

/** One page of an identity's token-history claims is plenty: YAPP's only distribution is the starter grant. */
const CLAIM_HISTORY_PAGE = 20;

export interface TokenResult {
  success: boolean;
  error?: string;
  errorCode?:
    | 'INVALID_KEY' | 'INSUFFICIENT_CREDITS' | 'BELOW_MINIMUM' | 'NOT_AUTHORIZED' | 'NETWORK_ERROR' | 'NEEDS_CRITICAL_KEY' | 'ALREADY_CLAIMED'
    /** The user closed the sheet asking for the highest-security key: nothing was signed (say nothing). */
    | 'CANCELLED'
    /**
     * Sent, but no verdict came back: the confirmation timed out, or its proof
     * could not be checked (a quorum rotation). It may have landed, so the UI
     * must never offer a plain retry: that could move the tokens or credits twice.
     */
    | 'UNCONFIRMED';
}

/** A token write the SDK sent whose outcome is unknown (see TokenResult's UNCONFIRMED). */
class UnconfirmedTokenWriteError extends Error {
  constructor(unanswered: unknown) {
    super(extractErrorMessage(unanswered));
  }
}

/**
 * Run an SDK-signed token write under the identity's write lock
 * (`withSdkSignedWrite`). Anything but a verdict after the SDK was asked to
 * send (a timeout, an answer that could not be verified, a transport failure)
 * comes back as {@link UnconfirmedTokenWriteError}; a failure before that sent
 * nothing and is rethrown as is.
 */
async function sendTokenWrite(ownerId: string, write: () => Promise<unknown>): Promise<void> {
  let sent = false;
  try {
    await withSdkSignedWrite(ownerId, YAPPR_CONTRACT_ID, () => {
      sent = true;
      return write();
    });
  } catch (error) {
    if (sent && sentWriteOutcomeUnknown(error)) throw new UnconfirmedTokenWriteError(error);
    throw error;
  }
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
   * credits). A session that holds none is asked for it before anything is
   * built (lib/auth/critical-key.ts); closing that sheet answers CANCELLED.
   *
   * Refused without a broadcast where YAPP is locked (v10): the token has no
   * purchase price and no one can ever set one, so Drive would refuse it.
   */
  async buyYapp(buyerId: string, amount: bigint, maxTotalCost: bigint): Promise<TokenResult> {
    if (yappIsLocked()) {
      return { success: false, error: 'YAPP can\'t be bought', errorCode: 'NOT_AUTHORIZED' };
    }
    if (amount < MIN_YAPP_PURCHASE) {
      return { success: false, error: `Minimum purchase is ${MIN_YAPP_PURCHASE} YAPP`, errorCode: 'BELOW_MINIMUM' };
    }

    try {
      const sdk = await getEvoSdk();
      const { signer, identityKey } = await this.getAuthSigner(buyerId, { requireCritical: true });

      await sendTokenWrite(buyerId, () => sdk.tokens.directPurchase({
        dataContractId: new Identifier(YAPPR_CONTRACT_ID),
        tokenPosition: YAPP_TOKEN_POSITION,
        buyerId: new Identifier(buyerId),
        amount,
        maxTotalCost,
        identityKey,
        signer,
      } as Parameters<typeof sdk.tokens.directPurchase>[0]));

      return { success: true };
    } catch (error) {
      return this.toResult(error, 'Purchase failed');
    }
  }

  /**
   * Transfer `amount` YAPP to another identity, signing locally.
   *
   * Like every token transition this needs a CRITICAL auth key: one the tab
   * does not hold is asked for (lib/auth/critical-key.ts), and the UI may
   * instead hand the unsigned transition to the wallet
   * (`buildUnsignedYappTipTransition`).
   *
   * `publicNote` is written verbatim into the token-history `transfer`
   * document and signed along with the amount and the recipient.
   *
   * Refused without a broadcast where YAPP is locked (v10 onwards): Yappr
   * never sends YAPP. On v10–v13 the token is paused for good and on v15 it is
   * not transferable (`yappIsTransferable()` is false, which makes it locked),
   * so Drive would refuse the transfer anyway (40726 on v15); v14's would land
   * (its token config is format 0, which is always transferable), and Yappr
   * deliberately offers none.
   */
  async transfer(
    senderId: string,
    recipientId: string,
    amount: bigint,
    publicNote?: string
  ): Promise<TokenResult> {
    if (yappIsLocked()) {
      return { success: false, error: 'YAPP can\'t be sent to other accounts', errorCode: 'NOT_AUTHORIZED' };
    }
    try {
      const sdk = await getEvoSdk();
      const { signer, identityKey } = await this.getAuthSigner(senderId, { requireCritical: true });

      await sendTokenWrite(senderId, () => sdk.tokens.transfer({
        dataContractId: new Identifier(YAPPR_CONTRACT_ID),
        tokenPosition: YAPP_TOKEN_POSITION,
        senderId: new Identifier(senderId),
        recipientId: new Identifier(recipientId),
        amount,
        publicNote,
        identityKey,
        signer,
      } as Parameters<typeof sdk.tokens.transfer>[0]));

      return { success: true };
    } catch (error) {
      return this.toResult(error, 'Transfer failed');
    }
  }

  /**
   * Whether this tab already holds a CRITICAL authentication key for
   * `identityId` that may sign a token transition (the session's own, or one
   * held for the tab, lib/auth/critical-key.ts): if not, the user is offered
   * their wallet first, and asked for the key only if they choose it.
   * Answered without broadcasting or asking anything; any failure answers
   * false, which only ever routes the user to the wallet path.
   */
  async canSignTokenTransitions(identityId: string): Promise<boolean> {
    try {
      const sessionKey = await this.sessionCriticalCandidate(identityId);
      const sdk = await getEvoSdk();
      const identity = await sdk.identities.fetch(identityId);
      if (!identity) return false;
      return availableCriticalKey(identityId, identity.publicKeys, 'token', sessionKey) !== null;
    } catch (error) {
      logger.debug('tokenService: critical-key probe failed', error);
      return false;
    }
  }

  /**
   * Whether `identityId` has claimed its starter grant, read from chain: the
   * `claim` document Platform writes into the SYSTEM token-history contract
   * for every claim (byRecipient index). Rejects when the read fails;
   * callers then treat it as unknown and offer no claim (#740).
   */
  async readStarterClaimState(identityId: string): Promise<StarterClaimState> {
    const [sdk, tokenId] = await Promise.all([getEvoSdk(), this.getTokenId()]);
    const response = await sdk.documents.query({
      dataContractId: TOKEN_HISTORY_CONTRACT_ID,
      documentTypeName: 'claim',
      where: [
        ['tokenId', '==', tokenId],
        ['recipientId', '==', identityId],
      ] as DocumentWhereClause[],
      orderBy: [
        ['tokenId', 'asc'],
        ['recipientId', 'asc'],
        ['$createdAt', 'asc'],
      ] as DocumentOrderByClause[],
      limit: CLAIM_HISTORY_PAGE,
    });
    return starterClaimFromHistory(normalizeSDKResponse(response), CLAIM_HISTORY_PAGE);
  }

  /**
   * Claims the once-per-identity STARTER GRANT the v9 contract's token
   * declares (`distributionRules.oncePerIdentityDistribution`, 100 YAPP): a
   * fixed amount every identity may claim exactly once. A second claim is
   * refused, paid, with TokenOncePerIdentityDistributionAlreadyClaimedError
   * (40722), which comes back as ALREADY_CLAIMED so the prompt can stop for
   * good. Like every token transition it needs a CRITICAL key.
   */
  async claimStarterGrant(identityId: string): Promise<TokenResult> {
    if (starterGrantAmount() === null) {
      return { success: false, error: 'This contract declares no starter grant', errorCode: 'NOT_AUTHORIZED' };
    }
    let signingKey: SigningKey | undefined;
    try {
      const sdk = await getEvoSdk();
      const auth = await this.getAuthSigner(identityId, { requireCritical: true, keyRing: true });
      const { signer, identityKey } = auth;
      signingKey = auth.signingKey;
      await sendTokenWrite(identityId, () => sdk.tokens.claim({
        dataContractId: new Identifier(YAPPR_CONTRACT_ID),
        tokenPosition: YAPP_TOKEN_POSITION,
        identityId: new Identifier(identityId),
        distributionType: 'oncePerIdentity',
        identityKey,
        signer,
      } as Parameters<typeof sdk.tokens.claim>[0]));
      reportSigningSuccess(identityId);
      return { success: true };
    } catch (error) {
      if (signingKey && !(error instanceof UnconfirmedTokenWriteError)) await reportSigningFailure(identityId, signingKey, error);
      return this.toResult(error, 'Claim failed');
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

      await sendTokenWrite(authorityId, async () => {
        if (action === 'freeze') {
          await sdk.tokens.freeze(options as Parameters<typeof sdk.tokens.freeze>[0]);
        } else if (action === 'unfreeze') {
          await sdk.tokens.unfreeze(options as Parameters<typeof sdk.tokens.unfreeze>[0]);
        } else {
          await sdk.tokens.destroyFrozen(options as Parameters<typeof sdk.tokens.destroyFrozen>[0]);
        }
      });
      return { success: true };
    } catch (error) {
      return this.toResult(error, `${action} failed`);
    }
  }

  /**
   * The stored key the session itself may offer as its CRITICAL step-up key,
   * for the caller to match: never a wallet session's stored leftovers, nor a
   * passkey's CRITICAL key (token transitions ask for the key itself, owner
   * decision V2).
   */
  private async sessionCriticalCandidate(identityId: string): Promise<string | null> {
    if (hasAppConnectSession(identityId)) return null;
    const { getPrivateKeyRecord } = await import('../secure-storage');
    // One read: the key and its provenance from the same record.
    const record = getPrivateKeyRecord(identityId);
    return record && !record.fromPasskey ? record.wif.trim() || null : null;
  }

  /**
   * Build an IdentitySigner + matching AUTHENTICATION key for an identity.
   * With `requireCritical`, only a CRITICAL key signs: the session's own (not
   * a passkey's), else the one held for the tab, else the step-up sheet asks
   * for it (lib/auth/critical-key.ts). Closing the sheet throws
   * CriticalKeyCancelledError; with no sheet mounted, the NEEDS_CRITICAL_KEY
   * marker. Otherwise the stored key, CRITICAL or HIGH.
   *
   * An App Connect session signs what `keyRing` allows (the starter claim,
   * with the CRITICAL group key) from its key ring; every other token
   * transition takes the step-up key.
   */
  private async getAuthSigner(
    identityId: string,
    opts?: { requireCritical?: boolean; keyRing?: boolean }
  ): Promise<{ signer: Awaited<ReturnType<typeof signerService.createSigner>>; identityKey: WasmIdentityPublicKey; signingKey?: SigningKey }> {
    const appConnect = hasAppConnectSession(identityId);
    if (appConnect && opts?.keyRing) {
      const sdk = await getEvoSdk();
      const identity = await sdk.identities.fetch(identityId);
      if (!identity) throw new Error('Identity not found');
      const signingKey = await resolveSigningKey(identityId, identity.publicKeys, tokenSigningRequest(YAPPR_CONTRACT_ID, YAPP_TOKEN_POSITION));
      return { ...(await signerService.createSignerFromWasmKey(signingKey.wif, signingKey.identityKey)), signingKey };
    }
    if (opts?.requireCritical) {
      // The session's own key when it is CRITICAL, else the key held for the tab, else the sheet asks
      // for it now (lib/auth/critical-key.ts). Taken before the key is read: a sign-out or switch while
      // the identity is fetched stops the action.
      const session = criticalKeySession();
      const sessionKey = await this.sessionCriticalCandidate(identityId);
      const sdk = await getEvoSdk();
      const identity = await sdk.identities.fetch(identityId);
      if (!identity) throw new Error('Identity not found');
      const critical = await criticalKeyFor(identityId, identity.publicKeys, 'token', sessionKey, session);
      await assertRawKeyCovers(identityId, critical.key, tokenSigningRequest(YAPPR_CONTRACT_ID, YAPP_TOKEN_POSITION));
      return signerService.createSignerFromWasmKey(critical.wif, critical.key);
    }
    if (appConnect) throw new Error(CRITICAL_KEY_REQUIRED);
    const { getPrivateKeyRecord } = await import('../secure-storage');
    // One read: the key that signs and its provenance come from the same record.
    const stored = getPrivateKeyRecord(identityId);
    if (!stored) {
      const { promptForAuthKey } = await import('../auth-utils');
      promptForAuthKey();
      throw new Error('Private key not found — please re-authenticate');
    }
    // A moderator's CRITICAL key from a passkey never signs token transitions.
    if (stored.fromPasskey) throw new Error(CRITICAL_KEY_REQUIRED);
    const wif = stored.wif.trim();

    const sdk = await getEvoSdk();
    const identity = await sdk.identities.fetch(identityId);
    if (!identity) throw new Error('Identity not found');

    const authKey = this.findMatchingAuthKey(wif, identity.publicKeys, [SecurityLevel.CRITICAL, SecurityLevel.HIGH]);
    if (!authKey) throw new Error('No matching AUTHENTICATION key (CRITICAL/HIGH) found for the stored private key');
    // Every transition here is on the YAPP token: a bound or limited key must cover it.
    await assertRawKeyCovers(identityId, authKey, tokenSigningRequest(YAPPR_CONTRACT_ID, YAPP_TOKEN_POSITION));

    return signerService.createSignerFromWasmKey(wif, authKey);
  }

  /** The AUTHENTICATION key at an allowed security level that matches the provided WIF. */
  private findMatchingAuthKey(
    wif: string,
    wasmPublicKeys: WasmIdentityPublicKey[],
    allowedLevels: number[]
  ): WasmIdentityPublicKey | null {
    const result = matchIdentityKey(wif, wasmPublicKeys, {
      network: keyNetwork(),
      purpose: KeyPurpose.AUTHENTICATION,
      allowedSecurityLevels: allowedLevels,
    });
    return result.ok ? result.key : null;
  }

  private toResult(error: unknown, fallback: string): TokenResult {
    // The user closed the sheet asking for the key: nothing was signed.
    if (error instanceof CriticalKeyCancelledError) return { success: false, errorCode: 'CANCELLED' };
    if (error instanceof SigningUnavailableError) return { success: false, error: error.message, errorCode: 'NOT_AUTHORIZED' };
    if (error instanceof UnconfirmedTokenWriteError) {
      logger.warn(`${fallback} unconfirmed:`, error.message);
      return { success: false, error: UNCONFIRMED_WRITE_MESSAGE, errorCode: 'UNCONFIRMED' };
    }
    const msg = extractErrorMessage(error);
    logger.error(`${fallback}:`, msg);
    const lower = msg.toLowerCase();
    // Local marker from getAuthSigner, or Drive's rejection ("Invalid public
    // key security level HIGH. The state transition requires one of CRITICAL").
    if (
      lower.includes(CRITICAL_KEY_REQUIRED) ||
      (lower.includes('invalid public key security level') && lower.includes('critical'))
    ) {
      return {
        success: false,
        error: 'This action needs your CRITICAL key to authorize',
        errorCode: 'NEEDS_CRITICAL_KEY',
      };
    }
    if (isOncePerIdentityAlreadyClaimedError(error) || lower.includes('alreadyclaimed')) {
      return { success: false, error: 'This identity already claimed its starter YAPP', errorCode: 'ALREADY_CLAIMED' };
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
