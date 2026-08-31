'use client'

import { useState } from 'react'
import { ArrowTopRightOnSquareIcon, DocumentDuplicateIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { useCopy } from '@/hooks/use-copy'
import { buildVisualizerLink, PROOF_VISUALIZER_URL } from '@/lib/query-inspector/proof-link'
import type { QueryRecord } from '@/lib/query-inspector/types'
import { logger } from '@/lib/logger'

export function ProofView({ record }: { record: QueryRecord }) {
  const copy = useCopy()
  const [opening, setOpening] = useState(false)
  const proof = record.proof

  if (!proof) {
    return (
      <p className="py-8 text-center text-xs text-gray-500">
        {record.proofStatus === 'proof-failed'
          ? `The proof-carrying request failed: ${record.proofError ?? 'unknown error'}`
          : 'No proof — this call type doesn’t return a GroveDB proof (writes and local helpers).'}
      </p>
    )
  }

  const openInVisualizer = () => {
    setOpening(true)
    buildVisualizerLink(proof.grovedbProofHex)
      .then((link) => {
        if (link) {
          window.open(link, '_blank', 'noopener')
        } else {
          // Proof too large for a URL (or no CompressionStream): hand over the
          // hex and let the user paste it into the visualizer.
          copy(proof.grovedbProofHex, 'Proof hex copied — paste it into the visualizer')
          window.open(PROOF_VISUALIZER_URL, '_blank', 'noopener')
        }
      })
      .catch((error) => logger.error('Failed to build proof visualizer link:', error))
      .finally(() => setOpening(false))
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={openInVisualizer} disabled={opening}>
          <ArrowTopRightOnSquareIcon className="mr-1.5 h-4 w-4" />
          Open in proof visualizer
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => copy(proof.grovedbProofHex, 'Proof hex copied')}
        >
          <DocumentDuplicateIcon className="mr-1.5 h-4 w-4" />
          Copy proof hex
        </Button>
      </div>

      <div>
        <HexFieldLabel
          label={`GroveDB proof (${proof.grovedbProofBytes.toLocaleString()} bytes)`}
          onCopy={() => copy(proof.grovedbProofHex, 'Proof hex copied')}
        />
        <pre className="max-h-40 overflow-y-auto rounded-lg border border-gray-200 dark:border-neutral-800 bg-gray-50 dark:bg-neutral-900 p-3 font-mono text-[10px] leading-relaxed text-gray-800 dark:text-gray-200 break-all whitespace-pre-wrap">
          {proof.grovedbProofHex}
        </pre>
        <FieldNote note="bincode-encoded GroveDB merk proof — the Merkle path from the signed root hash down to this result." />
      </div>

      <HexField
        label="Quorum hash"
        hex={proof.quorumHashHex}
        note="Identifies the masternode quorum that signed the block."
      />
      <HexField
        label="BLS signature"
        hex={proof.signatureHex}
        note="Threshold signature by the quorum over the block, verified in-browser."
      />
      <HexField
        label="Block ID hash"
        hex={proof.blockIdHashHex}
        note="Tenderdash block this proof is anchored to."
      />

      <div className="flex gap-8">
        <div>
          <p className="text-xs text-gray-500">Round</p>
          <p className="font-mono text-xs text-gray-900 dark:text-gray-100">{proof.round}</p>
          <FieldNote note="Consensus round that finalized the block." />
        </div>
        <div>
          <p className="text-xs text-gray-500">Quorum type</p>
          <p className="font-mono text-xs text-gray-900 dark:text-gray-100">{proof.quorumType}</p>
          <FieldNote note="LLMQ type of the signing quorum." />
        </div>
      </div>
    </div>
  )
}

function HexFieldLabel({ label, onCopy }: { label: string; onCopy: () => void }) {
  return (
    <div className="mb-1 flex items-center justify-between">
      <span className="text-xs text-gray-500">{label}</span>
      <button
        onClick={onCopy}
        aria-label={`Copy ${label}`}
        className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
      >
        <DocumentDuplicateIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

function FieldNote({ note }: { note: string }) {
  return <p className="mt-1 text-[10px] text-gray-400 dark:text-gray-600">{note}</p>
}

function HexField({ label, hex, note }: { label: string; hex: string; note: string }) {
  const copy = useCopy()
  return (
    <div>
      <HexFieldLabel label={label} onCopy={() => copy(hex, `${label} copied`)} />
      <p className="break-all font-mono text-[10px] leading-relaxed text-gray-800 dark:text-gray-200">
        {hex}
      </p>
      <FieldNote note={note} />
    </div>
  )
}
