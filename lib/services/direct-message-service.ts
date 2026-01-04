import { BaseDocumentService, QueryOptions, DocumentResult } from './document-service'
import { stateTransitionService } from './state-transition-service'
import { identityService } from './identity-service'
import { dpnsService } from './dpns-service'
import { DirectMessage, Conversation } from '../types'
import {
  encryptMessage,
  decryptMessage,
  generateConversationId,
  parseEncryptedContent,
  formatEncryptedContent,
  base64ToUint8Array
} from '../message-encryption'
import { getPrivateKey } from '../secure-storage'
import { YAPPR_DM_CONTRACT_ID } from '../constants'
import bs58 from 'bs58'

export interface DirectMessageDocument {
  $id: string
  $ownerId: string
  $createdAt: number
  $revision?: number
  recipientId: string
  conversationId: string
  encryptedContent: string
  read: boolean
}

class DirectMessageService extends BaseDocumentService<DirectMessageDocument> {
  private conversationCache: Map<string, string[]> = new Map() // userId -> conversationIds

  constructor() {
    super('directMessage', YAPPR_DM_CONTRACT_ID)
  }

  protected transformDocument(doc: any): DirectMessageDocument {
    const id = doc.$id || doc.id
    const ownerId = doc.$ownerId || doc.ownerId
    const createdAt = doc.$createdAt || doc.createdAt
    const revision = doc.$revision || doc.revision
    const data = doc.data || doc

    // Convert byte arrays to base58 strings if needed
    let recipientId = data.recipientId
    let conversationId = data.conversationId

    if (Array.isArray(recipientId)) {
      recipientId = bs58.encode(Buffer.from(recipientId))
    }
    if (Array.isArray(conversationId)) {
      conversationId = bs58.encode(Buffer.from(conversationId))
    }

    return {
      $id: id,
      $ownerId: ownerId,
      $createdAt: createdAt,
      $revision: revision,
      recipientId,
      conversationId,
      encryptedContent: data.encryptedContent,
      read: data.read ?? false
    }
  }

  /**
   * Send a direct message
   */
  async sendMessage(
    senderId: string,
    recipientId: string,
    content: string
  ): Promise<{ success: boolean; message?: DirectMessage; error?: string }> {
    try {
      // 1. Get recipient's identity and public key for encryption
      let recipientIdentity = null
      let retries = 2

      while (retries > 0 && !recipientIdentity) {
        try {
          recipientIdentity = await identityService.getIdentity(recipientId)
        } catch (err) {
          console.warn(`Identity fetch attempt failed (${retries} retries left):`, err)
          retries--
          if (retries > 0) {
            await new Promise(resolve => setTimeout(resolve, 1000)) // Wait 1s before retry
          }
        }
      }

      if (!recipientIdentity) {
        return { success: false, error: 'Could not fetch recipient identity. Please try again.' }
      }

      const recipientPublicKeys = recipientIdentity.publicKeys
      if (!recipientPublicKeys || recipientPublicKeys.length === 0) {
        return { success: false, error: 'Recipient has no public keys' }
      }

      // Find the authentication HIGH key (type 0, securityLevel 2, purpose 0)
      // This is the key users typically log in with, not the MASTER key (securityLevel 0)
      // Type 0 = ECDSA_SECP256K1 (has actual 33-byte public key for ECDH)
      // Type 2 = ECDSA_HASH160 (only 20-byte hash, can't use for ECDH)
      const authHighKey = recipientPublicKeys.find((pk: any) =>
        pk.type === 0 && pk.securityLevel === 2 && pk.purpose === 0
      )

      // Fallback: any type 0 key with securityLevel 2
      const fallbackKey = !authHighKey ? recipientPublicKeys.find((pk: any) =>
        pk.type === 0 && pk.securityLevel === 2
      ) : null

      const ecdsaKey = authHighKey || fallbackKey

      if (!ecdsaKey) {
        console.warn('No suitable authentication key found. Available keys:',
          recipientPublicKeys.map((pk: any) => ({ id: pk.id, type: pk.type, securityLevel: pk.securityLevel, purpose: pk.purpose })))
        return {
          success: false,
          error: 'Recipient does not have a compatible authentication key for encrypted messaging.'
        }
      }

      const publicKeyBytes = this.extractPublicKeyBytes(ecdsaKey)

      // 2. Get sender's private key for encryption
      const privateKey = this.getPrivateKeyFromStorage(senderId)
      if (!privateKey) {
        return { success: false, error: 'Please log in again to send messages' }
      }

      // 3. Generate conversation ID
      const conversationIdBytes = await generateConversationId(senderId, recipientId)
      const conversationId = bs58.encode(Buffer.from(conversationIdBytes))

      // 4. Encrypt the message
      const encrypted = await encryptMessage(content, privateKey, publicKeyBytes)
      const encryptedContent = formatEncryptedContent(encrypted)

      // 5. Create document - SDK handles ID conversion
      const result = await stateTransitionService.createDocument(
        this.contractId,
        this.documentType,
        senderId,
        {
          recipientId,  // SDK converts base58 to bytes
          conversationId,  // SDK converts base58 to bytes
          encryptedContent,
          read: false
        }
      )

      if (!result.success) {
        return { success: false, error: result.error }
      }

      // Update conversation cache
      this.addToConversationCache(senderId, conversationId)

      // Return decrypted message for UI
      return {
        success: true,
        message: {
          id: result.document?.$id || `temp-${Date.now()}`,
          senderId,
          recipientId,
          conversationId,
          content, // Original plaintext for display
          encryptedContent,
          read: false,
          createdAt: new Date()
        }
      }
    } catch (error: any) {
      console.error('Error sending message:', error)
      // Try to extract message from WasmSdkError
      let errorMessage = 'Failed to send message'
      if (error?.message) {
        errorMessage = error.message
      } else if (error?.toString) {
        errorMessage = error.toString()
      }
      return {
        success: false,
        error: errorMessage
      }
    }
  }

  /**
   * Get messages received by a user (uses receiverMessages index)
   */
  private async getReceivedMessages(userId: string, limit: number = 100): Promise<DirectMessageDocument[]> {
    try {
      const result = await this.query({
        where: [['recipientId', '==', userId]],
        orderBy: [['$createdAt', 'desc']],
        limit
      })
      return result.documents
    } catch (error) {
      console.error('Error getting received messages:', error)
      return []
    }
  }

  /**
   * Get all conversations for a user
   * Queries BOTH sent messages (by $ownerId) AND received messages (by recipientId)
   */
  async getConversations(userId: string): Promise<Conversation[]> {
    try {
      // Query messages sent by user
      const sentResult = await this.query({
        where: [['$ownerId', '==', userId]],
        orderBy: [['$createdAt', 'desc']],
        limit: 100
      })

      // Query messages received by user (uses receiverMessages index)
      const receivedMessages = await this.getReceivedMessages(userId, 100)

      // Combine and deduplicate by conversationId
      const allMessages = [...sentResult.documents, ...receivedMessages]

      // Build conversation map
      const conversationMap = new Map<string, {
        participantId: string
        latestMessage: DirectMessageDocument
        messages: DirectMessageDocument[]
      }>()

      for (const msg of allMessages) {
        const convId = msg.conversationId

        // Determine the other participant
        const isSender = msg.$ownerId === userId
        const participantId = isSender ? msg.recipientId : msg.$ownerId

        const existing = conversationMap.get(convId)
        if (!existing) {
          conversationMap.set(convId, {
            participantId,
            latestMessage: msg,
            messages: [msg]
          })
        } else {
          // Check if this message is already in the list (dedup)
          if (!existing.messages.some(m => m.$id === msg.$id)) {
            existing.messages.push(msg)
          }
          // Update latest if this message is newer
          if (msg.$createdAt > existing.latestMessage.$createdAt) {
            existing.latestMessage = msg
          }
        }
      }

      // Build conversation objects
      const conversations: Conversation[] = []

      for (const [conversationId, data] of Array.from(conversationMap.entries())) {
        try {
          // Count unread (messages from other user that are unread)
          const unreadCount = data.messages.filter(
            m => m.$ownerId !== userId && !m.read
          ).length

          // Try to get participant username
          let participantUsername: string | undefined
          try {
            participantUsername = await dpnsService.resolveUsername(data.participantId) || undefined
          } catch {
            // Ignore DPNS errors
          }

          // Decrypt latest message for preview
          let lastMessage: DirectMessage | null | undefined
          try {
            lastMessage = await this.decryptAndTransformMessage(data.latestMessage, userId)
          } catch {
            // If decryption fails, create placeholder
            lastMessage = {
              id: data.latestMessage.$id,
              senderId: data.latestMessage.$ownerId,
              recipientId: data.latestMessage.recipientId,
              conversationId: data.latestMessage.conversationId,
              content: '[Encrypted message]',
              encryptedContent: data.latestMessage.encryptedContent,
              read: data.latestMessage.read,
              createdAt: new Date(data.latestMessage.$createdAt)
            }
          }

          conversations.push({
            id: conversationId,
            participantId: data.participantId,
            participantUsername,
            lastMessage,
            unreadCount,
            updatedAt: new Date(data.latestMessage.$createdAt)
          })
        } catch (err) {
          console.error(`Error processing conversation ${conversationId}:`, err)
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
    userId: string
  ): Promise<DirectMessage[]> {
    try {
      const result = await this.query({
        where: [['conversationId', '==', conversationId]],  // Use base58 string
        orderBy: [['$createdAt', 'asc']],
        limit: 100
      })

      // Decrypt each message
      const messages: DirectMessage[] = []
      for (const doc of result.documents) {
        try {
          const msg = await this.decryptAndTransformMessage(doc, userId)
          if (msg) messages.push(msg)
        } catch (err) {
          console.error('Error decrypting message:', err)
          // Add placeholder for failed decryption
          messages.push({
            id: doc.$id,
            senderId: doc.$ownerId,
            recipientId: doc.recipientId,
            conversationId: doc.conversationId,
            content: '[Could not decrypt message]',
            encryptedContent: doc.encryptedContent,
            read: doc.read,
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
   * Mark messages as read
   */
  async markAsRead(conversationId: string, userId: string): Promise<void> {
    try {
      const messages = await this.getConversationMessages(conversationId, userId)

      for (const msg of messages) {
        // Only mark messages from OTHER user as read
        if (msg.senderId !== userId && !msg.read) {
          try {
            await this.update(msg.id, msg.senderId, { read: true })
          } catch (err) {
            // Can only update own documents - skip if not authorized
            console.warn('Cannot mark message as read (not owner):', msg.id)
          }
        }
      }
    } catch (error) {
      console.error('Error marking messages as read:', error)
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

    // Check if conversation exists by querying for any messages
    try {
      const result = await this.query({
        where: [['conversationId', '==', conversationId]],  // Use base58 string
        limit: 1
      })

      return {
        conversationId,
        isNew: result.documents.length === 0
      }
    } catch {
      return {
        conversationId,
        isNew: true
      }
    }
  }

  /**
   * Decrypt and transform a message document
   */
  private async decryptAndTransformMessage(
    doc: DirectMessageDocument,
    currentUserId: string
  ): Promise<DirectMessage | null> {
    // Parse encrypted content
    const encrypted = parseEncryptedContent(doc.encryptedContent)

    // Get current user's private key
    const privateKey = this.getPrivateKeyFromStorage(currentUserId)
    if (!privateKey) {
      console.warn('No private key available for decryption')
      return {
        id: doc.$id,
        senderId: doc.$ownerId,
        recipientId: doc.recipientId,
        conversationId: doc.conversationId,
        content: '[Please log in to decrypt]',
        encryptedContent: doc.encryptedContent,
        read: doc.read,
        createdAt: new Date(doc.$createdAt)
      }
    }

    // Determine if current user is sender or recipient
    const isSender = doc.$ownerId === currentUserId
    const otherPartyId = isSender ? doc.recipientId : doc.$ownerId

    let otherPartyPublicKeyBytes: Uint8Array

    if (!isSender && encrypted.senderPublicKey && encrypted.senderPublicKey.length > 0) {
      // Recipient viewing: use embedded sender public key
      otherPartyPublicKeyBytes = base64ToUint8Array(encrypted.senderPublicKey)
    } else {
      // Sender viewing OR legacy format: fetch other party's public key from identity
      const otherPublicKeys = await identityService.getPublicKeys(otherPartyId)

      if (!otherPublicKeys || otherPublicKeys.length === 0) {
        console.warn('Could not get public key for:', otherPartyId)
        return null
      }

      // Find the authentication HIGH key (type 0, securityLevel 2, purpose 0)
      const authHighKey = otherPublicKeys.find((pk: any) =>
        pk.type === 0 && pk.securityLevel === 2 && pk.purpose === 0
      )
      const fallbackKey = !authHighKey ? otherPublicKeys.find((pk: any) =>
        pk.type === 0 && pk.securityLevel === 2
      ) : null
      const ecdsaKey = authHighKey || fallbackKey

      if (!ecdsaKey) {
        console.warn('No suitable authentication key found for:', otherPartyId)
        return null
      }

      otherPartyPublicKeyBytes = this.extractPublicKeyBytes(ecdsaKey)
    }

    // Decrypt the message
    const content = await decryptMessage(encrypted, privateKey, otherPartyPublicKeyBytes)

    return {
      id: doc.$id,
      senderId: doc.$ownerId,
      recipientId: doc.recipientId,
      conversationId: doc.conversationId,
      content,
      encryptedContent: doc.encryptedContent,
      read: doc.read,
      createdAt: new Date(doc.$createdAt)
    }
  }

  /**
   * Extract public key bytes from identity public key object
   * Dash Platform public keys typically have structure:
   * { id, type, purpose, securityLevel, readOnly, data: [...] }
   * or { publicKey: [...] } or { key: [...] }
   */
  private extractPublicKeyBytes(publicKey: any): Uint8Array {
    // Handle different formats the identity may return
    if (publicKey instanceof Uint8Array) {
      return publicKey
    }
    if (Array.isArray(publicKey)) {
      return new Uint8Array(publicKey)
    }

    // Dash Platform identity public key object format
    if (publicKey && typeof publicKey === 'object') {
      // Try 'data' field (common in Dash Platform)
      if (publicKey.data) {
        if (Array.isArray(publicKey.data)) {
          return new Uint8Array(publicKey.data)
        }
        if (typeof publicKey.data === 'string') {
          try {
            return bs58.decode(publicKey.data)
          } catch {
            return new Uint8Array(Buffer.from(publicKey.data, 'base64'))
          }
        }
        if (publicKey.data instanceof Uint8Array) {
          return publicKey.data
        }
      }

      // Try 'publicKey' field
      if (publicKey.publicKey) {
        if (Array.isArray(publicKey.publicKey)) {
          return new Uint8Array(publicKey.publicKey)
        }
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
        if (Array.isArray(publicKey.key)) {
          return new Uint8Array(publicKey.key)
        }
        if (typeof publicKey.key === 'string') {
          try {
            return bs58.decode(publicKey.key)
          } catch {
            return new Uint8Array(Buffer.from(publicKey.key, 'base64'))
          }
        }
      }
    }

    // Check for base58/base64 encoded string
    if (typeof publicKey === 'string') {
      try {
        return bs58.decode(publicKey)
      } catch {
        return new Uint8Array(Buffer.from(publicKey, 'base64'))
      }
    }

    throw new Error('Unknown public key format: ' + JSON.stringify(publicKey))
  }

  /**
   * Add a conversation ID to the local cache
   */
  private addToConversationCache(userId: string, conversationId: string): void {
    const existing = this.conversationCache.get(userId) || []
    if (!existing.includes(conversationId)) {
      existing.push(conversationId)
      this.conversationCache.set(userId, existing)
    }
  }

  /**
   * Get private key from secure storage
   */
  private getPrivateKeyFromStorage(identityId: string): string | null {
    return getPrivateKey(identityId)
  }
}

// Singleton instance
export const directMessageService = new DirectMessageService()
