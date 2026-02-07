'use client'

import { useState } from 'react'
import { UsernamesModal } from './usernames-modal'

interface AlsoKnownAsProps {
  primaryUsername: string
  allUsernames: string[]
  identityId: string
}

export function AlsoKnownAs({ primaryUsername, allUsernames, identityId }: AlsoKnownAsProps) {
  const [showModal, setShowModal] = useState(false)
  
  // Filter out the primary username from the list
  const otherUsernames = allUsernames.filter(u => u !== primaryUsername)
  
  if (otherUsernames.length === 0) {
    return null
  }
  
  const renderAlsoKnownAs = () => {
    if (otherUsernames.length === 1) {
      return (
        <span className="text-xs text-gray-500">
          also known as <span className="font-medium">@{otherUsernames[0]}</span>
        </span>
      )
    } else if (otherUsernames.length === 2) {
      return (
        <span className="text-xs text-gray-500">
          also known as <span className="font-medium">@{otherUsernames[0]}</span> and <span className="font-medium">@{otherUsernames[1]}</span>
        </span>
      )
    } else {
      // More than 2 other usernames
      return (
        <span className="text-xs text-gray-500">
          also known as <span className="font-medium">@{otherUsernames[0]}</span> and{' '}
          <button
            onClick={() => setShowModal(true)}
            className="font-medium text-yappr-500 hover:text-yappr-600 hover:underline"
          >
            {otherUsernames.length - 1} others
          </button>
        </span>
      )
    }
  }
  
  return (
    <>
      {renderAlsoKnownAs()}
      <UsernamesModal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        usernames={allUsernames}
        primaryUsername={primaryUsername}
        identityId={identityId}
      />
    </>
  )
}