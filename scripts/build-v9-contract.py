#!/usr/bin/env python3
"""Builds contracts/yappr-social-contract-v9.json from the v8 contract.

v9 is the 4.2.0-beta.4 cut (docs/SOCIAL_V9.md). The read surface is v8's:
every index, terminal, ranked axis, timeRange window, token cost, action fee
and the starter grant are unchanged. What v9 adds is beta.4 grammar that a
live contract cannot gain by an update, which is why it is a fresh
registration rather than a `dataContractUpdate`:

1.  **Elected moderation** (#4886/#4969/#4914). `config.moderation.moderators`
    becomes `{"$type": "elected", ...}`: masternodes elect a moderation team
    through the moderation charters system contract, and until a team is
    seated the contract owner moderates (`interim: contractOwner`). The team
    holds deleteDocuments/ban/suspend/warn on `post` and `reply`; the seat is
    not contestable (challenges are after protocol 14 anyway, and the key is
    frozen with the declaration); the leader may add up to 10 members after
    the election; the owner is protected from the seated team. No
    `electionDelay`: the first charter may be filed as soon as the contract
    exists. Every field is frozen at creation (40002 on any update).

2.  **Warning list** (#4872). `config.moderation.warnings: true`. A warning
    bars nothing; it is a readable record with a reason that accumulates (16
    at most) until cleared. Fixed at creation, like the other two lists.

3.  **distinctFrom "$ownerId"** (#4917) on the identifiers that must never name
    their writer: `follow.followingId`, `block.blockedId`,
    `followRequest.targetId`, `privateFeedGrant.recipientId`, and every element
    of `blockFollow.followedBlockers`. A self-follow, self-block, self-request
    or self-grant is refused 10419. `like.postAuthor` and
    `repost.postOwnerId` stay as they are: self-likes are allowed.

4.  **Private-feed gates.** `privateFeedGrant` and `privateFeedRekey` declare
    `ownerRefersTo` (#4941) a `permanentDocument` lookup of the WRITER's own
    `privateFeedState` through its unique `owner` index: only an identity that
    enabled a private feed may grant or rekey. `privateFeedGrant.recipientId`
    `refersTo` a `deletableDocument` `followRequest` found through the unique
    `targetAndRequester` index (#4930): `targetId` is the grant's writer and
    the request's owner is the recipient, so only someone who asked can be
    granted. The request must exist when the grant is written; grants are
    never replaced (`documentsMutable: false`), so the requester deleting it
    afterwards (the client's stale-request cleanup) strands nothing.

5.  **Typed identifier array** (#4922/#4923/#4928). `blockFollow.followedBlockers`
    stops being packed bytes (32 x n in one byteArray) and becomes a typed
    array of at most 100 identifiers, each `refersTo: identity` and
    `distinctFrom: $ownerId`, no duplicates. 100 references are within the
    256-per-document budget (SystemLimits.max_references_per_document).

6.  **Size.** A contract create is one state transition, capped at
    SystemLimits.max_state_transition_size = 20480 bytes (rs-dapi refuses a
    larger broadcast, Drive decodes it as 10602). v8 was already 20,207 bytes
    and the grammar above adds ~700, so v9 drops every PROPERTY
    `description` (~3 KB; annotations nothing reads: the meta-schema keeps
    them for humans, and this builder and docs/SOCIAL_V9.md carry the
    rationale). Doctype descriptions stay. `validate-contract-offline.mjs`
    measures the signed-size estimate of every cut against a 20,000-byte
    budget.

Everything else is byte-identical to v8 apart from those descriptions.

Deterministic transform so the diff against v8 is reviewable as code; running
it twice produces byte-identical output.

Run:
  python3 scripts/build-v9-contract.py              # (re)write the v9 JSON
  python3 scripts/build-v9-contract.py --self-test  # assert the committed JSON
"""
import copy
import json
import os
import subprocess
import sys

SRC = 'contracts/yappr-social-contract-v8.json'
DST = 'contracts/yappr-social-contract-v9.json'

# ---------------------------------------------------------------------------
# 1 + 2. Elected moderation and the warning list. Key names and values are
# rs-dpp's (data_contract/config/moderation/elected.rs at v4.2.0-beta.4).
ABILITIES = ['deleteDocuments', 'ban', 'suspend', 'warn']
MODERATED_TYPES = ['post', 'reply']
# SystemLimits.min/max_contract_moderation_election_window_seconds.
ELECTION_WINDOW_BOUNDS = (86_400, 2_419_200)
# SystemLimits.max_contract_moderation_added_moderators.
MAX_ADDED_MODERATORS_LIMIT = 15
ELECTED = {
    '$type': 'elected',
    'joinWindow': 86_400,
    'voteWindow': 86_400,
    'seatContestable': False,
    'maxAddedModerators': 10,
    'moderatedDocumentTypes': {doc_type: list(ABILITIES) for doc_type in MODERATED_TYPES},
    'interim': {'$type': 'contractOwner'},
    'ownerProtected': True,
}
MODERATION = {
    'banlist': True,
    'suspensions': True,
    'warnings': True,
    'moderators': ELECTED,
}
# `moderation` is a field of config V2 only; a "1" config silently drops it.
CONFIG_FORMAT_VERSION = '2'

# ---------------------------------------------------------------------------
# 3. distinctFrom the writer.
DISTINCT_FROM_OWNER = [
    ('follow', 'followingId'),
    ('block', 'blockedId'),
    ('followRequest', 'targetId'),
    ('privateFeedGrant', 'recipientId'),
]
# Deliberately NOT distinct: a user may like or repost their own post.
SELF_ALLOWED = [('like', 'postAuthor'), ('repost', 'postOwnerId')]

# ---------------------------------------------------------------------------
# 4. Private-feed gates.
FEED_STATE_GATE = {
    'type': 'permanentDocument',
    'documentType': 'privateFeedState',
    'lookup': {'index': 'owner', 'keys': {'$ownerId': '.'}},
}
FEED_GATED_TYPES = ['privateFeedGrant', 'privateFeedRekey']
REQUEST_GATE = {
    'type': 'deletableDocument',
    'documentType': 'followRequest',
    'lookup': {'index': 'targetAndRequester', 'keys': {'targetId': '$ownerId', '$ownerId': '.'}},
}

# ---------------------------------------------------------------------------
# 5. blockFollow as a typed array of identifiers.
IDENTIFIER_MEDIA_TYPE = 'application/x.dash.dpp.identifier'
MAX_BLOCK_FOLLOWS = 100  # lib/services/block-service.ts MAX_BLOCK_FOLLOWS
FOLLOWED_BLOCKERS = {
    'type': 'array',
    'minItems': 1,
    'maxItems': MAX_BLOCK_FOLLOWS,
    'uniqueItems': True,
    'position': 0,
    'items': {
        'type': 'array',
        'byteArray': True,
        'minItems': 32,
        'maxItems': 32,
        'contentMediaType': IDENTIFIER_MEDIA_TYPE,
        'distinctFrom': '$ownerId',
        'refersTo': {'type': 'identity'},
    },
}
MAX_REFERENCES_PER_DOCUMENT = 256  # SystemLimits.max_references_per_document
MAX_TYPED_ARRAY_ITEMS = 1024       # SystemLimits.max_typed_array_items


def add_elected_moderation(contract):
    config = contract['config']
    assert config['moderation']['moderators'] == {'$type': 'contractOwner'}, 'expected the v8 owner-moderated config'
    config['$formatVersion'] = CONFIG_FORMAT_VERSION
    config['moderation'] = copy.deepcopy(MODERATION)


def add_distinct_from(schemas):
    for doc_type, prop in DISTINCT_FROM_OWNER:
        definition = schemas[doc_type]['properties'][prop]
        assert definition.get('contentMediaType') == IDENTIFIER_MEDIA_TYPE, f'{doc_type}.{prop} must be an identifier'
        assert 'distinctFrom' not in definition
        definition['distinctFrom'] = '$ownerId'


def add_private_feed_gates(schemas):
    state = schemas['privateFeedState']
    # A permanentDocument target must forbid deletion; the lookup key ($ownerId)
    # must stay with the document, which it does on a type that can be neither
    # transferred nor traded.
    assert state['canBeDeleted'] is False and not state.get('transferable') and not state.get('tradeMode')
    assert any(i['name'] == 'owner' and i.get('unique') and i['properties'] == [{'$ownerId': 'asc'}]
               for i in state['indices'])
    for doc_type in FEED_GATED_TYPES:
        assert 'ownerRefersTo' not in schemas[doc_type]
        schemas[doc_type]['ownerRefersTo'] = copy.deepcopy(FEED_STATE_GATE)

    request = schemas['followRequest']
    # A lookup key must be fixed once the document is written: targetId is
    # listed immutable and $ownerId never moves on this type.
    assert request.get('immutable') == ['targetId'] and request.get('canBeDeleted', True) is not False
    assert any(i['name'] == 'targetAndRequester' and i.get('unique')
               and i['properties'] == [{'targetId': 'asc'}, {'$ownerId': 'asc'}] for i in request['indices'])
    grant = schemas['privateFeedGrant']
    # An `immutable` list may not hold a deletable lookup; a grant is
    # documentsMutable: false instead and is never replaced.
    assert grant['documentsMutable'] is False and 'immutable' not in grant
    recipient = grant['properties']['recipientId']
    assert 'refersTo' not in recipient
    recipient['refersTo'] = copy.deepcopy(REQUEST_GATE)


def type_followed_blockers(schemas):
    prop = schemas['blockFollow']['properties']['followedBlockers']
    assert prop.get('byteArray') is True and prop['maxItems'] == 32 * MAX_BLOCK_FOLLOWS, 'expected the packed-bytes v8 field'
    schemas['blockFollow']['properties']['followedBlockers'] = copy.deepcopy(FOLLOWED_BLOCKERS)


def drop_property_descriptions(schemas):
    for schema in schemas.values():
        for definition in schema['properties'].values():
            definition.pop('description', None)
            if isinstance(definition.get('items'), dict):
                definition['items'].pop('description', None)


def build():
    contract = json.load(open(SRC))
    schemas = contract['documentSchemas']
    assert schemas['post'].get('canBeDeletedByModerators') is True, 'expected the v8 beta.3 contract as the source'
    add_elected_moderation(contract)
    add_distinct_from(schemas)
    add_private_feed_gates(schemas)
    type_followed_blockers(schemas)
    drop_property_descriptions(schemas)
    return contract


def strip(definition):
    return {k: v for k, v in definition.items() if k != 'description'}


def reference_budget(schema):
    """References one document can carry, counted the way rs-dpp's validate_reference_count does."""
    total = 1 if 'ownerRefersTo' in schema else 0
    for definition in schema['properties'].values():
        if 'refersTo' in definition:
            total += 1
        items = definition.get('items')
        if isinstance(items, dict) and 'refersTo' in items:
            total += definition['maxItems']
    return total


# ---------------------------------------------------------------------------


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
    check('no doctype is added or removed relative to v8', sorted(v9) == sorted(v8))

    # ---- 1 + 2. elected moderation, warnings --------------------------------
    config = committed['config']
    moderation = config['moderation']
    elected = moderation['moderators']
    check('the config is format version 2 (the only one that carries moderation)',
          config['$formatVersion'] == CONFIG_FORMAT_VERSION)
    check('all three lists are kept: banlist, suspensions and warnings',
          moderation['banlist'] is True and moderation['suspensions'] is True and moderation['warnings'] is True)
    check('the moderators are an elected team', elected['$type'] == 'elected')
    check('both election windows are one day, inside the protocol bounds',
          elected['joinWindow'] == elected['voteWindow'] == 86_400
          and all(ELECTION_WINDOW_BOUNDS[0] <= elected[k] <= ELECTION_WINDOW_BOUNDS[1] for k in ('joinWindow', 'voteWindow')))
    check('the seat is not contestable, so no challengeCoolDown is declared',
          elected['seatContestable'] is False and 'challengeCoolDown' not in elected)
    check('no electionDelay: the first charter may be filed at once', 'electionDelay' not in elected)
    check('maxAddedModerators is between 5 and the protocol limit of 15',
          5 <= elected['maxAddedModerators'] <= MAX_ADDED_MODERATORS_LIMIT)
    check('the team moderates exactly post and reply with all four abilities',
          elected['moderatedDocumentTypes'] == {t: ABILITIES for t in MODERATED_TYPES})
    check('every deleteDocuments ability is backed by canBeDeletedByModerators',
          all(v9[t].get('canBeDeletedByModerators') is True
              for t, abilities in elected['moderatedDocumentTypes'].items() if 'deleteDocuments' in abilities))
    check('the owner moderates until a team is seated, and is protected from it',
          elected['interim'] == {'$type': 'contractOwner'} and elected['ownerProtected'] is True)
    check('every other config field is v8\'s',
          {k: v for k, v in config.items() if k != 'moderation'}
          == {k: v for k, v in source['config'].items() if k != 'moderation'})

    # canBeDeletedByModerators is refused on a type with a contested index (restores
    # cannot go through a vote).
    check('no document type carries a contested index',
          not any('contested' in index for s in v9.values() for index in s.get('indices', [])))

    # ---- 3. distinctFrom ------------------------------------------------------
    distinct = sorted((t, p) for t, s in v9.items() for p, d in s['properties'].items() if 'distinctFrom' in d)
    check('distinctFrom $ownerId is on exactly the four relationship identifiers',
          distinct == sorted(DISTINCT_FROM_OWNER)
          and all(v9[t]['properties'][p]['distinctFrom'] == '$ownerId' for t, p in distinct))
    check('like.postAuthor and repost.postOwnerId stay self-allowed',
          all('distinctFrom' not in v9[t]['properties'][p] for t, p in SELF_ALLOWED))

    # ---- 4. private-feed gates -----------------------------------------------
    check('privateFeedGrant and privateFeedRekey gate the writer on their own privateFeedState',
          all(v9[t]['ownerRefersTo'] == FEED_STATE_GATE for t in FEED_GATED_TYPES)
          and sorted(t for t, s in v9.items() if 'ownerRefersTo' in s) == sorted(FEED_GATED_TYPES))
    check('privateFeedState stays permanent and immutable (a permanentDocument target)',
          v9['privateFeedState']['canBeDeleted'] is False and v9['privateFeedState']['documentsMutable'] is False)
    check('a grant\'s recipient must have filed a followRequest to the grant\'s writer',
          v9['privateFeedGrant']['properties']['recipientId']['refersTo'] == REQUEST_GATE)
    check('followRequest keeps targetId immutable, the lookup key the grant reads',
          v9['followRequest']['immutable'] == ['targetId'])
    check('grants stay documentsMutable: false with no immutable list (never replaced)',
          v9['privateFeedGrant']['documentsMutable'] is False and 'immutable' not in v9['privateFeedGrant'])

    # ---- 5. typed arrays ------------------------------------------------------
    blockers = v9['blockFollow']['properties']['followedBlockers']
    check('followedBlockers is a typed array of at most 100 distinct identity references, never the owner',
          blockers == FOLLOWED_BLOCKERS and 'byteArray' not in blockers)
    check('no property carries a description (the 20480-byte transition budget)',
          not any('description' in d for s in v9.values() for d in s['properties'].values()))
    check('every doctype keeps its description', all(v9[t].get('description') == v8[t].get('description') for t in v9))
    check('no typed array exceeds max_typed_array_items',
          all(d['maxItems'] <= MAX_TYPED_ARRAY_ITEMS for s in v9.values() for d in s['properties'].values() if 'items' in d))
    check('every document type stays within max_references_per_document',
          all(reference_budget(s) <= MAX_REFERENCES_PER_DOCUMENT for s in v9.values()))

    # ---- everything else is v8 ------------------------------------------------
    touched_props = set(DISTINCT_FROM_OWNER) | {('privateFeedGrant', 'recipientId'), ('blockFollow', 'followedBlockers')}
    check('the four distinctFrom properties are v8\'s plus distinctFrom only',
          all({k: v for k, v in v9[t]['properties'][p].items() if k not in ('distinctFrom', 'refersTo')}
              == {k: v for k, v in strip(v8[t]['properties'][p]).items() if k != 'refersTo'} for t, p in DISTINCT_FROM_OWNER))
    check('every other property is v8\'s',
          all(v9[t]['properties'][p] == strip(v8[t]['properties'][p])
              for t in v9 for p in v9[t]['properties'] if (t, p) not in touched_props))
    check('every doctype is v8\'s apart from its properties and ownerRefersTo',
          all({k: v for k, v in v9[t].items() if k not in ('properties', 'ownerRefersTo')}
              == {k: v for k, v in v8[t].items() if k != 'properties'} for t in v9))
    check('the token, its costs, the action fees and the starter grant are v8\'s',
          committed['tokens'] == source['tokens'])
    check('the contract version is v8\'s', committed['version'] == source['version'])

    # ---- size: the create transition must fit 20480 bytes with headroom -----
    # Measured with the wasm DPP (the only faithful serializer), so this needs
    # node_modules; skipped with a notice when it is absent.
    if os.path.isdir('node_modules/@dashevo/evo-sdk'):
        run = subprocess.run(['node', 'scripts/validate-contract-offline.mjs', DST, '--strict-size'],
                             capture_output=True, text=True)
        size_line = next((l.strip() for l in run.stdout.splitlines() if 'create size' in l), run.stderr.strip()[:200])
        check(f'full wasm validation, meta-schema v3 and the ≤20,000 B create budget ({size_line})', run.returncode == 0)
    else:
        print('SKIP  create-transition size and wasm validation: node_modules/@dashevo/evo-sdk is not installed')

    print()
    print('SELF-TEST PASSED' if not failures else f'{len(failures)} CHECK(S) FAILED')
    return 1 if failures else 0


if __name__ == '__main__':
    if '--self-test' in sys.argv:
        sys.exit(self_test())
    json.dump(build(), open(DST, 'w'), indent=2)
    open(DST, 'a').write('\n')
    print(f'wrote {DST}')
