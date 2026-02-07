'use client'

import { useState } from 'react'
import { ArrowLeftIcon, DocumentDuplicateIcon, CheckIcon, CodeBracketIcon } from '@heroicons/react/24/outline'
import Link from 'next/link'
import { motion } from 'framer-motion'
import toast from 'react-hot-toast'
import contractDocuments from '@/contracts/yappr-social-contract-actual.json'

// Wrap the actual contract documents in the expected format
const dataContract = {
  version: 7,
  documents: contractDocuments
}

export default function ContractPage() {
  const [copied, setCopied] = useState(false)
  const contractString = JSON.stringify(dataContract, null, 2)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(contractString)
      setCopied(true)
      toast.success('Contract copied to clipboard')
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      toast.error('Failed to copy contract')
    }
  }

  const documentCount = Object.keys(dataContract.documents).length
  const totalIndices = Object.values(dataContract.documents).reduce((acc, doc: any) => 
    acc + (doc.indices?.length || 0), 0
  )

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="mb-8">
          <Link 
            href="/" 
            className="inline-flex items-center gap-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
          >
            <ArrowLeftIcon className="h-4 w-4" />
            Back to Yappr
          </Link>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white dark:bg-gray-900 rounded-2xl shadow-lg overflow-hidden"
        >
          <div className="bg-gradient-yappr p-8 text-white">
            <div className="flex items-center gap-3 mb-4">
              <CodeBracketIcon className="h-8 w-8" />
              <h1 className="text-3xl font-bold">Yappr Data Contract</h1>
            </div>
            <p className="text-lg opacity-90 mb-6">
              Dash Platform data contract for the Yappr social media platform
            </p>
            <div className="flex gap-6 text-sm">
              <div>
                <span className="opacity-75">Version:</span> {dataContract.version}
              </div>
              <div>
                <span className="opacity-75">Documents:</span> {documentCount}
              </div>
              <div>
                <span className="opacity-75">Indices:</span> {totalIndices}
              </div>
            </div>
          </div>

          <div className="p-8">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-semibold">Contract Definition</h2>
              <button
                onClick={handleCopy}
                className="flex items-center gap-2 px-4 py-2 bg-gray-100 dark:bg-gray-900 hover:bg-gray-200 dark:hover:bg-gray-800 rounded-lg transition-colors"
              >
                {copied ? (
                  <>
                    <CheckIcon className="h-4 w-4 text-green-500" />
                    <span className="text-green-500">Copied!</span>
                  </>
                ) : (
                  <>
                    <DocumentDuplicateIcon className="h-4 w-4" />
                    <span>Copy Contract</span>
                  </>
                )}
              </button>
            </div>

            <div className="bg-gray-900 rounded-lg p-4 overflow-x-auto">
              <pre className="text-sm text-gray-300 font-mono whitespace-pre">
                <code>{contractString}</code>
              </pre>
            </div>

            <div className="mt-8 grid md:grid-cols-2 gap-6">
              <div className="bg-gray-50 dark:bg-gray-950 rounded-lg p-6">
                <h3 className="font-semibold mb-4">Document Types</h3>
                <ul className="space-y-2 text-sm">
                  {Object.keys(dataContract.documents).map((docType) => (
                    <li key={docType} className="flex items-center gap-2">
                      <div className="h-2 w-2 bg-yappr-500 rounded-full" />
                      <span className="font-mono">{docType}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="bg-gray-50 dark:bg-gray-950 rounded-lg p-6">
                <h3 className="font-semibold mb-4">Key Features</h3>
                <ul className="space-y-2 text-sm">
                  <li className="flex items-center gap-2">
                    <div className="h-2 w-2 bg-green-500 rounded-full" />
                    <span>500 character posts</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <div className="h-2 w-2 bg-green-500 rounded-full" />
                    <span>Media attachments</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <div className="h-2 w-2 bg-green-500 rounded-full" />
                    <span>Encrypted DMs</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <div className="h-2 w-2 bg-green-500 rounded-full" />
                    <span>User verification</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <div className="h-2 w-2 bg-green-500 rounded-full" />
                    <span>Lists & bookmarks</span>
                  </li>
                </ul>
              </div>
            </div>

            <div className="mt-8 p-6 bg-yappr-50 dark:bg-yappr-950 rounded-lg">
              <h3 className="font-semibold mb-2">Deployment Instructions</h3>
              <ol className="space-y-2 text-sm list-decimal list-inside">
                <li>Update the <code className="bg-white dark:bg-gray-900 px-2 py-1 rounded">ownerId</code> field with your Dash identity ID</li>
                <li>Use the Dash SDK to register the contract on Platform</li>
                <li>Fund the contract with credits for storage operations</li>
                <li>Start building your decentralized social network!</li>
              </ol>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  )
}