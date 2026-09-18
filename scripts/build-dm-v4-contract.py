#!/usr/bin/env python3
"""Builds contracts/yappr-dm-contract-v4.json from the deployed v3 DM contract.

Deterministic transform (running it twice yields byte-identical output) so the
diff against the deployed v3 shape is reviewable as code. See docs/DM_V4.md for
the rationale and the query shapes the new flags serve.

DMs must stay CHEAP. v4 is deliberately the smallest possible re-cut: two
additive index/property flags, no new doctypes, no ranked or timeRange indexes,
no indexOnly rewrites, and no token costs. Every write costs exactly what it
cost on v3 plus the one extra count-tree branch the `countable` flag maintains.

What v4 changes, per document type:

  conversationInvite  recipientId refersTo {type: identity}: an invite naming an
                      identity that does not exist is refused at write time
                      (40120) instead of sitting in the recipient's inbox
                      forever. Nothing else changes; senderPubKey is untouched.
  directMessage       the `conversation` index [conversationId, $createdAt]
                      gains countable + rangeCountable, so
                        count(conversationId == C)                      → total
                        count(conversationId == C, $createdAt > lastRead) → unread
                      are single O(1) calls instead of a 100-message download
                      per conversation.
  readReceipt         unchanged (see docs/DM_V4.md "Not in v4").

Deliberately NOT changed: `requiresIdentityEncryptionBoundedKey` /
`requiresIdentityDecryptionBoundedKey` stay off. Turning either on would
require every existing identity to hold an ENCRYPTION key bound to THIS
contract id, which no Yappr identity has — it would break DMs for everyone on
the day of the cut. scripts/verify-dm-v4.mjs probes whether such a key can be
registered at all (see the `d8` case) without the contract depending on it.

Run:
  python3 scripts/build-dm-v4-contract.py              # (re)write the v4 JSON
  python3 scripts/build-dm-v4-contract.py --self-test  # assert the committed JSON
"""
import copy
import json
import sys

SRC = 'contracts/yappr-dm-contract.json'
DST = 'contracts/yappr-dm-contract-v4.json'

# Stable doctype order for reviewable diffs (same order as the v3 file).
DOCTYPE_ORDER = ['conversationInvite', 'directMessage', 'readReceipt']


def index_named(schema, name):
    for index in schema['indices']:
        if index['name'] == name:
            return index
    raise KeyError(f'index {name} not found in {[i["name"] for i in schema["indices"]]}')


def build(src):
    out = copy.deepcopy(src)

    # ---- conversationInvite -------------------------------------------------
    invite = out['conversationInvite']
    # A ghost recipient is a permanently undeliverable invite: let consensus
    # refuse it. `identity` (not `permanentDocument`) because the target is an
    # identity, not a document; a disabled key is not checked here since the
    # invite names no key id (senderPubKey is the SENDER's, raw bytes).
    invite['properties']['recipientId']['refersTo'] = {'type': 'identity'}
    invite['description'] = (
        'Notifies a recipient that a conversation has been started with them. '
        'One per conversation per direction. recipientId must name an identity '
        'that exists.'
    )

    # ---- directMessage ------------------------------------------------------
    message = out['directMessage']
    conversation = index_named(message, 'conversation')
    # `countable` gives `count where conversationId == C`; `rangeCountable`
    # extends it over the index's LAST property, $createdAt, which is exactly
    # the "unread since my read receipt" question. Spelled out literally rather
    # than through meta-schema sugar — see docs/STOREFRONT_V2.md gotcha 1.
    conversation['countable'] = 'countable'
    conversation['rangeCountable'] = True
    message['description'] = (
        'A message in a conversation. Lean - no recipientId, no read status. '
        'The conversation index is countable and rangeCountable, so per-'
        'conversation totals and "unread since lastReadAt" are count queries.'
    )

    # ---- readReceipt: unchanged --------------------------------------------

    return {name: out[name] for name in DOCTYPE_ORDER}


def main(argv):
    with open(SRC) as f:
        src = json.load(f)
    if sorted(src) != sorted(DOCTYPE_ORDER):
        print(f'{SRC} has document types {sorted(src)}, expected {sorted(DOCTYPE_ORDER)}', file=sys.stderr)
        return 1
    built = build(src)
    text = json.dumps(built, indent=2) + '\n'
    if '--self-test' in argv:
        with open(DST) as f:
            current = f.read()
        if current != text:
            print(f'{DST} is stale — run scripts/build-dm-v4-contract.py', file=sys.stderr)
            return 1
        print(f'{DST} matches the transform')
        return 0
    with open(DST, 'w') as f:
        f.write(text)
    print(f'wrote {DST} ({len(built)} document types)')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
