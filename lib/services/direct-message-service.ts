import { getEvoSdk } from './evo-sdk-service'
import { stateTransitionService } from './state-transition-service'
import { identityService } from './identity-service'
import { dpnsService } from './dpns-service'
import { unifiedProfileService } from './unified-profile-service'
import type { DocumentWhereClause } from './sdk-helpers'
import {
  DirectMessage,
  Conversation
} from '../types'
import {
  encryptToBinary,
  decryptFromBinary,
  generateConversationId,
  getPublicKeyFromPrivate
} from '../message-encryption'
import { getPrivateKey } from '../secure-storage'
import { YAPPR_DM_CONTRACT_ID } from '../constants'
import bs58 from 'bs58'

/**
 * Direct Message Service for v3 contract
 *
 * Document types:
 * - conversationInvite: Inbox notification, one per conversation per direction
 * - directMessage: Lean message (10-byte conversationId, binary encryptedContent, max 5KB)
 * - readReceipt: User-owned read tracking (uses $updatedAt as last-read timestamp)
 *
 * v3 changes:
 * - readReceipt no longer has lastReadAt field - use $updatedAt instead
 * - readReceipt has single index (userConversation) - query other party directly
 * - encryptedContent max reduced to 5000 bytes
 */
class DirectMessageService {
  private contractId = YAPPR_DM_CONTRACT_ID
  private publicKeyCache = new Map<string, Uint8Array>()

  /**
   * Send a direct message
   */
  async sendMessage(
    senderId: string,
    recipientId: string,
    content: string
  ): Promise<{ success: boolean; message?: DirectMessage; error?: string }> {
    try {
      // 1. Generate 10-byte conversation ID (10 bytes >= platform's byte detection threshold)
      const conversationIdBytes = await generateConversationId(senderId, recipientId)
      const conversationId = bs58.encode(Buffer.from(conversationIdBytes))

      // 2. Get sender's private key
      const privateKey = getPrivateKey(senderId)
      if (!privateKey) {
        return { success: false, error: 'Please log in again to send messages' }
      }

      // 3. Get recipient's public key (from identity or their invite)
      const recipientPubKey = await this.getPublicKeyForUser(recipientId, senderId)
      if (!recipientPubKey) {
        return {
          success: false,
          error: 'Could not find recipient\'s public key for encryption'
        }
      }

      // 4. Check if we need to create a conversation invite
      const existingInvite = await this.getMyInviteToRecipient(senderId, recipientId)

      if (!existingInvite) {
        // Create conversation invite
        const senderPubKey = getPublicKeyFromPrivate(privateKey)

        // Check if sender's identity uses hash160 (no full pubkey on-chain)
        const needsPubKeyInInvite = await this.identityUsesHash160(senderId)

        // All byteArray fields >= 10 bytes, so Array.from works for platform's byte detection
        const conversationIdArray = Array.from(conversationIdBytes)
        const senderPubKeyArray = needsPubKeyInInvite ? Array.from(senderPubKey) : undefined

        const inviteResult = await stateTransitionService.createDocument(
          this.contractId,
          'conversationInvite',
          senderId,
          {
            // recipientId has contentMediaType identifier - pass as base58 string
            recipientId,
            // conversationId as array (10 bytes >= platform threshold)
            conversationId: conversationIdArray,
            // senderPubKey as array (33 bytes)
            ...(senderPubKeyArray ? { senderPubKey: senderPubKeyArray } : {})
          }
        )

        if (!inviteResult.success) {
          console.warn('Failed to create conversation invite:', inviteResult.error)
          // Continue anyway - message is more important
        }
      }

      // 5. Encrypt the message to binary format
      const encryptedContent = await encryptToBinary(content, privateKey, recipientPubKey)

      // 6. Create directMessage document
      // All byteArray fields >= 10 bytes, so Array.from works for platform's byte detection
      const conversationIdArray = Array.from(conversationIdBytes)
      const encryptedContentArray = Array.from(encryptedContent)

      const result = await stateTransitionService.createDocument(
        this.contractId,
        'directMessage',
        senderId,
        {
          conversationId: conversationIdArray,
          encryptedContent: encryptedContentArray
        }
      )

      if (!result.success) {
        return { success: false, error: result.error }
      }

      return {
        success: true,
        message: {
          id: (result.document?.$id as string) || `temp-${Date.now()}`,
          senderId,
          recipientId,
          conversationId,
          content,
          createdAt: new Date()
        }
      }
    } catch (error) {
      console.error('Error sending message:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to send message'
      }
    }
  }

  /**
   * Get all conversations for a user
   */
  async getConversations(userId: string): Promise<Conversation[]> {
    try {
      const sdk = await getEvoSdk()

      // 1. Get invites where I'm the recipient (inbox)
      // Uses 'inbox' index: [recipientId, $createdAt]
      const receivedInvitesResponse = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'conversationInvite',
        where: [['recipientId', '==', userId]],
        orderBy: [['$createdAt', 'desc']],
        limit: 100
      })

      // 2. Get invites I sent
      // Uses 'senderAndRecipient' index: [$ownerId, recipientId]
      const sentInvitesResponse = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'conversationInvite',
        where: [['$ownerId', '==', userId]],
        orderBy: [['recipientId', 'asc']],
        limit: 100
      })

      const receivedInvites = this.extractDocuments(receivedInvitesResponse)
      const sentInvites = this.extractDocuments(sentInvitesResponse)

      // 3. Build conversation map from invites
      const conversationMap = new Map<string, {
        participantId: string
        invites: Record<string, unknown>[]
      }>()

      // Process received invites (they sent to me)
      for (const invite of receivedInvites) {
        const inviteData = invite.data as Record<string, unknown> | undefined
        const convIdBytes = this.extractByteArray(invite.conversationId || inviteData?.conversationId)
        const convId = bs58.encode(Buffer.from(convIdBytes))
        const senderId = invite.$ownerId

        const existingConv = conversationMap.get(convId)
        if (!existingConv) {
          conversationMap.set(convId, {
            participantId: senderId as string,
            invites: [invite]
          })
        } else {
          existingConv.invites.push(invite)
        }
      }

      // Process sent invites (I sent to them)
      for (const invite of sentInvites) {
        const inviteData = invite.data as Record<string, unknown> | undefined
        const convIdBytes = this.extractByteArray(invite.conversationId || inviteData?.conversationId)
        const convId = bs58.encode(Buffer.from(convIdBytes))
        const recipientIdBytes = this.extractByteArray(invite.recipientId || inviteData?.recipientId)
        const recipientId = bs58.encode(Buffer.from(recipientIdBytes))

        const existingSentConv = conversationMap.get(convId)
        if (!existingSentConv) {
          conversationMap.set(convId, {
            participantId: recipientId,
            invites: [invite]
          })
        } else {
          existingSentConv.invites.push(invite)
        }
      }

      // 4. For each conversation, get latest message and read receipt
      const conversations: Conversation[] = []

      for (const [convId, data] of Array.from(conversationMap.entries())) {
        try {
          // Get messages (fetch once, use for both latest and unread count)
          const allMessages = await this.getConversationMessagesRaw(convId, 100)
          const latestDoc = allMessages[allMessages.length - 1] // Messages are ordered asc

          // Get my read receipt
          const myReceipt = await this.getMyReadReceipt(userId, convId)

          // Count unread messages (v3: use $updatedAt as last-read timestamp)
          const lastReadAt = (myReceipt?.$updatedAt as number) || 0
          const unreadCount = allMessages.filter(
            m => m.$ownerId !== userId && (m.$createdAt as number) > lastReadAt
          ).length

          // Get participant username and display name
          let participantUsername: string | undefined
          let participantDisplayName: string | undefined
          try {
            participantUsername = await dpnsService.resolveUsername(data.participantId) || undefined
          } catch {
            // Ignore DPNS errors
          }
          try {
            const profile = await unifiedProfileService.getProfile(data.participantId)
            participantDisplayName = profile?.displayName
          } catch {
            // Ignore profile errors
          }

          // Decrypt latest message for preview
          let lastMessage: DirectMessage | null = null
          if (latestDoc) {
            try {
              lastMessage = await this.decryptMessage(latestDoc, userId, data.participantId)
            } catch {
              lastMessage = {
                id: latestDoc.$id as string,
                senderId: latestDoc.$ownerId as string,
                recipientId: latestDoc.$ownerId === userId ? data.participantId : userId,
                conversationId: convId,
                content: '[Encrypted message]',
                createdAt: new Date(latestDoc.$createdAt as number)
              }
            }
          }

          conversations.push({
            id: convId,
            participantId: data.participantId,
            participantUsername,
            participantDisplayName,
            lastMessage,
            unreadCount,
            updatedAt: latestDoc ? new Date(latestDoc.$createdAt as number) : new Date()
          })
        } catch (err) {
          console.error(`Error processing conversation ${convId}:`, err)
        }
      }

      // Sort by most recent
      return conversations.sort((a, b) =>
        b.updatedAt.getTime() - a.updatedAt.getTime()
      )
    } catch (error) {
      console.error('Error getting conversations:', error)
      return []
    }
  }

  /**
   * Get messages for a conversation
   */
  async getConversationMessages(
    conversationId: string,
    userId: string,
    participantId?: string
  ): Promise<DirectMessage[]> {
    try {
      const rawMessages = await this.getConversationMessagesRaw(conversationId, 100)

      // If participantId not provided, try to derive from conversation
      let otherPartyId = participantId
      if (!otherPartyId) {
        // Find a message from someone other than userId
        const otherMsg = rawMessages.find(m => m.$ownerId !== userId)
        otherPartyId = otherMsg?.$ownerId as string | undefined
      }

      // Decrypt each message
      const messages: DirectMessage[] = []
      for (const doc of rawMessages) {
        try {
          const msg = await this.decryptMessage(doc, userId, otherPartyId || '')
          if (msg) messages.push(msg)
        } catch (err) {
          console.error('Error decrypting message:', err)
          messages.push({
            id: doc.$id as string,
            senderId: doc.$ownerId as string,
            recipientId: doc.$ownerId === userId ? (otherPartyId || '') : userId,
            conversationId,
            content: '[Could not decrypt message]',
            createdAt: new Date(doc.$createdAt as number)
          })
        }
      }

      return messages
    } catch (error) {
      console.error('Error getting conversation messages:', error)
      return []
    }
  }

  /**
   * Poll for new messages - queries only messages newer than sinceTimestamp
   * Returns only the NEW messages (already decrypted)
   */
  async pollNewMessages(
    conversationId: string,
    sinceTimestamp: number,
    userId: string,
    participantId: string
  ): Promise<DirectMessage[]> {
    try {
      // Query only messages newer than sinceTimestamp (uses index efficiently)
      const newDocs = await this.getConversationMessagesRaw(conversationId, 100, sinceTimestamp)
      if (newDocs.length === 0) return []

      // Decrypt the new messages (public key is cached after first call)
      const messages: DirectMessage[] = []
      for (const doc of newDocs) {
        try {
          const msg = await this.decryptMessage(doc, userId, participantId)
          if (msg) messages.push(msg)
        } catch {
          // Skip failed decryption
        }
      }
      return messages
    } catch (error) {
      console.error('Error polling messages:', error)
      return []
    }
  }

  /**
   * Get raw message documents for a conversation
   * @param sinceTimestamp - If provided, only fetch messages with $createdAt > sinceTimestamp
   */
  private async getConversationMessagesRaw(
    conversationId: string,
    limit: number = 100,
    sinceTimestamp?: number
  ): Promise<Record<string, unknown>[]> {
    try {
      const sdk = await getEvoSdk()
      // Decode base58 conversationId, then encode as base64 for SDK
      const convIdBytes = bs58.decode(conversationId)
      const convIdBase64 = Buffer.from(convIdBytes).toString('base64')

      // Build where clause - add timestamp filter if provided
      const where: DocumentWhereClause[] = [['conversationId', '==', convIdBase64]]
      if (sinceTimestamp) {
        where.push(['$createdAt', '>', sinceTimestamp])
      }

      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'directMessage',
        where,
        orderBy: [['$createdAt', 'asc']],
        limit
      })

      return this.extractDocuments(response)
    } catch (error) {
      console.error('Error getting raw messages:', error)
      return []
    }
  }

  /**
   * Mark conversation as read
   * v3: No lastReadAt field - platform sets $updatedAt automatically on update
   */
  async markAsRead(conversationId: string, userId: string): Promise<void> {
    try {
      const existingReceipt = await this.getMyReadReceipt(userId, conversationId)
      const convIdBytes = bs58.decode(conversationId)
      const conversationIdArray = Array.from(convIdBytes)

      if (existingReceipt) {
        // Update existing receipt - platform will set $updatedAt
        await stateTransitionService.updateDocument(
          this.contractId,
          'readReceipt',
          existingReceipt.$id,
          userId,
          { conversationId: conversationIdArray },
          existingReceipt.$revision || 0
        )
      } else {
        // Create new receipt - platform will set $createdAt and $updatedAt
        await stateTransitionService.createDocument(
          this.contractId,
          'readReceipt',
          userId,
          { conversationId: conversationIdArray }
        )
      }
    } catch (error) {
      console.error('Error marking as read:', error)
    }
  }

  /**
   * Start or get a conversation with another user
   */
  async getOrCreateConversation(
    userId: string,
    participantId: string
  ): Promise<{ conversationId: string; isNew: boolean }> {
    const conversationIdBytes = await generateConversationId(userId, participantId)
    const conversationId = bs58.encode(Buffer.from(conversationIdBytes))

    // Check if conversation exists by looking for invites
    const invite = await this.getMyInviteToRecipient(userId, participantId)
    const reverseInvite = await this.getMyInviteToRecipient(participantId, userId)

    return {
      conversationId,
      isNew: !invite && !reverseInvite
    }
  }

  // ==================== Helper Methods ====================

  /**
   * Decrypt a message document
   */
  private async decryptMessage(
    doc: Record<string, unknown>,
    currentUserId: string,
    otherPartyId: string
  ): Promise<DirectMessage | null> {
    const privateKey = getPrivateKey(currentUserId)
    if (!privateKey) {
      console.warn('No private key available for decryption')
      return null
    }

    const senderId = doc.$ownerId as string
    const isSender = senderId === currentUserId

    // Get the other party's public key
    const otherPubKey = await this.getPublicKeyForUser(
      isSender ? otherPartyId : senderId,
      currentUserId
    )

    if (!otherPubKey) {
      console.warn('Could not get public key for decryption')
      return null
    }

    // Extract encrypted content
    const docData = doc.data as Record<string, unknown> | undefined
    const encryptedContent = this.extractByteArray(
      doc.encryptedContent || docData?.encryptedContent
    )
    const convIdBytes = this.extractByteArray(
      doc.conversationId || docData?.conversationId
    )
    const conversationId = bs58.encode(Buffer.from(convIdBytes))

    // Decrypt
    const content = await decryptFromBinary(
      encryptedContent,
      privateKey,
      otherPubKey
    )

    return {
      id: doc.$id as string,
      senderId,
      recipientId: isSender ? otherPartyId : currentUserId,
      conversationId,
      content,
      createdAt: new Date(doc.$createdAt as number)
    }
  }

  /**
   * Get public key for a user (cached to avoid repeated lookups)
   * First checks cache, then invite, then falls back to identity
   */
  private async getPublicKeyForUser(
    userId: string,
    currentUserId: string
  ): Promise<Uint8Array | null> {
    // Check cache first
    const cached = this.publicKeyCache.get(userId)
    if (cached) return cached

    // Check if they sent us an invite with their public key
    const theirInvite = await this.getInviteFromUser(userId, currentUserId)
    if (theirInvite) {
      const inviteData = theirInvite.data as Record<string, unknown> | undefined
      const senderPubKey = this.extractByteArray(
        theirInvite.senderPubKey || inviteData?.senderPubKey
      )
      if (senderPubKey && senderPubKey.length === 33) {
        this.publicKeyCache.set(userId, senderPubKey)
        return senderPubKey
      }
    }

    // Fall back to identity
    const pubKey = await this.getPublicKeyFromIdentity(userId)
    if (pubKey) {
      this.publicKeyCache.set(userId, pubKey)
    }
    return pubKey
  }

  /**
   * Get public key from identity
   */
  private async getPublicKeyFromIdentity(userId: string): Promise<Uint8Array | null> {
    try {
      const identity = await identityService.getIdentity(userId)
      if (!identity) return null

      const publicKeys = identity.publicKeys
      if (!publicKeys || publicKeys.length === 0) return null

      // Find the authentication HIGH key (type 0, securityLevel 2, purpose 0)
      interface PublicKeyInfo { type: number; securityLevel: number; purpose: number }
      const authHighKey = publicKeys.find((pk: PublicKeyInfo) =>
        pk.type === 0 && pk.securityLevel === 2 && pk.purpose === 0
      )
      const fallbackKey = !authHighKey ? publicKeys.find((pk: PublicKeyInfo) =>
        pk.type === 0 && pk.securityLevel === 2
      ) : null

      const ecdsaKey = authHighKey || fallbackKey
      if (!ecdsaKey) return null

      return this.extractPublicKeyBytes(ecdsaKey)
    } catch (error) {
      console.error('Error getting public key from identity:', error)
      return null
    }
  }

  /**
   * Check if identity uses hash160 (no full public key on-chain)
   */
  private async identityUsesHash160(userId: string): Promise<boolean> {
    try {
      const identity = await identityService.getIdentity(userId)
      if (!identity) return false

      const publicKeys = identity.publicKeys
      if (!publicKeys || publicKeys.length === 0) return false

      // Check if all HIGH security keys are type 2 (ECDSA_HASH160)
      interface PublicKeySecInfo { type: number; securityLevel: number }
      const highKeys = publicKeys.filter((pk: PublicKeySecInfo) => pk.securityLevel === 2)
      const hasType0 = highKeys.some((pk: PublicKeySecInfo) => pk.type === 0)

      return !hasType0  // Uses hash160 if no type 0 keys at HIGH security level
    } catch {
      return false
    }
  }

  /**
   * Get my invite to a recipient
   */
  private async getMyInviteToRecipient(
    senderId: string,
    recipientId: string
  ): Promise<Record<string, unknown> | null> {
    try {
      const sdk = await getEvoSdk()

      // recipientId has contentMediaType "application/x.dash.dpp.identifier" so use base58 string
      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'conversationInvite',
        where: [
          ['$ownerId', '==', senderId],
          ['recipientId', '==', recipientId]
        ],
        limit: 1
      })

      const docs = this.extractDocuments(response)
      return docs[0] || null
    } catch {
      return null
    }
  }

  /**
   * Get invite from a user (they sent to me)
   */
  private async getInviteFromUser(
    senderId: string,
    recipientId: string
  ): Promise<Record<string, unknown> | null> {
    return this.getMyInviteToRecipient(senderId, recipientId)
  }

  /**
   * Get a user's read receipt for a conversation
   * v3: returns $updatedAt as the last-read timestamp
   */
  private async getReadReceiptForUser(
    userId: string,
    conversationId: string
  ): Promise<{ lastReadAt: number } | null> {
    try {
      const sdk = await getEvoSdk()
      // Decode base58 conversationId, then encode as base64 for SDK
      const convIdBytes = bs58.decode(conversationId)
      const convIdBase64 = Buffer.from(convIdBytes).toString('base64')

      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'readReceipt',
        where: [
          ['$ownerId', '==', userId],
          ['conversationId', '==', convIdBase64]
        ],
        limit: 1
      })

      const docs = this.extractDocuments(response)
      if (docs.length === 0) return null

      const doc = docs[0]
      // v3: use $updatedAt as last-read timestamp
      return {
        lastReadAt: (doc.$updatedAt as number) || 0
      }
    } catch {
      return null
    }
  }

  /**
   * Get my read receipt for a conversation (includes full doc for updates)
   * v3: No lastReadAt field - use $updatedAt as last-read timestamp
   */
  private async getMyReadReceipt(
    userId: string,
    conversationId: string
  ): Promise<{ $id: string; $ownerId: string; $createdAt: number; $updatedAt: number; $revision?: number; conversationId: string } | null> {
    try {
      const sdk = await getEvoSdk()
      const convIdBytes = bs58.decode(conversationId)
      const convIdBase64 = Buffer.from(convIdBytes).toString('base64')

      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'readReceipt',
        where: [
          ['$ownerId', '==', userId],
          ['conversationId', '==', convIdBase64]
        ],
        limit: 1
      })

      const docs = this.extractDocuments(response)
      if (docs.length === 0) return null

      const doc = docs[0]
      return {
        $id: doc.$id as string,
        $ownerId: doc.$ownerId as string,
        $createdAt: doc.$createdAt as number,
        $updatedAt: doc.$updatedAt as number,
        $revision: doc.$revision as number,
        conversationId
      }
    } catch {
      return null
    }
  }

  /**
   * Get when the other party last read the conversation
   * Returns the timestamp (ms) or null if they haven't read
   */
  async getParticipantLastRead(
    conversationId: string,
    participantId: string
  ): Promise<number | null> {
    const receipt = await this.getReadReceiptForUser(participantId, conversationId)
    return receipt?.lastReadAt || null
  }

  /**
   * Extract documents from SDK response
   */
  private extractDocuments(response: unknown): Record<string, unknown>[] {
    if (response instanceof Map) {
      return Array.from(response.values())
        .filter(Boolean)
        .map((doc: unknown) => {
          const d = doc as { toJSON?: () => unknown }
          return (typeof d.toJSON === 'function' ? d.toJSON() : doc) as Record<string, unknown>
        })
    }
    if (Array.isArray(response)) {
      return response.map((doc: unknown) => {
        const d = doc as { toJSON?: () => unknown }
        return (typeof d.toJSON === 'function' ? d.toJSON() : doc) as Record<string, unknown>
      })
    }
    const respObj = response as { documents?: Record<string, unknown>[] }
    if (respObj?.documents) {
      return respObj.documents
    }
    return []
  }

  /**
   * Extract byte array from various formats
   */
  private extractByteArray(value: unknown): Uint8Array {
    if (!value) return new Uint8Array(0)
    if (value instanceof Uint8Array) return value
    if (Array.isArray(value)) return new Uint8Array(value)
    if (typeof value === 'string') {
      try {
        return bs58.decode(value)
      } catch {
        return new Uint8Array(Buffer.from(value, 'base64'))
      }
    }
    const typedValue = value as { buffer?: ArrayBuffer; byteLength?: number }
    if (typedValue.buffer && typedValue.byteLength !== undefined) {
      return new Uint8Array(value as ArrayBuffer)
    }
    return new Uint8Array(0)
  }

  /**
   * Extract public key bytes from identity public key object
   */
  private extractPublicKeyBytes(publicKey: unknown): Uint8Array {
    if (publicKey instanceof Uint8Array) return publicKey
    if (Array.isArray(publicKey)) return new Uint8Array(publicKey)

    if (publicKey && typeof publicKey === 'object') {
      const pkObj = publicKey as Record<string, unknown>
      // Try 'data' field (common in Dash Platform)
      if (pkObj.data) {
        if (Array.isArray(pkObj.data)) return new Uint8Array(pkObj.data)
        if (typeof pkObj.data === 'string') {
          try {
            return bs58.decode(pkObj.data)
          } catch {
            return new Uint8Array(Buffer.from(pkObj.data, 'base64'))
          }
        }
        if (pkObj.data instanceof Uint8Array) return pkObj.data
      }

      // Try 'publicKey' field
      if (pkObj.publicKey) {
        if (Array.isArray(pkObj.publicKey)) return new Uint8Array(pkObj.publicKey)
        if (typeof pkObj.publicKey === 'string') {
          try {
            return bs58.decode(pkObj.publicKey)
          } catch {
            return new Uint8Array(Buffer.from(pkObj.publicKey, 'base64'))
          }
        }
      }

      // Try 'key' field
      if (pkObj.key) {
        if (Array.isArray(pkObj.key)) return new Uint8Array(pkObj.key)
        if (typeof pkObj.key === 'string') {
          try {
            return bs58.decode(pkObj.key)
          } catch {
            return new Uint8Array(Buffer.from(pkObj.key, 'base64'))
          }
        }
      }
    }

    if (typeof publicKey === 'string') {
      try {
        return bs58.decode(publicKey)
      } catch {
        return new Uint8Array(Buffer.from(publicKey, 'base64'))
      }
    }

    throw new Error('Unknown public key format: ' + JSON.stringify(publicKey))
  }
}

// Singleton instance
export const directMessageService = new DirectMessageService()
