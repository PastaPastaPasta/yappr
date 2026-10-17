/**
 * `isRetriedRead` against the real evo-sdk facades (no connection needed): no
 * write may ever be taken for a read and repeated, since one whose result proof
 * failed may already have landed.
 */
import { describe, expect, it } from 'vitest'
import { EvoSDK } from '@dashevo/evo-sdk'
import { SDK_FACADES } from './sdk-facades'
import { isRetriedRead } from './sdk-read-retry'

/** Every method on the evo-sdk 5.0.0-rc.3 facades that signs, broadcasts or waits on a transition. */
const WRITES = [
  'documents.create', 'documents.contestFundToJoin', 'documents.replace', 'documents.delete', 'documents.transfer',
  'documents.purchase', 'documents.setPrice',
  'identities.create', 'identities.topUp', 'identities.creditTransfer', 'identities.creditWithdrawal', 'identities.update',
  'identities.updateKeyLimits',
  'contracts.publish', 'contracts.update', 'contracts.banUser', 'contracts.unbanUser', 'contracts.suspendUser',
  'contracts.unsuspendUser', 'contracts.warnUser', 'contracts.clearUserWarnings', 'contracts.moderatorDeleteDocument',
  'contracts.moderatorDeleteSettledDocument', 'contracts.moderatorApproveTeamAction', 'contracts.moderatorRestoreDocument',
  'contracts.moderatorChangeDocumentFields', 'contracts.claimFees',
  'dpns.registerName',
  'tokens.mint', 'tokens.burn', 'tokens.transfer', 'tokens.freeze', 'tokens.unfreeze', 'tokens.destroyFrozen',
  'tokens.emergencyAction', 'tokens.setPrice', 'tokens.directPurchase', 'tokens.claim', 'tokens.configUpdate',
  'voting.masternodeVote',
  'addresses.transfer', 'addresses.topUpIdentity', 'addresses.withdraw', 'addresses.transferFromIdentity',
  'addresses.fundFromAssetLock', 'addresses.createIdentity',
  'stateTransitions.broadcastStateTransition', 'stateTransitions.waitForResponse', 'stateTransitions.broadcastAndWait',
  'stateTransitions.waitForAffectedState', 'stateTransitions.broadcastAndWaitForAffectedState',
  'stateTransitions.waitForStateTransitionResult',
]

function methodsOf(facade: object): string[] {
  const prototype = Object.getPrototypeOf(facade) as object
  return Object.getOwnPropertyNames(prototype).filter((name) => name !== 'constructor' && typeof (facade as Record<string, unknown>)[name] === 'function')
}

describe('isRetriedRead on the real evo-sdk facades', () => {
  const sdk = new EvoSDK({ network: 'testnet' })

  it('never takes a write for a read', () => {
    const retried = SDK_FACADES.flatMap((facadeName) => {
      const facade = sdk[facadeName] as object
      return methodsOf(facade).filter((name) => isRetriedRead(facade, facadeName, name)).map((name) => `${facadeName}.${name}`)
    })
    expect(retried.filter((name) => WRITES.includes(name))).toEqual([])
  })

  it('knows every write listed here still exists, so the list cannot go stale unnoticed', () => {
    const all = new Set(SDK_FACADES.flatMap((facadeName) => methodsOf(sdk[facadeName] as object).map((name) => `${facadeName}.${name}`)))
    expect(WRITES.filter((name) => !all.has(name))).toEqual([])
  })

  it('takes the proved reads the app leans on for reads', () => {
    for (const name of ['documents.get', 'documents.query', 'identities.fetch', 'identities.balance', 'identities.nonce', 'identities.contractNonce', 'contracts.fetch', 'dpns.resolveName']) {
      const [facadeName, method] = name.split('.') as [(typeof SDK_FACADES)[number], string]
      expect(isRetriedRead(sdk[facadeName] as object, facadeName, method), name).toBe(true)
    }
  })
})
