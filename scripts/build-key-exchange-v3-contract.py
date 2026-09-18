#!/usr/bin/env python3
"""Builds contracts/key-exchange-v3.json from contracts/key-exchange-v2.json.

Deterministic transform (running it twice yields byte-identical output) so the
diff against the deployed v2 shape is reviewable as code. See
docs/KEY_EXCHANGE_V3.md for the rationale, the measured residue and the
wallet-compatibility caveat.

The document's PROPERTIES are byte-for-byte the v2 ones (plus a `refersTo` on
contractId): a wallet that writes a v2 response writes a valid v3 response. Only
the storage mode and the indexes change.

What v3 changes, on the single `loginKeyResponse` document type:

  indexOnly       the index entries ARE the rows — no primary-storage row, no
                  $id, no $revision, no per-index reference. A handshake
                  response is a set of index entries instead of a document plus
                  two unique-index trees.
  documentsMutable:false
                  forced by indexOnly (there is no row to mutate); the v2
                  contract never replaced a response either.
  canBeDeleted    spelled out as true (the contract default) because deleting
                  the spent handshake is the ONLY thing that clears its
                  permanent entries — see docs/KEY_EXCHANGE_V3.md.
  $createdAt      required, so the TTL'd index can bucket it. A writer still
                  sends nothing: consensus assigns the timestamp from block
                  time (the battery's creates carry none).
  contractId      gains `refersTo: {type: 'contract'}` — consensus now checks
                  the named application contract exists (40120 otherwise), and
                  the declaration is what lets `oneResponsePerHandshake` use
                  contractId as its terminal.
  unique indexes  gone: `unique` is refused on an indexOnly type because
                  uniqueness is structural (one entry per value tuple and
                  terminal). The two v2 unique indexes become four indexes.

THE BINDING CONSTRAINT, which is what decides every index below: drive refuses
a query whose bound fields leave more than `MAX_INDEX_DIFFERENCE = 2` unused
index properties ("query is too far from index"). `getResponse` binds exactly
two (contractId, appEphemeralPubKeyHash), so its index may carry at most two
properties below them, plus the terminal. Two properties + terminal is exactly
what the ECDH read needs — walletEphemeralPubKey, encryptedPayload, $ownerId —
so keyIndex and $createdAt have to be recovered by a second, differently-shaped
query. Every index is arranged so that each of the two reads matches exactly
one of them; see docs/KEY_EXCHANGE_V3.md for the routing table.

  byContractAndEphemeralKey
                  [contractId, appEphemeralPubKeyHash, walletEphemeralPubKey,
                   encryptedPayload] terminal $ownerId.
                  The polling read, v2's query shape unchanged. Difference 2.
                  Also the executed-transition PROOF index: drive takes the
                  FIRST index (indexes are held in a name-ordered map) that
                  involves no $createdAt and is not skipIfAbsent, and
                  "byContractAndEphemeralKey" sorts before the other
                  candidate, "oneResponsePerHandshake".
  byHandshakeMeta [appEphemeralPubKeyHash, keyIndex, $createdAt] terminal
                  $ownerId. The consume read: `where appEphemeralPubKeyHash ==
                  H` alone, difference 2, returning keyIndex and the
                  $createdAt a delete-by-values must reproduce (an indexOnly
                  type has no $id to delete by). It deliberately omits
                  contractId so the polling read can never match it.
  oneResponsePerHandshake
                  [$ownerId, appEphemeralPubKeyHash] terminal contractId.
                  Structural uniqueness on (wallet identity, handshake,
                  application): a wallet cannot write two different responses
                  to one login QR. $ownerId is FIRST and contractId is the
                  TERMINAL so that neither read can match this index — a
                  candidate covering a read with a smaller difference would win
                  the router and return a synthesized document without the
                  payload.
  byDay           [$createdAt, contractId, appEphemeralPubKeyHash] terminal
                  $ownerId, countable + rangeCountable, timeRange with a
                  2-day TTL. The ephemeral aggregate surface: "handshake
                  responses per application in the newest daily bucket". Its
                  bytes bill as processing at the ephemeral rate and drain
                  themselves.

Run:
  python3 scripts/build-key-exchange-v3-contract.py              # (re)write the v3 JSON
  python3 scripts/build-key-exchange-v3-contract.py --self-test  # assert the committed JSON
"""
import copy
import json
import sys

SRC = 'contracts/key-exchange-v2.json'
DST = 'contracts/key-exchange-v3.json'

DOC_TYPE = 'loginKeyResponse'

# Daily, non-overlapping buckets. `ttl` must be >= `range` and <= 604800 (the
# protocol-version-14 cap). Two days keeps today and yesterday queryable —
# enough for an operator to see a handshake spike — while draining faster and
# leaving less standing residue than the one-week ceiling would.
DAY = 86400
TIME_RANGE = {'on': '$createdAt', 'range': DAY, 'step': DAY, 'ttl': 2 * DAY}


def build(src):
    out = copy.deepcopy(src)
    doc = out[DOC_TYPE]

    doc['description'] = (
        'Encrypted login key response from a wallet for the QR key-exchange '
        'protocol. indexOnly: the index entries ARE the rows. One response per '
        '(application contract, app ephemeral key hash, wallet identity).'
    )
    doc['indexOnly'] = True
    doc['documentsMutable'] = False
    doc['canBeDeleted'] = True

    # The terminal of `oneResponsePerHandshake` must be an identifier property
    # carrying a refersTo declaration naming a referable entity; the target
    # application contract is exactly that.
    doc['properties']['contractId']['refersTo'] = {'type': 'contract'}

    # Every property of an indexOnly type must be required (there is no null
    # index layout), and an indexed $createdAt must be required too.
    doc['required'] = ['$createdAt'] + list(doc['properties'].keys())

    doc['indices'] = [
        {
            'name': 'byContractAndEphemeralKey',
            'properties': [
                {'contractId': 'asc'},
                {'appEphemeralPubKeyHash': 'asc'},
                {'walletEphemeralPubKey': 'asc'},
                {'encryptedPayload': 'asc'},
            ],
            'terminal': '$ownerId',
        },
        {
            'name': 'byHandshakeMeta',
            'properties': [
                {'appEphemeralPubKeyHash': 'asc'},
                {'keyIndex': 'asc'},
                {'$createdAt': 'asc'},
            ],
            'terminal': '$ownerId',
        },
        {
            'name': 'oneResponsePerHandshake',
            'properties': [
                {'$ownerId': 'asc'},
                {'appEphemeralPubKeyHash': 'asc'},
            ],
            'terminal': 'contractId',
        },
        {
            'name': 'byDay',
            'properties': [
                {'$createdAt': 'asc'},
                {'contractId': 'asc'},
                {'appEphemeralPubKeyHash': 'asc'},
            ],
            'terminal': '$ownerId',
            'countable': 'countable',
            # `rangeCountable` is what makes "how many handshakes did this
            # application see today" answerable: drive's count-index picker
            # only serves a where-clause set that covers the index EXACTLY,
            # or — with rangeCountable — its first `len - 1` properties with
            # the last one free. Pinning the bucket and contractId leaves
            # appEphemeralPubKeyHash free, which is the second form.
            # appEphemeralPubKeyHash cannot simply be dropped from this index:
            # without it the entry key would be (bucket, contractId, $ownerId)
            # and a wallet's SECOND login of the day to the same application
            # would collide with its own earlier entry (40105).
            'rangeCountable': True,
            'timeRange': dict(TIME_RANGE),
        },
    ]

    # Key order the JSON is emitted in, so the diff against v2 reads top-down.
    return {
        DOC_TYPE: {
            key: doc[key]
            for key in [
                'type', 'description', 'indexOnly', 'documentsMutable', 'canBeDeleted',
                'indices', 'required', 'additionalProperties', 'properties',
            ]
        }
    }


def render(contract):
    return json.dumps(contract, indent=2) + '\n'


def main():
    with open(SRC, encoding='utf-8') as handle:
        src = json.load(handle)
    text = render(build(src))

    if '--self-test' in sys.argv:
        with open(DST, encoding='utf-8') as handle:
            committed = handle.read()
        if committed != text:
            print(f'{DST} is not what {__file__} builds — re-run without --self-test')
            return 1
        # A second build over the same input must be byte-identical.
        if render(build(src)) != text:
            print('build is not deterministic')
            return 1
        print(f'{DST} matches the builder ({len(text)} bytes)')
        return 0

    with open(DST, 'w', encoding='utf-8') as handle:
        handle.write(text)
    print(f'wrote {DST} ({len(text)} bytes)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
