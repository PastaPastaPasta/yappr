/**
 * Pipelined executor for run-seeder.mjs — the throughput path for large runs.
 *
 * The default executor calls `documents.create()`, which broadcasts AND waits
 * for the transition's proof before returning (~2–6 s per op), so a run moves
 * at roughly one op per second per ten identities. The chain itself is not
 * the bottleneck: it accepts many transitions per block, and an identity may
 * have up to `MAX_MISSING_IDENTITY_REVISIONS` (24) transitions in flight as
 * long as they arrive in nonce order.
 *
 * This module builds each transition by hand (document → DocumentCreateTransition
 * → BatchTransition → signed StateTransition), assigns the identity-contract
 * nonce LOCALLY per actor (fetched once, then incremented), broadcasts without
 * waiting, and reconciles in the background by readback: stored doctypes by
 * id, indexOnly ones by entry existence. A failed reconcile re-syncs the
 * actor's nonce from the chain and lets the scheduler retry the op.
 *
 * Contract with runCorpus: `executeOp(op)` resolves with the ref record once
 * the op is KNOWN to be on chain (so dependents never reference a phantom),
 * and throws on permanent failure. Per-actor sequencing is preserved by the
 * scheduler; this module adds a per-actor in-flight window on top.
 */
import bs58 from 'bs58';
import {
  BatchTransition,
  BatchedTransition,
  DocumentCreateTransition,
  PrivateKey,
  TokenPaymentInfo,
} from '@dashevo/evo-sdk';
import {
  DUPLICATE_UNIQUE,
  NONCE_DESYNC,
  RETRYABLE,
  TRANSPORT_COLLAPSE,
  YAPP_TOKEN_POSITION,
  buildDocument,
  describeErr,
  randomEntropy,
  readback,
  sleep,
  wifFromHex,
} from './seed-lib.mjs';

const SEQUENCE_MASK = (1n << 40n) - 1n;
/** In-flight transitions per identity; the chain tolerates a 24-deep nonce gap, stay well inside it. */
export const DEFAULT_WINDOW = 8;
/** Readback poll cadence; SEED_RECONCILE_MS raises it to shed DAPI read load on big runs. */
const RECONCILE_MS = Number(process.env.SEED_RECONCILE_MS ?? 2_500);
const RECONCILE_POLLS = Math.max(6, Math.ceil(45_000 / RECONCILE_MS)); // ≥ ~45 s: several blocks
const BROADCAST_ATTEMPTS = 6;

/** Per-actor nonce state: fetched once, incremented locally, re-synced on any nonce error. */
class NonceTrack {
  constructor(handle, contractId, actor) {
    this.handle = handle; this.contractId = contractId; this.actor = actor;
    this.next = null; this.syncing = null;
  }
  async sync() {
    if (!this.syncing) {
      this.syncing = (async () => {
        const raw = await readback(this.handle, () => this.handle.sdk.wasm.getIdentityContractNonce(this.actor.ownerId, this.contractId));
        this.next = ((raw ?? 0n) & SEQUENCE_MASK) + 1n;
      })().finally(() => { this.syncing = null; });
    }
    return this.syncing;
  }
  async take() {
    if (this.next === null) await this.sync();
    const n = this.next; this.next += 1n; return n;
  }
}

/** A signed, ready-to-broadcast create transition for one document. */
function buildSignedCreate({ contractId, actor, docType, data, nonce, tokenCost, privateKey }) {
  const { document, id } = buildDocument({ contractId, docType, ownerId: actor.ownerId, data, entropy: randomEntropy() });
  const create = new DocumentCreateTransition({
    document,
    identityContractNonce: nonce,
    ...(tokenCost ? { tokenPaymentInfo: new TokenPaymentInfo({ tokenContractPosition: YAPP_TOKEN_POSITION, maximumTokenCost: BigInt(tokenCost) }) } : {}),
  });
  const batch = BatchTransition.fromBatchedTransitions([new BatchedTransition(create.toDocumentTransition())], actor.ownerId, 0);
  const st = batch.toStateTransition();
  st.setIdentityContractNonce(nonce);
  st.sign(privateKey, actor.identityKey);
  return { st, id };
}

export function buildPipelinedExecutor({ handle, contractId, actors, ledger, progressRefs, topology, planOp, entryExists, window = DEFAULT_WINDOW, log = () => {} }) {
  const resolveRef = (ref) => {
    const record = progressRefs.get(ref);
    if (!record) throw new Error(`ref "${ref}" not materialized (checkpoint out of sync)`);
    return record;
  };
  const tracks = new Map();
  const keys = new Map();
  const inflight = new Map(); // actor idx -> count
  const trackFor = (actor) => { if (!tracks.has(actor.personaIdx)) tracks.set(actor.personaIdx, new NonceTrack(handle, contractId, actor)); return tracks.get(actor.personaIdx); };
  const keyFor = (actor) => {
    if (!keys.has(actor.personaIdx)) {
      const entry = ledger.identities.find((e) => e.personaIdx === actor.personaIdx);
      const auth = entry.identityKeys.find((k) => k.keyId === 1);
      keys.set(actor.personaIdx, PrivateKey.fromWIF(wifFromHex(auth.privateKeyHex)));
    }
    return keys.get(actor.personaIdx);
  };
  const waitWindow = async (idx) => { while ((inflight.get(idx) ?? 0) >= window) await sleep(50); inflight.set(idx, (inflight.get(idx) ?? 0) + 1); };
  const releaseWindow = (idx) => inflight.set(idx, Math.max(0, (inflight.get(idx) ?? 1) - 1));

  const acceptedProbe = (plan, actor, id) => plan.existenceKey
    ? () => entryExists(handle, contractId, plan.docType, plan.existenceKey.keyField, plan.existenceKey.keyValue, actor.ownerId)
    : async () => (await readback(handle, () => handle.sdk.documents.get(contractId, plan.docType, id))) != null;

  /** Broadcast one prepared create; returns once the chain shows it (or throws). */
  async function submit({ actor, docType, data, tokenCost, existenceKeyPlan, duplicateIsSuccess }) {
    const track = trackFor(actor);
    let lastError = null;
    for (let attempt = 1; attempt <= BROADCAST_ATTEMPTS; attempt++) {
      const nonce = await track.take();
      const { st, id } = buildSignedCreate({ contractId, actor, docType, data, nonce, tokenCost, privateKey: keyFor(actor) });
      const accepted = acceptedProbe(existenceKeyPlan, actor, id);
      try {
        await handle.sdk.stateTransitions.broadcastStateTransition(st);
      } catch (e) {
        lastError = e;
        const text = describeErr(e);
        if (DUPLICATE_UNIQUE.test(text) && duplicateIsSuccess) return { id, duplicate: true };
        if (NONCE_DESYNC.test(text)) { await track.sync(); continue; }
        if (TRANSPORT_COLLAPSE.test(text)) { try { await handle.reconnect(text); } catch { /* retry rebuilds */ } await track.sync(); continue; }
        if (RETRYABLE.test(text)) { await sleep(2_000 * attempt + Math.random() * 1_000); await track.sync(); continue; }
        if (/code=4\d{4}/.test(text) || /consensus/i.test(text)) throw e; // Platform said no
        await sleep(1_000 * attempt); await track.sync(); continue;
      }
      // Broadcast accepted by the mempool: reconcile by readback in the background of this promise.
      for (let poll = 0; poll < RECONCILE_POLLS; poll++) {
        await sleep(RECONCILE_MS);
        try { if (await accepted()) return { id }; } catch (readError) { lastError = readError; }
      }
      // Not visible after ~30 s: the transition was dropped (or the nonce chain broke). Re-sync and retry.
      lastError = lastError ?? new Error('broadcast accepted but never became visible');
      await track.sync();
    }
    throw lastError ?? new Error('pipelined submit failed');
  }

  return async function executeOp(op) {
    const actor = actors.get(op.author);
    const plan = planOp(op, { actors, resolveRef, topology });
    await waitWindow(actor.personaIdx);
    try {
      const { id } = await submit({ actor, docType: plan.docType, data: plan.data, tokenCost: plan.tokenCost, existenceKeyPlan: plan, duplicateIsSuccess: ['like', 'likeReply', 'follow', 'bookmark', 'repost'].includes(op.type) });
      if (plan.companion) {
        // v6 beat: a second transition after the like is on chain (batch cap is 1).
        try {
          await submit({ actor, docType: plan.companion.docType, data: plan.companion.data, tokenCost: undefined, existenceKeyPlan: plan.companion, duplicateIsSuccess: true });
        } catch (e) {
          log(`line ${op.line}: beat companion failed (${describeErr(e).slice(0, 120)}) — like stands, tag under-counts today`);
        }
      }
      return plan.refRecord ? plan.refRecord(id) : null;
    } finally {
      releaseWindow(actor.personaIdx);
    }
  };
}
