import { getEvoSdk } from './evo-sdk-service'
import { stateTransitionService } from './state-transition-service'
import { identityService } from './identity-service'
import { dpnsService } from './dpns-service'
import {
  DirectMessage,
  Conversation,
  ConversationInviteDocument,
  DirectMessageDocument,
  ReadReceiptDocument
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
 * Direct Message Service for v2.1 contract
 *
 * Document types:
 * - conversationInvite: Inbox notification, one per conversation per direction
 * - directMessage: Lean message (10-byte conversationId, binary encryptedContent)
 * - readReceipt: User-owned read tracking
 *
 * v2.1 changes: conversationId is now 10 bytes (was 8) to work around
 * platform bug where byteArrays < 10 bytes fail JSON deserialization.
 */
class DirectMessageService {
  private contractId = YAPPR_DM_CONTRACT_ID

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
          id: result.document?.$id || `temp-${Date.now()}`,
          senderId,
          recipientId,
          conversationId,
          content,
          createdAt: new Date()
        }
      }
    } catch (error: any) {
      console.error('Error sending message:', error)
      return {
        success: false,
        error: error?.message || 'Failed to send message'
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
      } as any)

      // 2. Get invites I sent
      // Uses 'senderAndRecipient' index: [$ownerId, recipientId]
      const sentInvitesResponse = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'conversationInvite',
        where: [['$ownerId', '==', userId]],
        orderBy: [['recipientId', 'asc']],
        limit: 100
      } as any)

      const receivedInvites = this.extractDocuments(receivedInvitesResponse)
      const sentInvites = this.extractDocuments(sentInvitesResponse)

      // 3. Build conversation map from invites
      const conversationMap = new Map<string, {
        participantId: string
        invites: any[]
      }>()

      // Process received invites (they sent to me)
      for (const invite of receivedInvites) {
        const convIdBytes = this.extractByteArray(invite.conversationId || invite.data?.conversationId)
        const convId = bs58.encode(Buffer.from(convIdBytes))
        const senderId = invite.$ownerId

        if (!conversationMap.has(convId)) {
          conversationMap.set(convId, {
            participantId: senderId,
            invites: [invite]
          })
        } else {
          conversationMap.get(convId)!.invites.push(invite)
        }
      }

      // Process sent invites (I sent to them)
      for (const invite of sentInvites) {
        const convIdBytes = this.extractByteArray(invite.conversationId || invite.data?.conversationId)
        const convId = bs58.encode(Buffer.from(convIdBytes))
        const recipientIdBytes = this.extractByteArray(invite.recipientId || invite.data?.recipientId)
        const recipientId = bs58.encode(Buffer.from(recipientIdBytes))

        if (!conversationMap.has(convId)) {
          conversationMap.set(convId, {
            participantId: recipientId,
            invites: [invite]
          })
        } else {
          conversationMap.get(convId)!.invites.push(invite)
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

          // Count unread messages
          const lastReadAt = myReceipt?.lastReadAt || 0
          const unreadCount = allMessages.filter(
            m => m.$ownerId !== userId && m.$createdAt > lastReadAt
          ).length

          // Get participant username
          let participantUsername: string | undefined
          try {
            participantUsername = await dpnsService.resolveUsername(data.participantId) || undefined
          } catch {
            // Ignore DPNS errors
          }

          // Decrypt latest message for preview
          let lastMessage: DirectMessage | null = null
          if (latestDoc) {
            try {
              lastMessage = await this.decryptMessage(latestDoc, userId, data.participantId)
            } catch {
              lastMessage = {
                id: latestDoc.$id,
                senderId: latestDoc.$ownerId,
                recipientId: latestDoc.$ownerId === userId ? data.participantId : userId,
                conversationId: convId,
                content: '[Encrypted message]',
                createdAt: new Date(latestDoc.$createdAt)
              }
            }
          }

          conversations.push({
            id: convId,
            participantId: data.participantId,
            participantUsername,
            lastMessage,
            unreadCount,
            updatedAt: latestDoc ? new Date(latestDoc.$createdAt) : new Date()
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
        otherPartyId = otherMsg?.$ownerId
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
            id: doc.$id,
            senderId: doc.$ownerId,
            recipientId: doc.$ownerId === userId ? (otherPartyId || '') : userId,
            conversationId,
            content: '[Could not decrypt message]',
            createdAt: new Date(doc.$createdAt)
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
   * Get raw message documents for a conversation
   */
  private async getConversationMessagesRaw(
    conversationId: string,
    limit: number = 100
  ): Promise<any[]> {
    try {
      const sdk = await getEvoSdk()
      // Decode base58 conversationId, then encode as base64 for SDK
      const convIdBytes = bs58.decode(conversationId)
      const convIdBase64 = Buffer.from(convIdBytes).toString('base64')

      const response = await sdk.documents.query({
        dataContractId: this.contractId,
        documentTypeName: 'directMessage',
        where: [['conversationId', '==', convIdBase64]],
        orderBy: [['$createdAt', 'asc']],
        limit
      } as any)

      return this.extractDocuments(response)
    } catch (error) {
      console.error('Error getting raw messages:', error)
      return []
    }
  }

  /**
   * Mark conversation as read
   */
  async markAsRead(conversationId: string, userId: string): Promise<void> {
    try {
      const now = Date.now()
      const existingReceipt = await this.getMyReadReceipt(userId, conversationId)

      if (existingReceipt) {
        // Update existing receipt - must include all required fields
        const convIdBytes = bs58.decode(conversationId)
        const conversationIdArray = Array.from(convIdBytes)

        await stateTransitionService.updateDocument(
          this.contractId,
          'readReceipt',
          existingReceipt.$id,
          userId,
          { conversationId: conversationIdArray, lastReadAt: now },
          existingReceipt.$revision || 0
        )
      } else {
        // Create new receipt
        const convIdBytes = bs58.decode(conversationId)
        // byteArray fields need plain JS arrays for JSON.stringify
        const conversationIdArray = Array.from(convIdBytes)

        await stateTransitionService.createDocument(
          this.contractId,
          'readReceipt',
          userId,
          {
            conversationId: conversationIdArray,
            lastReadAt: now
          }
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
    doc: any,
    currentUserId: string,
    otherPartyId: string
  ): Promise<DirectMessage | null> {
    const privateKey = getPrivateKey(currentUserId)
    if (!privateKey) {
      console.warn('No private key available for decryption')
      return null
    }

    const senderId = doc.$ownerId
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
    const encryptedContent = this.extractByteArray(
      doc.encryptedContent || doc.data?.encryptedContent
    )
    const convIdBytes = this.extractByteArray(
      doc.conversationId || doc.data?.conversationId
    )
    const conversationId = bs58.encode(Buffer.from(convIdBytes))

    // Decrypt
    const content = await decryptFromBinary(
      encryptedContent,
      privateKey,
      otherPubKey
    )

    return {
      id: doc.$id,
      senderId,
      recipientId: isSender ? otherPartyId : currentUserId,
      conversationId,
      content,
      createdAt: new Date(doc.$createdAt)
    }
  }

  /**
   * Get public key for a user
   * First checks their invite for embedded key, then falls back to identity
   */
  private async getPublicKeyForUser(
    userId: string,
    currentUserId: string
  ): Promise<Uint8Array | null> {
    // First, check if they sent us an invite with their public key
    const theirInvite = await this.getInviteFromUser(userId, currentUserId)
    if (theirInvite) {
      const senderPubKey = this.extractByteArray(
        theirInvite.senderPubKey || theirInvite.data?.senderPubKey
      )
      if (senderPubKey && senderPubKey.length === 33) {
        return senderPubKey
      }
    }

    // Fall back to identity
    return this.getPublicKeyFromIdentity(userId)
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
      const authHighKey = publicKeys.find((pk: any) =>
        pk.type === 0 && pk.securityLevel === 2 && pk.purpose === 0
      )
      const fallbackKey = !authHighKey ? publicKeys.find((pk: any) =>
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
      const highKeys = publicKeys.filter((pk: any) => pk.securityLevel === 2)
      const hasType0 = highKeys.some((pk: any) => pk.type === 0)

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
  ): Promise<any | null> {
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
      } as any)

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
  ): Promise<any | null> {
    return this.getMyInviteToRecipient(senderId, recipientId)
  }

  /**
   * Get a user's read receipt for a conversation
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
      } as any)

      const docs = this.extractDocuments(response)
      if (docs.length === 0) return null

      const doc = docs[0]
      return {
        lastReadAt: doc.lastReadAt || doc.data?.lastReadAt || 0
      }
    } catch {
      return null
    }
  }

  /**
   * Get my read receipt for a conversation (includes full doc for updates)
   */
  private async getMyReadReceipt(
    userId: string,
    conversationId: string
  ): Promise<any | null> {
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
      } as any)

      const docs = this.extractDocuments(response)
      if (docs.length === 0) return null

      const doc = docs[0]
      return {
        $id: doc.$id,
        $ownerId: doc.$ownerId,
        $createdAt: doc.$createdAt,
        $updatedAt: doc.$updatedAt,
        $revision: doc.$revision,
        conversationId,
        lastReadAt: doc.lastReadAt || doc.data?.lastReadAt || 0
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
  private extractDocuments(response: any): any[] {
    if (response instanceof Map) {
      return Array.from(response.values())
        .filter(Boolean)
        .map((doc: any) => typeof doc.toJSON === 'function' ? doc.toJSON() : doc)
    }
    if (Array.isArray(response)) {
      return response.map((doc: any) =>
        typeof doc.toJSON === 'function' ? doc.toJSON() : doc
      )
    }
    if (response?.documents) {
      return response.documents
    }
    return []
  }

  /**
   * Extract byte array from various formats
   */
  private extractByteArray(value: any): Uint8Array {
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
    if (value.buffer && value.byteLength !== undefined) {
      return new Uint8Array(value)
    }
    return new Uint8Array(0)
  }

  /**
   * Extract public key bytes from identity public key object
   */
  private extractPublicKeyBytes(publicKey: any): Uint8Array {
    if (publicKey instanceof Uint8Array) return publicKey
    if (Array.isArray(publicKey)) return new Uint8Array(publicKey)

    if (publicKey && typeof publicKey === 'object') {
      // Try 'data' field (common in Dash Platform)
      if (publicKey.data) {
        if (Array.isArray(publicKey.data)) return new Uint8Array(publicKey.data)
        if (typeof publicKey.data === 'string') {
          try {
            return bs58.decode(publicKey.data)
          } catch {
            return new Uint8Array(Buffer.from(publicKey.data, 'base64'))
          }
        }
        if (publicKey.data instanceof Uint8Array) return publicKey.data
      }

      // Try 'publicKey' field
      if (publicKey.publicKey) {
        if (Array.isArray(publicKey.publicKey)) return new Uint8Array(publicKey.publicKey)
        if (typeof publicKey.publicKey === 'string') {
          try {
            return bs58.decode(publicKey.publicKey)
          } catch {
            return new Uint8Array(Buffer.from(publicKey.publicKey, 'base64'))
          }
        }
      }

      // Try 'key' field
      if (publicKey.key) {
        if (Array.isArray(publicKey.key)) return new Uint8Array(publicKey.key)
        if (typeof publicKey.key === 'string') {
          try {
            return bs58.decode(publicKey.key)
          } catch {
            return new Uint8Array(Buffer.from(publicKey.key, 'base64'))
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
