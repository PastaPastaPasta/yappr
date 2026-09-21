#!/usr/bin/env python3
"""Builds contracts/yappr-social-contract-v9.json from the v8 contract.

v9 adds two doctypes and changes nothing else: `tip` and `tipReply`, the
proved tip receipts (docs/SOCIAL_V9.md). Every v8 doctype, index, agreement,
token rule and fee is carried over byte for byte, so the whole client read
path and the v8 write path continue to work untouched.

A tip used to be inferred: a YAPP transfer whose `publicNote` named a post.
Nothing on chain bound the two, and the system token-history contract has no
aggregate trees, so a post's tips could only be found by scanning the author's
newest 100 incoming transfers and parsing notes. v9 replaces the inference with
a document that CITES its transfer, and lets consensus check the citation:

    transferId  refersTo the token-history `transfer` document, CROSS-CONTRACT
                (refersTo.contractId), with a propertyAgreement binding
                  $ownerId    == transfer.$ownerId      (writer gate: only the
                                                         sender may write it)
                  amount      == transfer.amount        (the number is a copy
                                                         of a consensus fact)
                  recipientId == transfer.toIdentityId  (who was paid)
    postId      refersTo the tipped `post`, binding
                  recipientId == post.$ownerId          (the payee IS the author)

Chaining those two proves `transfer.toIdentityId == post.$ownerId` transitively.
A lie is refused: 40127 on any mismatched pair, 40120 on a transfer id that
does not exist, 40105 on a second tip citing one transfer (the unique index).
`tipReply` is the same shape for a tip on a reply.

So the read path never touches token history at all — `tip.amount` is a proved
number the client can render straight off the document — and a post's tips are
an ordinary indexed query, like its replies.

WHAT IS NOT HERE, AND WHY. There is no `summable` index on `amount`, so there
is no proved lifetime total; the count trees give a proved COUNT instead. The
two rules collide:

  * `propertyAgreement` kind-checking (`same_value_kind`, rs-drive-abci
    data_contract_reference_validation/v0) compares DocumentPropertyType
    discriminants exactly. `transfer.amount` is `{integer, minimum: 0}` under a
    config with sized_integer_types (set for TokenHistory in
    rs-dpp system_data_contracts.rs), which infers U64 — so `tip.amount` must
    infer U64 too, or the contract is refused at registration.
  * `summable` rejects U64 outright (rs-dpp try_from_schema/common), because
    grovedb's sum aggregator is i64.

`amount` therefore carries a `maximum` even though the bound changes nothing
today: it still infers U64 (so the agreement registers), and a declared bound
below i64::MAX is exactly what the static form of the proposed upstream
relaxation would look for. See docs/PLATFORM_SUMMABLE_AGREEMENT_GAP.md.

Deterministic transform so the diff against v8 is reviewable as code; running
it twice produces byte-identical output.

Run:
  python3 scripts/build-v9-contract.py              # (re)write the v9 JSON
  python3 scripts/build-v9-contract.py --self-test  # assert the committed JSON
"""
import copy
import json
import sys

SRC = 'contracts/yappr-social-contract-v8.json'
DST = 'contracts/yappr-social-contract-v9.json'

# ---------------------------------------------------------------------------
# The SYSTEM token-history contract. Platform writes one `transfer` document
# into it for every transfer of a token whose config sets keepsTransferHistory
# (YAPP does). System contracts carry the same id on every chain, so this is a
# constant rather than a publish-time parameter.
#
# Spelled as a 32-BYTE ARRAY, not base58: `tokenCost.create.contractId` in
# base58 is accepted by the offline validator and refused on chain (see
# docs/NON_SOCIAL_CONTRACTS.md, "Platform rules these cuts established" #2), and
# there is no reason to find out the hard way whether refersTo.contractId parses
# the same way. The self-test checks the bytes decode back to the base58 id.
TOKEN_HISTORY_CONTRACT_ID = '43gujrzZgXqcKBiScLa4T8XTDnRhenR9BLx8GWVHjPxF'
TRANSFER_DOCUMENT_TYPE = 'transfer'

# The token-history `transfer` schema, as published in
# packages/token-history-contract/schema/v1/. Only the parts an agreement binds
# are transcribed, and the self-test re-derives the property types from them
# rather than trusting this comment: the offline validator cannot fetch a
# foreign contract, so a kind mismatch here would only surface as a paid
# registration failure on chain.
TRANSFER_BOUND_PROPERTIES = {
    'amount': {'type': 'integer', 'minimum': 0},
    'toIdentityId': {'type': 'array', 'byteArray': True, 'minItems': 32, 'maxItems': 32,
                     'contentMediaType': 'application/x.dash.dpp.identifier'},
}

# Bounds `amount` without changing its inferred type: any maximum above u32 still
# infers U64, so the agreement against transfer.amount registers, AND the property
# already satisfies a "summable U64 must declare maximum <= i64::MAX" rule if
# upstream adopts one.
#
# NOT i64::MAX itself: every tool on the registration path parses this JSON with
# JavaScript, where 9223372036854775807 becomes the float 9223372036854776000 and
# the wasm validator refuses it outright ("value is not an integer, found float").
# 2^53-1 is the largest integer that survives that round trip exactly, and it is
# ~9e15 YAPP against a 1e6 supply, so the bound never binds in practice.
AMOUNT_MAX = 9007199254740991

# A tip is a receipt. It can never be edited, deleted by its owner, or removed
# by a moderator: it records that money moved, and the abusable part of a tip —
# the words — lives in an ordinary `reply` that moderators can already take
# down. Nothing may reference a tip, so nothing dangles when one stays.
TIP_DOCTYPES = ['tip', 'tipReply']

# Priced like `like`/`repost`: one YAPP, optional (a user may pay credits
# instead), with the contract owner preferred for gas. No actionFees — the
# linked message reply already pays `reply`'s moderators fee, and a wordless
# tip carries nothing to moderate.
TIP_TOKEN_COST = {'tokenPosition': 0, 'amount': 1, 'optional': True, 'gasFeesPaidBy': 2}


def base58_decode(encoded):
    """Base58 (Bitcoin alphabet) → bytes. Inlined to keep the script dependency-free."""
    alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
    number = 0
    for character in encoded:
        number = number * 58 + alphabet.index(character)
    body = number.to_bytes((number.bit_length() + 7) // 8, 'big')
    leading_zeros = len(encoded) - len(encoded.lstrip('1'))
    return b'\x00' * leading_zeros + body


def base58_encode(payload):
    alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
    number = int.from_bytes(payload, 'big')
    encoded = ''
    while number:
        number, remainder = divmod(number, 58)
        encoded = alphabet[remainder] + encoded
    return '1' * (len(payload) - len(payload.lstrip(b'\x00'))) + encoded


def identifier(position, description, refers_to=None):
    """A 32-byte platform identifier property, optionally carrying a reference."""
    definition = {
        'type': 'array',
        'maxItems': 32,
        'minItems': 32,
        'position': position,
        'byteArray': True,
        'description': description,
        'contentMediaType': 'application/x.dash.dpp.identifier',
    }
    if refers_to is not None:
        definition['refersTo'] = refers_to
    return definition


def transfer_reference():
    """The cross-contract citation that makes a tip a fact instead of a claim."""
    return {
        'type': 'permanentDocument',
        'contractId': list(base58_decode(TOKEN_HISTORY_CONTRACT_ID)),
        'documentType': TRANSFER_DOCUMENT_TYPE,
        'propertyAgreement': {
            '$ownerId': '$ownerId',
            'amount': 'amount',
            'recipientId': 'toIdentityId',
        },
    }


def tip_doctype(tipped_property, tipped_doc_type, tipped_description):
    """One tip doctype: `tip` for posts, `tipReply` for replies.

    `tipped_property` is the reference whose propertyAgreement pins the payee to
    the author of the tipped document — the pair that stops a real transfer to
    one person being displayed as a tip to another.
    """
    properties = {
        'transferId': identifier(
            0,
            'The token-history transfer document this tip cites; consensus binds its sender, '
            'amount and recipient to the fields below',
            transfer_reference(),
        ),
        'amount': {
            'type': 'integer',
            'minimum': 0,
            'maximum': AMOUNT_MAX,
            'position': 1,
            'description': 'YAPP transferred, equal by consensus to the cited transfer\'s amount',
        },
        'recipientId': identifier(
            2,
            'Who was paid: equal by consensus to both the transfer\'s toIdentityId and the '
            'tipped document\'s owner',
        ),
        tipped_property: identifier(
            3,
            tipped_description,
            {
                'type': 'deletableDocument',
                'documentType': tipped_doc_type,
                'propertyAgreement': {'recipientId': '$ownerId'},
            },
        ),
        'messageReplyId': identifier(
            4,
            'The tipper\'s own reply carrying the words that went with the tip, when there were any',
            {
                'type': 'deletableDocument',
                'documentType': 'reply',
                'propertyAgreement': {'$ownerId': '$ownerId'},
            },
        ),
    }
    indices = [
        # One tip per transfer: without this, a tipper could cite their own
        # single transfer repeatedly and inflate every count that reads it.
        {'name': 'byTransfer', 'unique': True, 'properties': [{'transferId': 'asc'}]},
        {'name': 'tippedAndTime', 'properties': [{tipped_property: 'asc'}, {'$createdAt': 'asc'}]},
        {'name': 'byTipped', 'properties': [{tipped_property: 'asc'}], 'countable': True},
        {'name': 'byRecipient', 'properties': [{'recipientId': 'asc'}], 'countable': True},
        {'name': 'ownerAndTime', 'properties': [{'$ownerId': 'asc'}, {'$createdAt': 'asc'}]},
    ]
    required = ['$createdAt', 'transferId', 'amount', 'recipientId', tipped_property]

    return {
        'type': 'object',
        'indices': indices,
        'required': required,
        'properties': properties,
        'tokenCost': {'create': dict(TIP_TOKEN_COST)},
        'description': f'A proved tip on a {tipped_doc_type}: a YAPP transfer, cited by id, whose sender, '
                       'amount and recipient consensus checks against the transfer itself. Permanent and '
                       'immutable — it records that money moved',
        'additionalProperties': False,
        'documentsMutable': False,
        'canBeDeleted': False,
    }


def add_tip_doctypes(schemas):
    assert 'tip' not in schemas and 'tipReply' not in schemas, 'v8 has no tip doctypes'
    assert schemas['post'].get('canBeDeletedByModerators') is True, 'post must be moderator-deletable in v8'
    assert schemas['reply'].get('canBeDeletedByModerators') is True, 'reply must be moderator-deletable in v8'

    schemas['tip'] = tip_doctype(
        'postId', 'post', 'The tipped post; its owner must be the payee',
    )
    # Deliberately NO thread field. A tip on a reply could denormalize its thread
    # root for querying, but nothing could bind that field — the tipper would be
    # asserting which thread their tip belongs in, which is exactly the kind of
    # unchecked claim this cut exists to delete. A thread view already holds its
    # replies' ids, so it reads their tips with one `replyId in [...]` query and
    # can only ever find tips on replies it is actually showing.
    schemas['tipReply'] = tip_doctype(
        'replyId', 'reply', 'The tipped reply; its owner must be the payee',
    )


def build():
    contract = json.load(open(SRC))
    schemas = contract['documentSchemas']
    assert contract['config'].get('moderation'), 'expected the v8 beta.3 contract as the source'
    add_tip_doctypes(schemas)
    return contract


# ---------------------------------------------------------------------------


def infer_integer_type(schema):
    """rs-dpp `find_integer_type_for_subschema_value`, for a sized-integer contract.

    Only the branches the cut relies on: the point is to prove `tip.amount` and
    `transfer.amount` land on the SAME type, since an agreement between two
    different integer widths is refused at registration and the offline
    validator cannot see the foreign contract to tell us.
    """
    minimum, maximum = schema.get('minimum'), schema.get('maximum')
    if minimum is None and maximum is None:
        return 'I64'
    if maximum is None:
        return 'U64' if minimum >= 0 else 'I64'
    if minimum is not None and minimum < 0:
        return 'I64'
    # Unsigned, bounded: the smallest unsigned type that holds `maximum`.
    for name, bound in (('U8', 0xFF), ('U16', 0xFFFF), ('U32', 0xFFFFFFFF)):
        if maximum <= bound:
            return name
    return 'U64'


def self_test():
    built = build()
    committed = json.load(open(DST))
    source = json.load(open(SRC))
    failures = []

    def check(name, condition):
        print(('PASS  ' if condition else 'FAIL  ') + name)
        if not condition:
            failures.append(name)

    check('committed v9 JSON matches a fresh build', built == committed)

    v8 = source['documentSchemas']
    v9 = committed['documentSchemas']

    # ---- exactly two doctypes added, nothing else touched --------------------
    check('exactly the two tip doctypes are added relative to v8',
          sorted(set(v9) - set(v8)) == sorted(TIP_DOCTYPES) and not set(v8) - set(v9))
    check('every v8 doctype is carried over byte for byte',
          all(v9[t] == v8[t] for t in v8))
    check('the config is v8\'s', committed['config'] == source['config'])
    check('the token block is v8\'s', committed['tokens'] == source['tokens'])
    check('the contract version is v8\'s', committed['version'] == source['version'])

    # ---- the citation ---------------------------------------------------------
    for doc_type in TIP_DOCTYPES:
        schema = v9[doc_type]
        reference = schema['properties']['transferId']['refersTo']
        check(f'{doc_type}.transferId cites the token-history contract by its 32-byte id',
              len(reference['contractId']) == 32
              and base58_encode(bytes(reference['contractId'])) == TOKEN_HISTORY_CONTRACT_ID)
        check(f'{doc_type}.transferId is a permanentDocument reference (transfer is undeletable; '
              'a deletableDocument reference there is refused)',
              reference['type'] == 'permanentDocument'
              and reference['documentType'] == TRANSFER_DOCUMENT_TYPE)
        check(f'{doc_type} binds the writer, the amount and the payee to the transfer',
              reference['propertyAgreement']
              == {'$ownerId': '$ownerId', 'amount': 'amount', 'recipientId': 'toIdentityId'})

        tipped = 'postId' if doc_type == 'tip' else 'replyId'
        check(f'{doc_type}.{tipped} binds the payee to the tipped document\'s author',
              schema['properties'][tipped]['refersTo']['propertyAgreement'] == {'recipientId': '$ownerId'})
        check(f'{doc_type}.{tipped} is a deletableDocument reference (post/reply are moderator-deletable)',
              schema['properties'][tipped]['refersTo']['type'] == 'deletableDocument')
        check(f'{doc_type}.messageReplyId may only name the tipper\'s own reply',
              schema['properties']['messageReplyId']['refersTo']['propertyAgreement'] == {'$ownerId': '$ownerId'})

        # ---- the kind check the offline validator cannot make ----------------
        check(f'{doc_type}.amount infers the same integer type as transfer.amount '
              '(a width mismatch is refused at registration)',
              infer_integer_type(schema['properties']['amount'])
              == infer_integer_type(TRANSFER_BOUND_PROPERTIES['amount']) == 'U64')
        check(f'{doc_type}.amount is bounded below i64::MAX and inside JS integer range (no summable '
              'index today, but the bound is what a relaxed summable rule would look for)',
              schema['properties']['amount']['maximum'] == AMOUNT_MAX < 2 ** 63)
        check(f'{doc_type}.recipientId and transfer.toIdentityId are both identifiers',
              schema['properties']['recipientId']['contentMediaType']
              == TRANSFER_BOUND_PROPERTIES['toIdentityId']['contentMediaType'])

        # ---- shape -------------------------------------------------------------
        check(f'{doc_type} is permanent and immutable — a receipt is never rewritten or removed',
              schema['documentsMutable'] is False and schema['canBeDeleted'] is False
              and 'canBeDeletedByModerators' not in schema)
        check(f'{doc_type} requires everything an agreement binds',
              sorted(schema['required'])
              == sorted(['$createdAt', 'transferId', 'amount', 'recipientId', tipped]))
        check(f'{doc_type} has one unique index on transferId, so one transfer is one tip',
              [i for i in schema['indices'] if i.get('unique')]
              == [{'name': 'byTransfer', 'unique': True, 'properties': [{'transferId': 'asc'}]}])
        check(f'{doc_type} counts tips per tipped document and per recipient',
              [i['name'] for i in schema['indices'] if i.get('countable')] == ['byTipped', 'byRecipient'])
        check(f'{doc_type} declares no summable axis (U64 amount; see the module docstring)',
              not any('summable' in i or 'averageable' in i for i in schema['indices']))
        check(f'{doc_type} stays inside the 10-index cap', len(schema['indices']) <= 10)
        check(f'{doc_type} costs one YAPP, optionally, with owner-preferred gas',
              schema['tokenCost'] == {'create': TIP_TOKEN_COST})
        check(f'{doc_type} charges no action fee', 'actionFees' not in schema)
        check(f'{doc_type} property positions are dense and start at 0',
              sorted(d['position'] for d in schema['properties'].values())
              == list(range(len(schema['properties']))))

    check('no tip doctype carries an unbound property: every field either is bound by an '
          'agreement or is the reference carrying one',
          all(set(v9[t]['properties']) == {'transferId', 'amount', 'recipientId', 'messageReplyId'}
              | {'postId' if t == 'tip' else 'replyId'} for t in TIP_DOCTYPES))
    # The two doctypes are one shape with the tipped document swapped, so
    # everything that is not about the tipped document must be identical —
    # otherwise the two read paths would quietly need different code.
    def without_tipped(schema, tipped_property):
        return {
            'indices': [{k: v for k, v in index.items() if k != 'properties'} for index in schema['indices']],
            'index_shapes': [[list(p)[0] == tipped_property or list(p)[0] for p in index['properties']]
                             for index in schema['indices']],
            'required': sorted(f for f in schema['required'] if f != tipped_property),
            'properties': {name: {k: v for k, v in definition.items() if k != 'description'}
                           for name, definition in schema['properties'].items() if name != tipped_property},
            'rest': {k: v for k, v in schema.items()
                     if k not in ('indices', 'required', 'properties', 'description')},
        }

    check('the two tip doctypes are one shape with the tipped document swapped',
          without_tipped(v9['tip'], 'postId') == without_tipped(v9['tipReply'], 'replyId'))

    print()
    print('SELF-TEST PASSED' if not failures else f'{len(failures)} CHECK(S) FAILED')
    return 1 if failures else 0


if __name__ == '__main__':
    if '--self-test' in sys.argv:
        sys.exit(self_test())
    json.dump(build(), open(DST, 'w'), indent=2)
    open(DST, 'a').write('\n')
    print(f'wrote {DST}')
