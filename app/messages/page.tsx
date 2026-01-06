'use client'

import { useState, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import {
  MagnifyingGlassIcon,
  PaperAirplaneIcon,
  PhotoIcon,
  FaceSmileIcon,
  InformationCircleIcon,
  EllipsisHorizontalIcon,
  PlusIcon
} from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { UserAvatar } from '@/components/ui/avatar-image'
import { formatDistanceToNow } from 'date-fns'
import { directMessageService, dpnsService, identityService } from '@/lib/services'
import { DirectMessage, Conversation } from '@/lib/types'
import toast from 'react-hot-toast'
import { XMarkIcon, ArrowLeftIcon } from '@heroicons/react/24/outline'

function MessagesPage() {
  const { user } = useAuth()
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null)
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
    loadConversations()
  }, [user])

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

        // Only mark as read if there are unread messages
        if (selectedConversation.unreadCount > 0) {
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
    loadMessages()
  }, [selectedConversation, user])

  // Poll for new messages in active conversation (1 query per poll)
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
        // Get existing message IDs from ref to avoid re-processing
        const existingIds = new Set(messagesRef.current.map(m => m.id))

        // Single query - only returns NEW messages (already decrypted)
        const newMsgs = await directMessageService.pollNewMessages(
          currentConv.id,
          existingIds,
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

  const sendMessage = async () => {
    if (!newMessage.trim() || !selectedConversation || !user || isSending) return

    const messageContent = newMessage.trim()
    setNewMessage('') // Clear input immediately for better UX
    setIsSending(true)

    try {
      const result = await directMessageService.sendMessage(
        user.identityId,
        selectedConversation.participantId,
        messageContent
      )

      if (result.success && result.message) {
        // Add message to UI (with deduplication in case poll already added it)
        setMessages(prev => {
          const msg = result.message!
          // Check if poll already added this message (with real ID while we have temp)
          const alreadyExists = prev.some(m =>
            m.id === msg.id ||
            (m.senderId === msg.senderId &&
             m.content === msg.content &&
             Math.abs(m.createdAt.getTime() - msg.createdAt.getTime()) < 60000)
          )
          return alreadyExists ? prev : [...prev, msg]
        })

        // Update conversation's last message
        setConversations(prev => prev.map(conv =>
          conv.id === selectedConversation.id
            ? { ...conv, lastMessage: result.message!, updatedAt: new Date() }
            : conv
        ))
      } else {
        toast.error(result.error || 'Failed to send message')
        setNewMessage(messageContent) // Restore message on failure
      }
    } catch (error) {
      console.error('Failed to send message:', error)
      toast.error('Failed to send message')
      setNewMessage(messageContent) // Restore message on failure
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

      // Create new conversation entry
      const { conversationId } = await directMessageService.getOrCreateConversation(
        user.identityId,
        participantId
      )

      const newConv: Conversation = {
        id: conversationId,
        participantId,
        participantUsername,
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

  return (
    <div className="h-[calc(100vh-40px)] flex overflow-hidden">
      <Sidebar />

      <main className="flex-1 md:max-w-[1200px] md:border-x border-gray-200 dark:border-gray-800 flex overflow-hidden">
        {/* Conversations List */}
        <div className={`w-full md:w-[320px] lg:w-[380px] xl:w-[400px] border-r border-gray-200 dark:border-gray-800 flex flex-col flex-shrink-0 overflow-hidden ${selectedConversation ? 'hidden md:flex' : 'flex'}`}>
          <header className="flex-shrink-0 bg-white dark:bg-neutral-900 border-b border-gray-200 dark:border-gray-800">
            <div className="flex items-center justify-between px-4 py-3">
              <h1 className="text-xl font-bold">Messages</h1>
              <button
                onClick={() => setShowNewConversation(true)}
                className="p-2 hover:bg-gray-100 dark:hover:bg-gray-900 rounded-full"
              >
                <PlusIcon className="h-5 w-5" />
              </button>
            </div>
            
            <div className="px-4 pb-3">
              <div className="relative">
                <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-500" />
                <Input
                  type="text"
                  placeholder="Search messages"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>
          </header>

          {isLoading ? (
            <div className="p-8 text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto mb-4"></div>
              <p className="text-gray-500">Loading conversations...</p>
            </div>
          ) : filteredConversations.length === 0 ? (
            <div className="p-8 text-center flex-1 flex flex-col items-center justify-center">
              <PaperAirplaneIcon className="h-12 w-12 text-gray-300 mb-4" />
              <h2 className="text-xl font-semibold mb-2">No messages yet</h2>
              <p className="text-gray-500 text-sm">When someone messages you, it&apos;ll show up here</p>
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
                  <div className="h-10 w-10 sm:h-12 sm:w-12 rounded-full overflow-hidden bg-white dark:bg-neutral-900 flex-shrink-0">
                    <UserAvatar userId={conversation.participantId} size="lg" alt="User avatar" />
                  </div>

                  <div className="flex-1 text-left min-w-0">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="font-semibold truncate">
                        {conversation.participantUsername || `${conversation.participantId.slice(0, 8)}...`}
                      </span>
                      {conversation.lastMessage && (
                        <span className="text-xs text-gray-500 flex-shrink-0">
                          {formatDistanceToNow(conversation.lastMessage.createdAt, { addSuffix: true })}
                        </span>
                      )}
                    </div>
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
            <header className="flex-shrink-0 bg-white dark:bg-neutral-900 border-b border-gray-200 dark:border-gray-800 px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {/* Back button - mobile only */}
                  <button
                    onClick={() => setSelectedConversation(null)}
                    className="md:hidden p-2 -ml-2 hover:bg-gray-100 dark:hover:bg-gray-900 rounded-full"
                  >
                    <ArrowLeftIcon className="h-5 w-5" />
                  </button>
                  <div className="h-10 w-10 rounded-full overflow-hidden bg-white dark:bg-neutral-900 flex-shrink-0">
                    <UserAvatar userId={selectedConversation.participantId} size="md" alt="User avatar" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold truncate">
                      {selectedConversation.participantUsername || `${selectedConversation.participantId.slice(0, 8)}...`}
                    </p>
                    <p className="text-xs text-gray-500 truncate">{selectedConversation.participantId.slice(0, 12)}...</p>
                  </div>
                </div>
                
                <div className="flex items-center gap-2">
                  <button className="p-2 hover:bg-gray-100 dark:hover:bg-gray-900 rounded-full">
                    <InformationCircleIcon className="h-5 w-5" />
                  </button>
                  <button className="p-2 hover:bg-gray-100 dark:hover:bg-gray-900 rounded-full">
                    <EllipsisHorizontalIcon className="h-5 w-5" />
                  </button>
                </div>
              </div>
            </header>

            <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-3 sm:space-y-4">
              {isLoadingMessages ? (
                <div className="flex items-center justify-center h-full">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600"></div>
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
                        <div
                          className={`px-4 py-2 rounded-2xl ${
                            isOwn
                              ? 'bg-yappr-500 text-white'
                              : 'bg-gray-100 dark:bg-gray-900'
                          }`}
                        >
                          <p className="text-sm">{message.content}</p>
                        </div>
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

            <div className="flex-shrink-0 border-t border-gray-200 dark:border-gray-800 p-3 sm:p-4">
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  sendMessage()
                }}
                className="flex items-center gap-1 sm:gap-2"
              >
                <button
                  type="button"
                  className="p-2 hover:bg-gray-100 dark:hover:bg-gray-900 rounded-full flex-shrink-0"
                >
                  <PhotoIcon className="h-5 w-5" />
                </button>

                <Input
                  type="text"
                  placeholder="Type a message..."
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  disabled={isSending}
                  className="flex-1 min-w-0"
                />

                <button
                  type="button"
                  className="p-2 hover:bg-gray-100 dark:hover:bg-gray-900 rounded-full flex-shrink-0 hidden sm:block"
                >
                  <FaceSmileIcon className="h-5 w-5" />
                </button>

                <Button
                  type="submit"
                  size="sm"
                  disabled={!newMessage.trim() || isSending}
                  className="flex-shrink-0"
                >
                  {isSending ? (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                  ) : (
                    <PaperAirplaneIcon className="h-4 w-4" />
                  )}
                </Button>
              </form>
            </div>
          </div>
        ) : (
          <div className="hidden md:flex flex-1 items-center justify-center p-8">
            <div className="text-center">
              <PaperAirplaneIcon className="h-16 w-16 text-gray-300 mx-auto mb-4" />
              <h2 className="text-2xl font-semibold mb-2">Select a message</h2>
              <p className="text-gray-500">Choose from your existing conversations or start a new one</p>
            </div>
          </div>
        )}
      </main>

      {/* New Conversation Modal */}
      {showNewConversation && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setShowNewConversation(false)}
          />
          <div className="relative bg-white dark:bg-gray-900 rounded-2xl w-full max-w-md mx-4 p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold">New Message</h2>
              <button
                onClick={() => setShowNewConversation(false)}
                className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault()
                startNewConversation()
              }}
            >
              <div className="mb-4">
                <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">
                  Username or Identity ID
                </label>
                <Input
                  type="text"
                  placeholder="Enter username (e.g., alice) or identity ID"
                  value={newConversationInput}
                  onChange={(e) => setNewConversationInput(e.target.value)}
                  disabled={isResolvingUser}
                  autoFocus
                />
                <p className="text-xs text-gray-500 mt-2">
                  Enter a DPNS username or paste a full identity ID
                </p>
              </div>

              <div className="flex gap-3">
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1"
                  onClick={() => setShowNewConversation(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  className="flex-1"
                  disabled={!newConversationInput.trim() || isResolvingUser}
                >
                  {isResolvingUser ? (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
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