'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { motion } from 'framer-motion'
import {
  MagnifyingGlassIcon,
  PaperAirplaneIcon,
  InformationCircleIcon,
  EllipsisHorizontalIcon,
  PlusIcon
} from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { UserAvatar } from '@/components/ui/avatar-image'
import { formatDistanceToNow } from 'date-fns'
import { directMessageService, dpnsService, identityService, unifiedProfileService } from '@/lib/services'
import { useSettingsStore } from '@/lib/store'
import { DirectMessage, Conversation } from '@/lib/types'
import toast from 'react-hot-toast'
import { XMarkIcon, ArrowLeftIcon } from '@heroicons/react/24/outline'
import { EmojiPicker } from '@/components/compose/emoji-picker'
import { isEmojiOnly } from '@/lib/utils'

interface UserSearchResult {
  id: string
  username: string
  displayName: string
  bio?: string
}

function MessagesPage() {
  const { user } = useAuth()
  const searchParams = useSearchParams()
  const startConversationWith = searchParams.get('startConversation')
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null)
  const [pendingStartConversation, setPendingStartConversation] = useState<string | null>(startConversationWith)
  const [messages, setMessages] = useState<DirectMessage[]>([])
  const [newMessage, setNewMessage] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isSending, setIsSending] = useState(false)
  const [isLoadingMessages, setIsLoadingMessages] = useState(false)
  const [showNewConversation, setShowNewConversation] = useState(false)
  const [newConversationInput, setNewConversationInput] = useState('')
  const [isResolvingUser, setIsResolvingUser] = useState(false)
  const [participantLastRead, setParticipantLastRead] = useState<number | null>(null)
  const sendReadReceipts = useSettingsStore((s) => s.sendReadReceipts)
  const [userSearchResults, setUserSearchResults] = useState<UserSearchResult[]>([])
  const [isSearchingUsers, setIsSearchingUsers] = useState(false)
  const searchIdRef = useRef(0)

  // Refs for polling (to avoid stale closures and dependency issues)
  const userRef = useRef(user)
  userRef.current = user
  const selectedConversationRef = useRef(selectedConversation)
  selectedConversationRef.current = selectedConversation
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  // Load conversations on mount
  useEffect(() => {
    const loadConversations = async () => {
      if (!user) return
      setIsLoading(true)
      try {
        const convos = await directMessageService.getConversations(user.identityId)
        setConversations(convos)
      } catch (error) {
        console.error('Failed to load conversations:', error)
        toast.error('Failed to load conversations')
      } finally {
        setIsLoading(false)
      }
    }
    loadConversations().catch(err => console.error('Failed to load conversations:', err))
  }, [user])

  // Handle auto-starting a conversation from URL parameter
  useEffect(() => {
    const handleStartConversation = async () => {
      if (!pendingStartConversation || !user || isLoading) return

      // Clear the pending state so we don't run this again
      setPendingStartConversation(null)

      const participantId = pendingStartConversation

      // Don't start conversation with yourself
      if (participantId === user.identityId) {
        toast.error("You can't message yourself")
        return
      }

      // Check if conversation already exists
      const existingConv = conversations.find(c => c.participantId === participantId)
      if (existingConv) {
        setSelectedConversation(existingConv)
        return
      }

      // Need to create a new conversation - fetch user info first
      setIsResolvingUser(true)
      try {
        // Get username and profile for the participant
        const [username, profile] = await Promise.all([
          dpnsService.resolveUsername(participantId),
          unifiedProfileService.getProfile(participantId).catch(() => null)
        ])

        // Create new conversation entry
        const { conversationId } = await directMessageService.getOrCreateConversation(
          user.identityId,
          participantId
        )

        const newConv: Conversation = {
          id: conversationId,
          participantId,
          participantUsername: username || undefined,
          participantDisplayName: profile?.displayName,
          unreadCount: 0,
          updatedAt: new Date()
        }

        setConversations(prev => [newConv, ...prev])
        setSelectedConversation(newConv)
        setMessages([])
      } catch (error) {
        console.error('Failed to start conversation from URL:', error)
        toast.error('Failed to start conversation')
      } finally {
        setIsResolvingUser(false)
      }
    }

    handleStartConversation().catch(err => console.error('Failed to handle start conversation:', err))
  }, [pendingStartConversation, user, isLoading, conversations])

  // Load messages when conversation is selected
  useEffect(() => {
    const loadMessages = async () => {
      if (!selectedConversation || !user) return
      setIsLoadingMessages(true)
      setParticipantLastRead(null) // Reset while loading
      try {
        const msgs = await directMessageService.getConversationMessages(
          selectedConversation.id,
          user.identityId,
          selectedConversation.participantId
        )
        setMessages(msgs)

        // Get when participant last read (for read receipts)
        const lastRead = await directMessageService.getParticipantLastRead(
          selectedConversation.id,
          selectedConversation.participantId
        )
        setParticipantLastRead(lastRead)

        // Only mark as read if there are unread messages and read receipts are enabled
        if (selectedConversation.unreadCount > 0 && sendReadReceipts) {
          await directMessageService.markAsRead(selectedConversation.id, user.identityId)
        }

        // Update conversation unread count in UI
        setConversations(prev => prev.map(conv =>
          conv.id === selectedConversation.id
            ? { ...conv, unreadCount: 0 }
            : conv
        ))
      } catch (error) {
        console.error('Failed to load messages:', error)
        toast.error('Failed to load messages')
      } finally {
        setIsLoadingMessages(false)
      }
    }
    loadMessages().catch(err => console.error('Failed to load messages:', err))
  }, [selectedConversation, user, sendReadReceipts])

  // Poll for new messages in active conversation (timestamp-based, efficient)
  useEffect(() => {
    const convId = selectedConversation?.id
    if (!convId || !user?.identityId) return

    let timeoutId: NodeJS.Timeout | null = null
    let cancelled = false

    const pollMessages = async () => {
      if (cancelled) return

      const currentConv = selectedConversationRef.current
      const currentUser = userRef.current
      if (!currentConv || !currentUser) return

      try {
        // Get the latest message timestamp - only fetch messages newer than this
        const currentMessages = messagesRef.current
        const lastTimestamp = currentMessages.length > 0
          ? Math.max(...currentMessages.map(m => m.createdAt.getTime()))
          : 0

        // Query only messages newer than lastTimestamp (efficient, uses index)
        const newMsgs = await directMessageService.pollNewMessages(
          currentConv.id,
          lastTimestamp,
          currentUser.identityId,
          currentConv.participantId
        )

        if (cancelled) return

        if (newMsgs.length > 0) {
          setMessages(prev => {
            const result = [...prev]
            const existingIds = new Set(prev.map(m => m.id))

            for (const newMsg of newMsgs) {
              // Skip if we already have this exact ID
              if (existingIds.has(newMsg.id)) continue

              // Check if this matches a pending/optimistic message (has temp ID)
              // that was added by sendMessage before we got the real document ID
              const duplicateIndex = result.findIndex(m =>
                m.id.startsWith('temp-') &&
                m.senderId === newMsg.senderId &&
                m.content === newMsg.content &&
                Math.abs(m.createdAt.getTime() - newMsg.createdAt.getTime()) < 60000
              )

              if (duplicateIndex !== -1) {
                // Replace the temp message with the real one (has actual document ID)
                result[duplicateIndex] = newMsg
              } else {
                // Truly new message from other party
                result.push(newMsg)
              }
            }

            return result
          })
        }
      } catch (error) {
        console.debug('Message poll error:', error)
      }

      // Schedule next poll AFTER this one completes
      if (!cancelled) {
        timeoutId = setTimeout(pollMessages, 3000)
      }
    }

    // Start first poll after 3s
    timeoutId = setTimeout(pollMessages, 3000)

    return () => {
      cancelled = true
      if (timeoutId) clearTimeout(timeoutId)
    }
  }, [selectedConversation?.id, user?.identityId])

  // Debounced user search for new conversation modal
  useEffect(() => {
    const query = newConversationInput.trim()

    // Clear results if query is empty or looks like an identity ID
    if (!query || query.length > 30) {
      setUserSearchResults([])
      setIsSearchingUsers(false)
      return
    }

    // Only search if at least 3 characters (like DashPay)
    if (query.length < 3) {
      setUserSearchResults([])
      return
    }

    const currentSearchId = ++searchIdRef.current
    setIsSearchingUsers(true)

    const debounceTimer = setTimeout(async () => {
      try {
        // Search DPNS usernames by prefix
        const dpnsResults = await dpnsService.searchUsernamesWithDetails(query, 5)

        // Ignore stale results
        if (currentSearchId !== searchIdRef.current) return

        if (dpnsResults.length === 0) {
          setUserSearchResults([])
          setIsSearchingUsers(false)
          return
        }

        // Get unique owner IDs (excluding self)
        const ownerIds = Array.from(
          new Set(dpnsResults.map(r => r.ownerId).filter(id => id && id !== user?.identityId))
        )

        // Fetch profiles for display names
        let profiles: { $ownerId?: string; ownerId?: string; displayName?: string; bio?: string }[] = []
        if (ownerIds.length > 0) {
          try {
            profiles = await unifiedProfileService.getProfilesByIdentityIds(ownerIds)
          } catch (error) {
            console.error('Failed to fetch profiles for search:', error)
          }
        }

        // Ignore stale results
        if (currentSearchId !== searchIdRef.current) return

        // Create profile map
        const profileMap = new Map(profiles.map(p => [p.$ownerId || p.ownerId, p]))

        // Build results, grouping by owner
        const seenOwners = new Set<string>()
        const results: UserSearchResult[] = []

        for (const dpnsResult of dpnsResults) {
          if (!dpnsResult.ownerId || dpnsResult.ownerId === user?.identityId) continue
          if (seenOwners.has(dpnsResult.ownerId)) continue
          seenOwners.add(dpnsResult.ownerId)

          const profile = profileMap.get(dpnsResult.ownerId)
          const username = dpnsResult.username.replace(/\.dash$/, '')

          results.push({
            id: dpnsResult.ownerId,
            username,
            displayName: profile?.displayName || username,
            bio: profile?.bio
          })
        }

        setUserSearchResults(results)
      } catch (error) {
        console.error('User search failed:', error)
        setUserSearchResults([])
      } finally {
        if (currentSearchId === searchIdRef.current) {
          setIsSearchingUsers(false)
        }
      }
    }, 300)

    return () => clearTimeout(debounceTimer)
  }, [newConversationInput, user?.identityId])

  const sendMessage = async () => {
    if (!newMessage.trim() || !selectedConversation || !user || isSending) return

    const messageContent = newMessage.trim()
    setIsSending(true)

    try {
      const result = await directMessageService.sendMessage(
        user.identityId,
        selectedConversation.participantId,
        messageContent
      )

      if (result.success && result.message) {
        const sentMessage = result.message
        // Clear input only on success
        setNewMessage('')
        // Add message to UI (with deduplication in case poll already added it)
        setMessages(prev => {
          // Check if poll already added this message (with real ID while we have temp)
          const alreadyExists = prev.some(m =>
            m.id === sentMessage.id ||
            (m.senderId === sentMessage.senderId &&
             m.content === sentMessage.content &&
             Math.abs(m.createdAt.getTime() - sentMessage.createdAt.getTime()) < 60000)
          )
          return alreadyExists ? prev : [...prev, sentMessage]
        })

        // Update conversation's last message
        setConversations(prev => prev.map(conv =>
          conv.id === selectedConversation.id
            ? { ...conv, lastMessage: sentMessage, updatedAt: new Date() }
            : conv
        ))
      } else {
        toast.error(result.error || 'Failed to send message')
      }
    } catch (error) {
      console.error('Failed to send message:', error)
      toast.error('Failed to send message')
    } finally {
      setIsSending(false)
    }
  }

  const filteredConversations = conversations.filter(conv =>
    conv.participantId.toLowerCase().includes(searchQuery.toLowerCase()) ||
    conv.participantUsername?.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const startNewConversation = async () => {
    if (!newConversationInput.trim() || !user || isResolvingUser) return

    setIsResolvingUser(true)
    const input = newConversationInput.trim()

    try {
      let participantId: string
      let participantUsername: string | undefined

      // Check if input looks like an identity ID (base58, ~44 chars) or a username
      if (input.length > 30 && !input.includes('.')) {
        // Likely an identity ID - verify it exists
        participantId = input
        try {
          const identity = await identityService.getIdentity(participantId)
          if (!identity) {
            toast.error('Identity not found')
            return
          }
          // Try to resolve username for this identity
          participantUsername = await dpnsService.resolveUsername(participantId) || undefined
        } catch (err) {
          console.error('Error verifying identity:', err)
          toast.error('Could not verify identity. Please check the ID.')
          return
        }
      } else {
        // Treat as username - resolve to identity ID
        const username = input.replace(/\.dash$/, '') // Remove .dash suffix if present
        const resolvedId = await dpnsService.resolveIdentity(username)
        if (!resolvedId) {
          toast.error(`Username "${username}" not found`)
          return
        }
        participantId = resolvedId
        participantUsername = username
      }

      // Don't start conversation with yourself
      if (participantId === user.identityId) {
        toast.error("You can't message yourself")
        return
      }

      // Check if conversation already exists
      const existingConv = conversations.find(c => c.participantId === participantId)
      if (existingConv) {
        setSelectedConversation(existingConv)
        setShowNewConversation(false)
        setNewConversationInput('')
        return
      }

      // Get participant's display name
      let participantDisplayName: string | undefined
      try {
        const profile = await unifiedProfileService.getProfile(participantId)
        participantDisplayName = profile?.displayName
      } catch {
        // Ignore profile errors
      }

      // Create new conversation entry
      const { conversationId } = await directMessageService.getOrCreateConversation(
        user.identityId,
        participantId
      )

      const newConv: Conversation = {
        id: conversationId,
        participantId,
        participantUsername,
        participantDisplayName,
        unreadCount: 0,
        updatedAt: new Date()
      }

      setConversations(prev => [newConv, ...prev])
      setSelectedConversation(newConv)
      setShowNewConversation(false)
      setNewConversationInput('')
      setMessages([]) // Clear messages for new conversation
    } catch (error) {
      console.error('Failed to start conversation:', error)
      toast.error('Failed to start conversation')
    } finally {
      setIsResolvingUser(false)
    }
  }

  const selectUserFromSearch = async (selectedUser: UserSearchResult) => {
    if (!user || isResolvingUser) return

    setIsResolvingUser(true)

    try {
      // Check if conversation already exists
      const existingConv = conversations.find(c => c.participantId === selectedUser.id)
      if (existingConv) {
        setSelectedConversation(existingConv)
        setShowNewConversation(false)
        setNewConversationInput('')
        setUserSearchResults([])
        return
      }

      // Create new conversation entry
      const { conversationId } = await directMessageService.getOrCreateConversation(
        user.identityId,
        selectedUser.id
      )

      const newConv: Conversation = {
        id: conversationId,
        participantId: selectedUser.id,
        participantUsername: selectedUser.username,
        participantDisplayName: selectedUser.displayName,
        unreadCount: 0,
        updatedAt: new Date()
      }

      setConversations(prev => [newConv, ...prev])
      setSelectedConversation(newConv)
      setShowNewConversation(false)
      setNewConversationInput('')
      setUserSearchResults([])
      setMessages([])
    } catch (error) {
      console.error('Failed to start conversation:', error)
      toast.error('Failed to start conversation')
    } finally {
      setIsResolvingUser(false)
    }
  }

  return (
    <div className="h-[calc(100dvh-32px-56px)] md:h-[calc(100dvh-40px)] flex overflow-hidden">
      <Sidebar />

      <main className="flex-1 md:max-w-[1200px] md:border-x border-gray-200 dark:border-gray-800 flex overflow-hidden">
        {/* Conversations List */}
        <div className={`w-full md:w-[320px] lg:w-[380px] xl:w-[400px] border-r border-gray-200 dark:border-gray-800 flex flex-col flex-shrink-0 overflow-hidden ${selectedConversation ? 'hidden md:flex' : 'flex'}`}>
          <header className="flex-shrink-0 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
            <div className="flex items-center justify-between px-3 sm:px-4 py-2 sm:py-3">
              <h1 className="text-lg sm:text-xl font-display font-bold">Messages</h1>
              <button
                onClick={() => setShowNewConversation(true)}
                className="p-1.5 sm:p-2 hover:bg-gray-100 dark:hover:bg-gray-900 rounded-full"
              >
                <PlusIcon className="h-5 w-5" />
              </button>
            </div>

            <div className="px-3 sm:px-4 pb-2 sm:pb-3">
              <div className="relative">
                <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 sm:h-5 sm:w-5 text-gray-500" />
                <Input
                  type="text"
                  placeholder="Search messages"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9 sm:pl-10 h-9 sm:h-10 text-base"
                />
              </div>
            </div>
          </header>

          {isLoading ? (
            <div className="p-8 text-center">
              <Spinner size="md" className="mx-auto mb-4" />
              <p className="text-gray-500">Loading conversations...</p>
            </div>
          ) : conversations.length === 0 ? (
            /* When no conversations exist, show minimal state - main empty state is in right panel */
            <div className="p-6 text-center text-gray-500 text-sm">
              <p>Your conversations will appear here</p>
            </div>
          ) : filteredConversations.length === 0 ? (
            <div className="p-8 text-center flex-1 flex flex-col items-center justify-center">
              <MagnifyingGlassIcon className="h-12 w-12 text-gray-300 mb-4" />
              <h2 className="text-xl font-semibold mb-2">No results</h2>
              <p className="text-gray-500 text-sm">No conversations match your search</p>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto">
              {filteredConversations.map((conversation) => (
                <button
                  key={conversation.id}
                  onClick={() => setSelectedConversation(conversation)}
                  className={`w-full p-3 sm:p-4 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors flex gap-3 ${
                    selectedConversation?.id === conversation.id ? 'bg-gray-50 dark:bg-gray-950' : ''
                  }`}
                >
                  <div className="h-10 w-10 sm:h-12 sm:w-12 rounded-full overflow-hidden bg-white dark:bg-gray-900 flex-shrink-0">
                    <UserAvatar userId={conversation.participantId} size="lg" alt="User avatar" />
                  </div>

                  <div className="flex-1 text-left min-w-0">
                    <div className="flex items-center justify-between gap-2 mb-0.5">
                      <span className="font-semibold truncate">
                        {conversation.participantDisplayName || conversation.participantUsername || `${conversation.participantId.slice(0, 8)}...`}
                      </span>
                      {conversation.lastMessage && (
                        <span className="text-xs text-gray-500 flex-shrink-0">
                          {formatDistanceToNow(conversation.lastMessage.createdAt, { addSuffix: true })}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 truncate mb-1">
                      {conversation.participantUsername || `${conversation.participantId.slice(0, 12)}...`}
                    </p>
                    {conversation.lastMessage && (
                      <p className="text-sm text-gray-600 dark:text-gray-400 truncate">
                        {conversation.lastMessage.senderId === user?.identityId && 'You: '}
                        {conversation.lastMessage.content}
                      </p>
                    )}
                  </div>

                  {conversation.unreadCount > 0 && (
                    <div className="flex items-center flex-shrink-0">
                      <div className="bg-yappr-500 text-white text-xs rounded-full h-5 w-5 flex items-center justify-center">
                        {conversation.unreadCount}
                      </div>
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Message Thread */}
        {selectedConversation ? (
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            <header className="flex-shrink-0 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-2 sm:px-4 py-2 sm:py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
                  {/* Back button - mobile only */}
                  <button
                    onClick={() => setSelectedConversation(null)}
                    className="md:hidden p-1.5 -ml-1 hover:bg-gray-100 dark:hover:bg-gray-900 rounded-full flex-shrink-0"
                  >
                    <ArrowLeftIcon className="h-5 w-5" />
                  </button>
                  <Link
                    href={`/user?id=${selectedConversation.participantId}`}
                    className="flex items-center gap-2 sm:gap-3 hover:opacity-80 transition-opacity min-w-0 flex-1"
                  >
                    <div className="h-8 w-8 sm:h-10 sm:w-10 rounded-full overflow-hidden bg-white dark:bg-gray-900 flex-shrink-0">
                      <UserAvatar userId={selectedConversation.participantId} size="md" alt="User avatar" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold truncate text-sm sm:text-base">
                        {selectedConversation.participantDisplayName || selectedConversation.participantUsername || `${selectedConversation.participantId.slice(0, 8)}...`}
                      </p>
                      <p className="text-xs text-gray-500 truncate hidden sm:block">
                        {selectedConversation.participantUsername || `${selectedConversation.participantId.slice(0, 12)}...`}
                      </p>
                    </div>
                  </Link>
                </div>

                <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
                  <button className="p-1.5 sm:p-2 hover:bg-gray-100 dark:hover:bg-gray-900 rounded-full">
                    <InformationCircleIcon className="h-5 w-5" />
                  </button>
                  <button className="hidden sm:block p-2 hover:bg-gray-100 dark:hover:bg-gray-900 rounded-full">
                    <EllipsisHorizontalIcon className="h-5 w-5" />
                  </button>
                </div>
              </div>
            </header>

            <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-3 sm:space-y-4">
              {isLoadingMessages ? (
                <div className="flex items-center justify-center h-full">
                  <Spinner size="md" />
                </div>
              ) : messages.length === 0 ? (
                <div className="flex items-center justify-center h-full text-gray-500">
                  <p>No messages yet. Start the conversation!</p>
                </div>
              ) : (
                messages.map((message, index) => {
                  const isOwn = message.senderId === user?.identityId
                  // Check if this sent message was read by the other party
                  const isRead = isOwn && participantLastRead && message.createdAt.getTime() <= participantLastRead
                  // Only show "Read" on the last read message (not all of them)
                  const isLastReadMessage = isRead && (
                    index === messages.length - 1 ||
                    !messages.slice(index + 1).some(m =>
                      m.senderId === user?.identityId && m.createdAt.getTime() <= participantLastRead
                    )
                  )
                  return (
                    <motion.div
                      key={message.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className={`flex ${isOwn ? 'justify-end' : 'justify-start'}`}
                    >
                      <div className={`max-w-[85%] sm:max-w-[75%] md:max-w-[70%] ${isOwn ? 'order-2' : 'order-1'}`}>
                        {(() => {
                          const emojiOnly = isEmojiOnly(message.content)
                          return emojiOnly ? (
                            <p className={`text-4xl leading-tight ${isOwn ? 'text-right' : 'text-left'}`}>{message.content}</p>
                          ) : (
                            <div
                              className={`px-4 py-2 rounded-2xl ${
                                isOwn
                                  ? 'bg-yappr-500 text-white'
                                  : 'bg-gray-100 dark:bg-gray-900'
                              }`}
                            >
                              <p className="text-sm">{message.content}</p>
                            </div>
                          )
                        })()}
                        <div className={`flex items-center gap-1 mt-1 px-2 ${isOwn ? 'justify-end' : 'justify-start'}`}>
                          <p className="text-xs text-gray-500">
                            {formatDistanceToNow(message.createdAt, { addSuffix: true })}
                          </p>
                          {isLastReadMessage && (
                            <span className="text-xs text-yappr-500 font-medium">· Read</span>
                          )}
                        </div>
                      </div>
                    </motion.div>
                  )
                })
              )}
            </div>

            <div className="flex-shrink-0 border-t border-gray-200 dark:border-gray-800 p-2 sm:p-4 safe-area-inset-bottom">
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  sendMessage().catch(err => console.error('Failed to send message:', err))
                }}
                className="flex items-center gap-2"
              >
                <EmojiPicker
                  onEmojiSelect={(emoji) => setNewMessage(prev => prev + emoji)}
                  disabled={isSending}
                />

                <Input
                  type="text"
                  placeholder="Type a message..."
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  disabled={isSending}
                  className="flex-1 min-w-0 h-9 sm:h-10 text-base"
                />

                <Button
                  type="submit"
                  size="sm"
                  disabled={!newMessage.trim() || isSending}
                  className="flex-shrink-0 h-9 w-9 sm:h-10 sm:w-10 p-0"
                >
                  {isSending ? (
                    <Spinner size="sm" className="border-white" />
                  ) : (
                    <PaperAirplaneIcon className="h-4 w-4" />
                  )}
                </Button>
              </form>
            </div>
          </div>
        ) : conversations.length === 0 ? (
          /* Primary empty state when user has no conversations */
          <div className="flex flex-1 items-center justify-center p-8">
            <div className="text-center max-w-sm">
              <PaperAirplaneIcon className="h-16 w-16 text-gray-300 mx-auto mb-4" />
              <h2 className="text-2xl font-semibold mb-2">Welcome to Messages</h2>
              <p className="text-gray-500 mb-2">
                Have private 1-on-1 conversations with other users.
              </p>
              <p className="text-gray-400 text-sm mb-6">
                Messages are stored securely on Dash Platform.
              </p>
              <Button
                onClick={() => setShowNewConversation(true)}
                className="gap-2"
              >
                <PlusIcon className="h-5 w-5" />
                New message
              </Button>
            </div>
          </div>
        ) : (
          /* Secondary empty state when conversations exist but none selected */
          <div className="hidden md:flex flex-1 items-center justify-center p-8">
            <div className="text-center">
              <PaperAirplaneIcon className="h-16 w-16 text-gray-300 mx-auto mb-4" />
              <h2 className="text-2xl font-semibold mb-2">Select a conversation</h2>
              <p className="text-gray-500 mb-6">Choose from your existing conversations or start a new one</p>
              <Button
                onClick={() => setShowNewConversation(true)}
                className="gap-2"
              >
                <PlusIcon className="h-5 w-5" />
                New message
              </Button>
            </div>
          </div>
        )}
      </main>

      {/* New Conversation Modal */}
      {showNewConversation && (
        <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center pt-16 sm:pt-0">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => {
              setShowNewConversation(false)
              setNewConversationInput('')
              setUserSearchResults([])
            }}
          />
          <div className="relative bg-white dark:bg-gray-900 rounded-2xl w-full max-w-md mx-3 sm:mx-4 p-4 sm:p-6 shadow-xl max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-display font-bold">New Message</h2>
              <button
                onClick={() => {
                  setShowNewConversation(false)
                  setNewConversationInput('')
                  setUserSearchResults([])
                }}
                className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault()
                startNewConversation().catch(err => console.error('Failed to start conversation:', err))
              }}
            >
              <div className="mb-4">
                <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">
                  Search for a user
                </label>
                <div className="relative">
                  <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                  <Input
                    type="text"
                    placeholder="Search by username..."
                    value={newConversationInput}
                    onChange={(e) => setNewConversationInput(e.target.value)}
                    disabled={isResolvingUser}
                    autoFocus
                    className="pl-10"
                  />
                </div>
                <p className="text-xs text-gray-500 mt-2">
                  Type at least 3 characters to search, or paste a full identity ID
                </p>
              </div>

              {/* Search Results */}
              {(isSearchingUsers || userSearchResults.length > 0) && (
                <div className="mb-4 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
                  {isSearchingUsers ? (
                    <div className="p-4 flex items-center justify-center gap-2 text-gray-500">
                      <Spinner size="sm" className="border-gray-500" />
                      <span className="text-sm">Searching...</span>
                    </div>
                  ) : (
                    <div className="max-h-64 overflow-y-auto">
                      {userSearchResults.map((result) => (
                        <button
                          key={result.id}
                          type="button"
                          onClick={() => selectUserFromSearch(result)}
                          disabled={isResolvingUser}
                          className="w-full flex items-center gap-3 p-3 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors text-left border-b border-gray-100 dark:border-gray-800 last:border-b-0"
                        >
                          <div className="h-10 w-10 rounded-full overflow-hidden bg-gray-100 dark:bg-gray-800 flex-shrink-0">
                            <UserAvatar userId={result.id} size="md" alt={result.displayName} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="font-semibold truncate">{result.displayName}</p>
                            <p className="text-sm text-gray-500 truncate">@{result.username}</p>
                            {result.bio && (
                              <p className="text-xs text-gray-400 truncate mt-0.5">{result.bio}</p>
                            )}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Show no results message */}
              {!isSearchingUsers && userSearchResults.length === 0 && newConversationInput.trim().length >= 3 && newConversationInput.trim().length <= 30 && (
                <div className="mb-4 p-3 text-center text-sm text-gray-500 border border-gray-200 dark:border-gray-700 rounded-xl">
                  No users found matching &quot;{newConversationInput.trim()}&quot;
                </div>
              )}

              <div className="flex gap-3">
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1"
                  onClick={() => {
                    setShowNewConversation(false)
                    setNewConversationInput('')
                    setUserSearchResults([])
                  }}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  className="flex-1"
                  disabled={!newConversationInput.trim() || isResolvingUser}
                >
                  {isResolvingUser ? (
                    <Spinner size="sm" className="border-white" />
                  ) : (
                    'Start Chat'
                  )}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

export default withAuth(MessagesPage)