import { ChosenWriteNotSentError } from './identity-nonce'
import type { EvoSDK } from '@dashevo/evo-sdk'
import {
  BatchTransition, BatchedTransition, ContractFeeClaim, ContractUserModeration,
  Document, DocumentDeleteTransition, DocumentReplaceTransition, PrivateKey, PlatformVersion, Identifier,
  TokenBaseTransition, TokenClaimTransition, TokenDestroyFrozenFundsTransition,
  TokenDirectPurchaseTransition, TokenFreezeTransition, TokenTransferTransition,
  TokenTransition, TokenUnFreezeTransition, VerifiedContractFeeClaim,
  VerifiedContractTeamActionSignature, VerifiedDocuments, VerifiedContractModerationListStatuses,
  VerifiedContractDocumentRemoval, VerifiedTokenActionWithDocument, VerifiedTokenGroupActionWithDocument,
  VerifiedTokenBalance, VerifiedTokenIdentitiesBalances, VerifiedTokenIdentityInfo,
  VerifiedTokenGroupActionWithTokenIdentityInfo,
  type ContractUserModerationTransitionOptions, type ContractModerationReason, type IdentifierLike, type IdentityPublicKey,
  type StateTransition, type StateTransitionProofResultType,
} from '@dashevo/wasm-sdk'

type Documents = EvoSDK['documents']
type Tokens = EvoSDK['tokens']
type Contracts = EvoSDK['contracts']

/** Writes with an explicit nonce when a wallet or a dropped create still owns the next one. */
export function chosenNonceWrites(sdk: EvoSDK, ownerId: string, nonce: bigint, wif: string, identityKey: IdentityPublicKey, assertLive?: () => void) {
  let broadcastStarted = false
  function unsent<A extends unknown[], R>(operation: (...args: A) => Promise<R>) {
    return async (...args: A): Promise<R> => {
      try { return await operation(...args) }
      catch (error) {
        if (!broadcastStarted) throw new ChosenWriteNotSentError(error)
        throw error
      }
    }
  }

  async function prepare(contractId: IdentifierLike) {
    const contract = await sdk.contracts.fetch(contractId)
    if (!contract) throw new Error('This item is no longer available.')
    await sdk.contracts.addKnown(contract)
    return contract
  }

  async function send(transition: StateTransition, strict = false): Promise<StateTransitionProofResultType> {
    const privateKey = PrivateKey.fromWIF(wif)
    try {
      assertLive?.()
      transition.sign(privateKey, identityKey)
      broadcastStarted = true
      return await (strict ? sdk.stateTransitions.broadcastAndWait(transition) : sdk.stateTransitions.broadcastAndWaitForAffectedState(transition))
    } finally {
      privateKey.free()
      transition.free()
    }
  }

  function batch(transition: BatchedTransition): StateTransition {
    const stateTransition = BatchTransition.fromBatchedTransitions([transition], ownerId, 0).toStateTransition()
    stateTransition.setIdentityContractNonce(nonce)
    return stateTransition
  }

  async function tokenBase(contractId: Parameters<Tokens['calculateId']>[0], position: number): Promise<TokenBaseTransition> {
    await prepare(contractId)
    return new TokenBaseTransition({
      identityContractNonce: nonce,
      dataContractId: contractId,
      tokenContractPosition: position,
      tokenId: await sdk.tokens.calculateId(contractId, position),
    })
  }

  async function token(transition: ConstructorParameters<typeof TokenTransition>[0], action: 'transfer' | 'purchase' | 'claim' | 'freeze' | 'unfreeze' | 'destroy'): Promise<void> {
    const result = await send(batch(new BatchedTransition(new TokenTransition(transition))), action === 'claim' || action === 'destroy')
    requireTokenResult(result, action)
  }

  async function moderate(options: Omit<ContractUserModerationTransitionOptions, 'ownerId' | 'identityContractNonce'>) {
    await prepare(options.dataContractId)
    return send(new ContractUserModeration({ ...options, ownerId, identityContractNonce: nonce }).toStateTransition())
  }

  const userAction = unsent(async (action: ContractUserModerationTransitionOptions['action'], options: Parameters<Contracts['unbanUser']>[0] & { reason?: ContractModerationReason; until?: bigint }) => {
    const result = await moderate({ action, dataContractId: options.contractId, identityId: options.identityId, ...(options.until === undefined ? {} : { until: options.until }), ...(options.reason === undefined ? {} : { reason: options.reason }) })
    if (!(result instanceof VerifiedContractModerationListStatuses)) throw unverifiedResult()
  })

  return {
    documents: {
      deleteByValues: unsent(async (document: Document): Promise<void> => {
        await prepare(document.dataContractId)
        // The WASM constructor exposes delete-by-id only; the index-only wire
        // kind carries the full tuple, including its committed creation time.
        const transition = new DocumentDeleteTransition({ document, identityContractNonce: nonce })
        const encoded = BatchTransition.fromStateTransition(batch(new BatchedTransition(transition.toDocumentTransition()))).toObject()
        encoded.transitions = encoded.transitions.map(base => ({
          ...document.properties,
          ...base,
          $action: 'indexOnlyDelete',
          ...(document.createdAt === undefined ? {} : { $createdAt: document.createdAt }),
        }))
        const result = await send(BatchTransition.fromObject(encoded).toStateTransition())
        requireDocument(result, document.id.toBase58(), true)
      }),
      replace: unsent(async (options: Parameters<Documents['replace']>[0]): Promise<void> => {
        const revision = options.document.revision
        if (revision === undefined) throw new Error('This item could not be updated. Refresh the page and try again.')
        await prepare(options.document.dataContractId)
        const replace = new DocumentReplaceTransition({ document: options.document, identityContractNonce: nonce })
        replace.revision = revision
        const result = await send(batch(new BatchedTransition(replace.toDocumentTransition())), true)
        requireDocument(result, options.document.id.toBase58(), false)
      }),
      delete: unsent(async (options: Parameters<Documents['delete']>[0]): Promise<void> => {
        const target = options.document
        await prepare(target.dataContractId)
        const encoded = {
          $formatVersion: '0', $id: new Identifier(target.id).toBase58(),
          $ownerId: new Identifier(target.ownerId).toBase58(),
          $dataContractId: new Identifier(target.dataContractId).toBase58(),
          $type: target.documentTypeName, $revision: '1',
        }
        const document = target instanceof Document ? target : Document.fromJSON(encoded, PlatformVersion.current())
        const result = await send(batch(new BatchedTransition(new DocumentDeleteTransition({ document, identityContractNonce: nonce }).toDocumentTransition())), true)
        requireDocument(result, document.id.toBase58(), true)
      }),
    },
    tokens: {
      directPurchase: unsent(async (options: Parameters<Tokens['directPurchase']>[0]): Promise<void> => {
        await token(new TokenDirectPurchaseTransition({ base: await tokenBase(options.dataContractId, options.tokenPosition), tokenCount: options.amount, totalAgreedPrice: options.maxTotalCost }), 'purchase')
      }),
      transfer: unsent(async (options: Parameters<Tokens['transfer']>[0]): Promise<void> => {
        await token(new TokenTransferTransition({ base: await tokenBase(options.dataContractId, options.tokenPosition), recipientId: options.recipientId, amount: options.amount, publicNote: options.publicNote }), 'transfer')
      }),
      claim: unsent(async (options: Parameters<Tokens['claim']>[0]): Promise<void> => {
        await token(new TokenClaimTransition({ base: await tokenBase(options.dataContractId, options.tokenPosition), distributionType: options.distributionType, publicNote: options.publicNote }), 'claim')
      }),
      freeze: unsent(async (options: Parameters<Tokens['freeze']>[0]): Promise<void> => {
        await token(new TokenFreezeTransition({ base: await tokenBase(options.dataContractId, options.tokenPosition), identityToFreezeId: options.frozenIdentityId, publicNote: options.publicNote }), 'freeze')
      }),
      unfreeze: unsent(async (options: Parameters<Tokens['unfreeze']>[0]): Promise<void> => {
        await token(new TokenUnFreezeTransition({ base: await tokenBase(options.dataContractId, options.tokenPosition), frozenIdentityId: options.frozenIdentityId, publicNote: options.publicNote }), 'unfreeze')
      }),
      destroyFrozen: unsent(async (options: Parameters<Tokens['destroyFrozen']>[0]): Promise<void> => {
        await token(new TokenDestroyFrozenFundsTransition({ base: await tokenBase(options.dataContractId, options.tokenPosition), frozenIdentityId: options.frozenIdentityId, publicNote: options.publicNote }), 'destroy')
      }),
    },
    contracts: {
      banUser: (options: Parameters<Contracts['banUser']>[0]) => userAction('ban', options),
      unbanUser: (options: Parameters<Contracts['unbanUser']>[0]) => userAction('unban', options),
      suspendUser: (options: Parameters<Contracts['suspendUser']>[0]) => userAction('suspend', options),
      unsuspendUser: (options: Parameters<Contracts['unsuspendUser']>[0]) => userAction('unsuspend', options),
      warnUser: (options: Parameters<Contracts['warnUser']>[0]) => userAction('warn', options),
      clearUserWarnings: (options: Parameters<Contracts['clearUserWarnings']>[0]) => userAction('clearWarnings', options),
      moderatorDeleteDocument: unsent(async (options: Parameters<Contracts['moderatorDeleteDocument']>[0]): Promise<void> => {
        const result = await moderate({ action: 'deleteDocument', dataContractId: options.contractId, documentTypeName: options.documentTypeName, documentId: options.documentId, reason: options.reason })
        if (!(result instanceof VerifiedContractDocumentRemoval)) requireDocument(result, new Identifier(options.documentId).toBase58(), true)
      }),
      moderatorRestoreDocument: unsent(async (options: Parameters<Contracts['moderatorRestoreDocument']>[0]): Promise<void> => {
        const contract = await prepare(options.contractId)
        const result = await moderate({ action: 'restoreDocument', dataContractId: options.contractId, documentTypeName: options.documentTypeName, document: options.document.toBytes(contract, PlatformVersion.current()) })
        if (!(result instanceof VerifiedContractDocumentRemoval)) throw unverifiedResult()
      }),
      moderatorChangeDocumentFields: unsent(async (options: Parameters<Contracts['moderatorChangeDocumentFields']>[0]) => {
        const result = await moderate({ action: 'changeDocumentFields', dataContractId: options.contractId, documentTypeName: options.documentTypeName, documentId: options.documentId, fields: options.fields, reason: options.reason })
        const document = requireDocument(result, new Identifier(options.documentId).toBase58(), false)
        if (!document) throw unverifiedResult()
        return document
      }),
      moderatorDeleteSettledDocument: unsent(async (options: Parameters<Contracts['moderatorDeleteSettledDocument']>[0]) => {
        const result = await moderate({ action: 'deleteSettledDocument', dataContractId: options.contractId, documentTypeName: options.documentTypeName, documentId: options.documentId, reason: options.reason })
        if (!(result instanceof VerifiedContractTeamActionSignature)) throw unverifiedResult()
        return result
      }),
      moderatorApproveTeamAction: unsent(async (options: Parameters<Contracts['moderatorApproveTeamAction']>[0]) => {
        const result = await moderate({ action: 'approveTeamAction', dataContractId: options.contractId, actionId: options.actionId })
        if (!(result instanceof VerifiedContractTeamActionSignature) || result.actionId.toBase58() !== new Identifier(options.actionId).toBase58()) throw unverifiedResult()
        return result
      }),
      claimFees: unsent(async (options: Parameters<Contracts['claimFees']>[0]) => {
        await prepare(options.contractId)
        const result = await send(new ContractFeeClaim({ ownerId, dataContractId: options.contractId, identityContractNonce: nonce, pot: options.pot }).toStateTransition())
        if (!(result instanceof VerifiedContractFeeClaim)) throw unverifiedResult()
        return result
      }),
    },
  }
}

function unverifiedResult(): Error {
  const error = new Error('The network could not confirm this change. Check before trying again.')
  error.name = 'DriveProofError'
  return error
}

function requireDocument(result: StateTransitionProofResultType, id: string, deleted: boolean): Document | undefined {
  if (!(result instanceof VerifiedDocuments)) throw unverifiedResult()
  for (const [key, value] of result.documents as Map<unknown, unknown>) {
    const documentId = key instanceof Identifier ? key.toBase58() : String(key)
    if (documentId !== id) continue
    if (deleted && value === undefined) return undefined
    if (!deleted && value instanceof Document) return value
  }
  throw unverifiedResult()
}

function requireTokenResult(result: StateTransitionProofResultType, action: 'transfer' | 'purchase' | 'claim' | 'freeze' | 'unfreeze' | 'destroy'): void {
  if (result instanceof VerifiedTokenActionWithDocument) return
  if (result instanceof VerifiedTokenGroupActionWithDocument) {
    if (action !== 'claim' || result.document) return
    throw unverifiedResult()
  }
  if (action === 'transfer' && result instanceof VerifiedTokenIdentitiesBalances) return
  if (action === 'purchase' && result instanceof VerifiedTokenBalance) return
  if (action === 'freeze' || action === 'unfreeze') {
    if (result instanceof VerifiedTokenIdentityInfo) return
    if (result instanceof VerifiedTokenGroupActionWithTokenIdentityInfo && result.tokenInfo) return
  }
  throw unverifiedResult()
}
