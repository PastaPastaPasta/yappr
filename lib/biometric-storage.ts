'use client'

/**
 * Biometric-protected storage for sensitive data using WebAuthn and Web Crypto API
 * This provides secure storage with biometric authentication on supported devices
 */

interface StoredCredential {
  credentialId: string
  publicKey: ArrayBuffer
}

interface EncryptedData {
  iv: string
  ciphertext: string
  salt: string
  credentialId: string
}

class BiometricStorage {
  private readonly STORAGE_KEY_PREFIX = 'yappr_bio_'
  private readonly CREDENTIAL_KEY = 'yappr_bio_credential'
  
  /**
   * Check if biometric authentication is available
   */
  async isAvailable(): Promise<boolean> {
    if (!window.PublicKeyCredential) {
      return false
    }
    
    try {
      // Check if platform authenticator is available (Touch ID, Face ID, Windows Hello)
      const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
      return available
    } catch {
      return false
    }
  }
  
  /**
   * Register biometric authentication for the user
   */
  async register(userId: string): Promise<boolean> {
    try {
      // Create a challenge
      const challenge = new Uint8Array(32)
      crypto.getRandomValues(challenge)
      
      // Create credential options
      const createOptions: CredentialCreationOptions = {
        publicKey: {
          challenge,
          rp: {
            name: 'Yappr',
            id: window.location.hostname
          },
          user: {
            id: new TextEncoder().encode(userId),
            name: userId,
            displayName: 'Yappr User'
          },
          pubKeyCredParams: [
            { alg: -7, type: 'public-key' }, // ES256
            { alg: -257, type: 'public-key' } // RS256
          ],
          authenticatorSelection: {
            authenticatorAttachment: 'platform',
            userVerification: 'required',
            residentKey: 'preferred'
          },
          timeout: 60000,
          attestation: 'none'
        }
      }
      
      // Create credential
      const credential = await navigator.credentials.create(createOptions) as PublicKeyCredential
      if (!credential) {
        throw new Error('Failed to create credential')
      }
      
      // Store credential ID and public key for later use
      const attestationResponse = credential.response as AuthenticatorAttestationResponse
      const publicKey = attestationResponse.getPublicKey()
      if (!publicKey) {
        throw new Error('Failed to get public key from credential')
      }
      const storedCred: StoredCredential = {
        credentialId: this.arrayBufferToBase64(credential.rawId),
        publicKey: publicKey
      }
      
      localStorage.setItem(this.CREDENTIAL_KEY, JSON.stringify({
        credentialId: storedCred.credentialId,
        publicKey: this.arrayBufferToBase64(storedCred.publicKey)
      }))
      
      return true
    } catch (error) {
      console.error('Biometric registration failed:', error)
      return false
    }
  }
  
  /**
   * Store data with biometric protection
   */
  async store(key: string, data: string, userId: string): Promise<boolean> {
    try {
      // Check if biometric is registered
      const credentialData = this.getStoredCredential()
      if (!credentialData) {
        // Try to register first
        const registered = await this.register(userId)
        if (!registered) {
          throw new Error('Biometric registration required')
        }
      }
      
      // Generate encryption key from random data
      const salt = crypto.getRandomValues(new Uint8Array(16))
      const keyMaterial = await crypto.subtle.generateKey(
        {
          name: 'AES-GCM',
          length: 256
        },
        true,
        ['encrypt', 'decrypt']
      )
      
      // Encrypt the data
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const encoder = new TextEncoder()
      const encrypted = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv
        },
        keyMaterial,
        encoder.encode(data)
      )
      
      // Export the key for storage
      const exportedKey = await crypto.subtle.exportKey('raw', keyMaterial)
      
      // Store encrypted data with metadata
      const encryptedData: EncryptedData = {
        iv: this.arrayBufferToBase64(iv),
        ciphertext: this.arrayBufferToBase64(encrypted),
        salt: this.arrayBufferToBase64(salt),
        credentialId: credentialData?.credentialId || ''
      }
      
      // Store the encrypted data
      localStorage.setItem(this.STORAGE_KEY_PREFIX + key, JSON.stringify(encryptedData))
      
      // Store the encryption key separately (this could be enhanced with additional protection)
      sessionStorage.setItem(this.STORAGE_KEY_PREFIX + key + '_key', this.arrayBufferToBase64(exportedKey))
      
      return true
    } catch (error) {
      console.error('Failed to store with biometric protection:', error)
      return false
    }
  }
  
  /**
   * Retrieve data with biometric authentication
   */
  async retrieve(key: string): Promise<string | null> {
    try {
      // Get encrypted data
      const storedData = localStorage.getItem(this.STORAGE_KEY_PREFIX + key)
      if (!storedData) {
        return null
      }
      
      const encryptedData: EncryptedData = JSON.parse(storedData)
      
      // Authenticate with biometric
      const authenticated = await this.authenticate()
      if (!authenticated) {
        throw new Error('Biometric authentication failed')
      }
      
      // Get the encryption key
      const keyData = sessionStorage.getItem(this.STORAGE_KEY_PREFIX + key + '_key')
      if (!keyData) {
        // If key not in session, we can't decrypt the data
        // This is a limitation of the current implementation
        console.warn('Encryption key not found in session. Data exists but cannot be decrypted.')
        console.warn('This happens when the browser session ends. User needs to log in again.')
        
        // Clean up the orphaned encrypted data
        this.remove(key)
        return null
      }
      
      // Import the key
      const keyBuffer = this.base64ToArrayBuffer(keyData)
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        keyBuffer,
        'AES-GCM',
        false,
        ['decrypt']
      )
      
      // Decrypt the data
      const decrypted = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: this.base64ToArrayBuffer(encryptedData.iv)
        },
        cryptoKey,
        this.base64ToArrayBuffer(encryptedData.ciphertext)
      )
      
      const decoder = new TextDecoder()
      return decoder.decode(decrypted)
    } catch (error) {
      console.error('Failed to retrieve with biometric:', error)
      return null
    }
  }
  
  /**
   * Authenticate using biometric
   */
  private async authenticate(): Promise<boolean> {
    try {
      const credentialData = this.getStoredCredential()
      if (!credentialData) {
        throw new Error('No credential registered')
      }
      
      // Show biometric prompt UI
      let promptStore: any
      try {
        const { useBiometricPrompt } = await import('@/hooks/use-biometric-prompt')
        promptStore = useBiometricPrompt.getState()
        promptStore.open()
      } catch (e) {
        // UI prompt is optional
      }
      
      // Create a challenge
      const challenge = new Uint8Array(32)
      crypto.getRandomValues(challenge)
      
      // Request authentication
      const getOptions: CredentialRequestOptions = {
        publicKey: {
          challenge,
          allowCredentials: [{
            id: this.base64ToArrayBuffer(credentialData.credentialId),
            type: 'public-key'
          }],
          userVerification: 'required',
          timeout: 60000
        }
      }
      
      try {
        const assertion = await navigator.credentials.get(getOptions) as PublicKeyCredential
        if (!assertion) {
          throw new Error('Authentication failed')
        }
        
        // In a production app, you would verify the assertion signature here
        // For now, we trust that the platform authenticator verified the user
        return true
      } finally {
        // Close prompt
        if (promptStore) {
          promptStore.close()
        }
      }
    } catch (error) {
      console.error('Biometric authentication failed:', error)
      return false
    }
  }
  
  /**
   * Get stored credential
   */
  private getStoredCredential(): { credentialId: string; publicKey: string } | null {
    const stored = localStorage.getItem(this.CREDENTIAL_KEY)
    if (!stored) {
      return null
    }
    
    try {
      return JSON.parse(stored)
    } catch {
      return null
    }
  }
  
  /**
   * Remove biometric protection for a key
   */
  remove(key: string): void {
    localStorage.removeItem(this.STORAGE_KEY_PREFIX + key)
    sessionStorage.removeItem(this.STORAGE_KEY_PREFIX + key + '_key')
  }
  
  /**
   * Clear all biometric protected data
   */
  clearAll(): void {
    // Clear all biometric protected items
    const keys = Object.keys(localStorage)
    keys.forEach(key => {
      if (key.startsWith(this.STORAGE_KEY_PREFIX)) {
        localStorage.removeItem(key)
      }
    })
    
    // Clear session keys
    const sessionKeys = Object.keys(sessionStorage)
    sessionKeys.forEach(key => {
      if (key.startsWith(this.STORAGE_KEY_PREFIX)) {
        sessionStorage.removeItem(key)
      }
    })
  }
  
  /**
   * Convert ArrayBuffer or Uint8Array to base64
   */
  private arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return btoa(binary)
  }
  
  /**
   * Convert base64 to ArrayBuffer
   */
  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes.buffer
  }
}

// Export singleton instance
export const biometricStorage = new BiometricStorage()

// Export helper functions for private key storage
export async function storePrivateKeyWithBiometric(
  identityId: string, 
  privateKey: string
): Promise<boolean> {
  try {
    // Check if biometric is available
    const available = await biometricStorage.isAvailable()
    if (!available) {
      console.log('Biometric authentication not available')
      return false
    }
    
    // Store with 30-day expiration timestamp
    const data = JSON.stringify({
      privateKey,
      expiresAt: Date.now() + (30 * 24 * 60 * 60 * 1000) // 30 days
    })
    
    return await biometricStorage.store(`pk_${identityId}`, data, identityId)
  } catch (error) {
    console.error('Failed to store private key with biometric:', error)
    return false
  }
}

export async function getPrivateKeyWithBiometric(
  identityId: string
): Promise<string | null> {
  try {
    console.log(`Attempting to retrieve private key for identity: ${identityId}`)
    console.log(`Storage key: pk_${identityId}`)
    
    const data = await biometricStorage.retrieve(`pk_${identityId}`)
    console.log('Retrieved data:', data ? 'Found' : 'Not found')
    
    if (!data) {
      // Check if it exists in localStorage
      const storageKey = `yappr_bio_pk_${identityId}`
      const exists = localStorage.getItem(storageKey)
      console.log(`Checking localStorage key ${storageKey}:`, exists ? 'Exists' : 'Not found')
      return null
    }
    
    const parsed = JSON.parse(data)
    console.log('Parsed data expires at:', new Date(parsed.expiresAt))
    console.log('Current time:', new Date())
    
    // Check expiration
    if (parsed.expiresAt && Date.now() > parsed.expiresAt) {
      console.log('Private key has expired, removing...')
      biometricStorage.remove(`pk_${identityId}`)
      return null
    }
    
    return parsed.privateKey
  } catch (error) {
    console.error('Failed to retrieve private key with biometric:', error)
    return null
  }
}

export async function clearBiometricPrivateKey(identityId: string): Promise<void> {
  biometricStorage.remove(`pk_${identityId}`)
}