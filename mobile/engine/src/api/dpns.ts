import { dpnsService } from '@/lib/services/dpns-service'
import { getPrivateKey } from '@/lib/secure-storage'
import { RpcError } from '../protocol/envelope'
import { requireViewer } from '../dto/hydrate'
import type { TicketStore, WriteResult } from '../writes/tickets'
import type { WriteTicket } from '../writes/types'
import type { DpnsAvailabilityDTO } from './dto'

interface RegisterArgs { label: string }

export function createDpnsModule(tickets: TicketStore) {
  tickets.register<RegisterArgs>('dpns.register', {
    persistArgs: true,
    async run({ label }): Promise<WriteResult> {
      const identityId = requireViewer('Registering a username')
      try {
        const privateKey = getPrivateKey(identityId)
        if (!privateKey) return { state: 'failed', error: new RpcError('Sign in with DashPay again to register a username.', 'NEEDS_WALLET') }
        const result = await dpnsService.registerUsername(label, identityId, privateKey)
        return result.success ? { state: 'confirmed' } : { state: 'failed', error: new Error('Registration was not accepted') }
      } catch (error) {
        return { state: 'failed', error }
      }
    },
  })
  return {
    async check(label: string): Promise<DpnsAvailabilityDTO> {
      const normalized = label.trim().toLowerCase().replace(/\.dash$/, '')
      const validation = await dpnsService.validateUsername(normalized)
      if (!validation.isValid) return { label: normalized, available: false, contested: validation.isContested, error: dpnsService.getUsernameValidationError(normalized) ?? 'That username is not valid' }
      const result = (await dpnsService.batchCheckAvailability([normalized])).get(normalized)
      return { label: normalized, available: result?.available === true, contested: result?.contested === true, ...(result?.error ? { error: result.error } : {}) }
    },
    async register(label: string): Promise<WriteTicket> {
      const normalized = label.trim().toLowerCase().replace(/\.dash$/, '')
      if (!normalized) throw new RpcError('Enter a username', 'BAD_REQUEST')
      return tickets.submit<RegisterArgs>({ op: 'dpns.register', args: { label: normalized }, target: { identityId: requireViewer('Registering a username') } })
    },
  }
}
