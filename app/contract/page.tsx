'use client'

import { useState } from 'react'
import { DocumentDuplicateIcon, CheckIcon, CodeBracketIcon } from '@heroicons/react/24/outline'
import { InfoPage } from '@/components/layout/info-page'
import toast from 'react-hot-toast'
import socialContractV2 from '@/contracts/yappr-social-contract-v2.json'
import socialContractV4 from '@/contracts/yappr-social-contract-v4.json'
import socialContractV5 from '@/contracts/yappr-social-contract-v5.json'
import socialContractV6 from '@/contracts/yappr-social-contract-v6.json'
import { getContractTopology } from '@/lib/constants'

// The deployed social contract for this build's topology, reshaped for display.
// v3 was never promoted beyond devnet and has no checked-in contract file, so
// it falls through to the v2 contract.
const CONTRACTS_BY_TOPOLOGY = {
  v2: socialContractV2,
  v3: socialContractV2,
  v4: socialContractV4,
  v5: socialContractV5,
  v6: socialContractV6,
}
const socialContract = CONTRACTS_BY_TOPOLOGY[getContractTopology()]
const dataContract = {
  version: socialContract.version,
  documents: socialContract.documentSchemas
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
  const totalIndices = Object.values(dataContract.documents as Record<string, { indices?: unknown[] }>)
    .reduce((acc, doc) => acc + (doc.indices?.length || 0), 0)

  return (
    <InfoPage
      icon={CodeBracketIcon}
      title="Yappr Data Contract"
      subtitle="Dash Platform data contract for the Yappr social media platform"
      width="wide"
      headerExtra={
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
      }
    >
      <div>
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
                    <span>Private feeds</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <div className="h-2 w-2 bg-green-500 rounded-full" />
                    <span>User verification</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <div className="h-2 w-2 bg-green-500 rounded-full" />
                    <span>Bookmarks</span>
                  </li>
                </ul>
              </div>
            </div>

            <div className="mt-8 p-6 bg-yappr-50 dark:bg-yappr-950 rounded-lg">
              <h3 className="font-semibold mb-2">Deployment Instructions</h3>
              <ol className="space-y-2 text-sm list-decimal list-inside">
                <li>Update the <code className="bg-white dark:bg-neutral-900 px-2 py-1 rounded">ownerId</code> field with your Dash identity ID</li>
                <li>Use the Dash SDK to register the contract on Platform</li>
                <li>Fund the contract with credits for storage operations</li>
                <li>Start building your decentralized social network!</li>
              </ol>
            </div>
      </div>
    </InfoPage>
  )
}