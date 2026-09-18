#!/usr/bin/env python3
"""Builds contracts/yappr-social-contract-v7.json from the v6 contract.

v7 is the 4.2.0-beta.2 cut. It registers on protocol v14 builds carrying the
beta.2 document meta-schema (v3 + `immutable`/`immutableAllowSetting` and
system-field `propertyAgreement`). Nothing about the query surface changes:
every index, terminal, ranked axis and timeRange window is v6's, so the whole
client read path — and docs/V6_WINDOWED_RANKINGS.md — carries over unchanged.

What changes is what consensus, rather than the client, is responsible for:

1.  **The `author` hack dies.** v4 added a poster-attested `author` identifier
    to `post`/`reply` for one reason: `propertyAgreement` could only name a
    *schema* property of the referenced document, so a like could not be bound
    to its post's real owner. beta.2 (#4816) lets the referenced side of a pair
    be `$ownerId` or `$creatorId`, so `like.postAuthor` binds straight to
    `post.$ownerId` and the duplicated, client-attested column is deleted.
    `preallocated` survives on `byAuthorPost`: the book states that an
    `[authorId, postId]` index whose `authorId` agrees with the post's
    `$ownerId` is still a pure function of the referenced document.

2.  **Immutable properties on mutable doctypes** (#4815). `post` and `reply`
    are `documentsMutable: true, canBeDeleted: false`, and the app's ONLY
    replace is the tombstone. Everything structural about a post — its
    language, its tag, what it quotes, what it embeds, where a reply hangs —
    is now frozen by consensus instead of by convention, and `deleted` is
    "immutable but settable": a tombstone may set it once and nothing can ever
    unset it.

3.  **Countable inference** (#4809/meta-schema v3 in beta.2). `rangeCountable:
    true` now implies `countable: "countable"`, so the explicit pairing is
    redundant noise and is dropped. Indexes that are countable WITHOUT a range
    tree keep their explicit `countable`.

Deterministic transform so the diff against v6 is reviewable as code; running
it twice produces byte-identical output.

Run:
  python3 scripts/build-v7-contract.py              # (re)write the v7 JSON
  python3 scripts/build-v7-contract.py --self-test  # assert the committed JSON
"""
import copy
import json
import sys

SRC = 'contracts/yappr-social-contract-v6.json'
DST = 'contracts/yappr-social-contract-v7.json'

# ---------------------------------------------------------------------------
# 1. System-field propertyAgreement: the referenced side moves to `$ownerId`.
#
# Keyed by doctype -> referring identifier property -> the agreement the
# reference declares in v7. Only the pairs whose REFERENCED side changes (or
# that are newly declared) appear here; `beat.postId` keeps v6's
# `{"hashtag": "hashtag"}` because a hashtag is an ordinary schema property on
# both sides.
AGREEMENTS = {
    # `postAuthor` was bound to the attested `post.author`; it now binds to the
    # post's real owner. `hashtag` stays a schema-to-schema pair.
    'like': ('postId', {'hashtag': 'hashtag', 'postAuthor': '$ownerId'}),
    'likeReply': ('replyId', {'replyAuthor': '$ownerId'}),
    # NEW in v7. The client already writes `postOwnerId` = the reposted post's
    # owner (hooks/use-post-engagement.ts passes `post.author.id`, which the
    # post transform sources from `$ownerId`; the seeder passes the target ref's
    # ownerId), so binding it makes a value that was merely conventional
    # consensus-true, and the `postOwnerAndTime` notification index can no
    # longer be poisoned by a repost naming someone else's identity.
    'repost': ('postId', {'postOwnerId': '$ownerId'}),
}

# NOT bound, deliberately:
#
#   post.quotedPostId -> {"quotedPostOwnerId": "$ownerId"}
#     `quotedPostOwnerId` is also written for quotes of a REPLY, where the
#     reference lives in `quotedReplyId` and `quotedPostId` is absent
#     (lib/feed/resolve-quoted-posts.ts sets `[field]: id` plus
#     `quotedPostOwnerId` for both kinds). propertyAgreement is absence-aware
#     and strict: one side present with the other absent is the same 40127
#     mismatch a wrong value would be, so binding it would reject every
#     reply-quote.
#
#   reply.rootPostId -> {"parentOwnerId": "$ownerId"}
#     `parentOwnerId` is the owner of the DIRECT parent, which for a nested
#     reply is another reply's owner, not the root post's.
#
#   any writer gate ({"$ownerId": ...})
#     Anyone may like, beat or repost anyone's post; a writer gate would
#     restrict those writes to the referenced post's owner.

# ---------------------------------------------------------------------------
# 2. The client-attested author column, removed from both doctypes.
ATTESTED_AUTHOR = 'author'

# ---------------------------------------------------------------------------
# 3. Immutable property lists, in schema-position order.
#
# The rule that shapes these: a replace that CHANGES, ADDS or DROPS an
# immutable property is rejected with DocumentImmutablePropertyChangedError
# (40128), so every frozen property must be carried over verbatim by
# lib/services/tombstone-helpers.ts. Only properties a tombstone can afford to
# keep — structure and identity, never content — may be frozen.
IMMUTABLE = {
    'post': {
        'immutable': [
            # Required, and the `languageTimeline` index key. Never edited.
            'language',
            # Already client-immutable in v6 for a consensus reason: existing
            # likes repeated it under an agreement, so blanking it on a
            # tombstone would strand them. Now enforced.
            'hashtag',
            # The quote graph. `canBeDeleted: false` exists so references stay
            # resolvable forever; letting a replace rewrite or drop one would
            # undo that guarantee for the quote indexes and count trees.
            'quotedPostId',
            'quotedReplyId',
            'quotedPostOwnerId',
            # The cross-contract embed triple (poll/blog posts). Same argument:
            # it identifies what the post IS.
            'embedContractId',
            'embedDocType',
            'embedId',
            # Immutable-but-settable; see immutableAllowSetting below.
            'deleted',
        ],
        # A tombstone sets `deleted` once on a document created without it;
        # after that it can never be changed or removed, so a post cannot be
        # un-deleted and the "deleted" state is as permanent as the document.
        'immutableAllowSetting': ['deleted'],
    },
    'reply': {
        'immutable': [
            # Where the reply hangs. `rootPostId` is required and keys the
            # thread fetch and its count tree; `replyToReplyId` is optional
            # nesting the tombstone already had to preserve by hand or the
            # tombstone (and every live reply under it) would jump to the top
            # of the thread; `parentOwnerId` is the notification target.
            'rootPostId',
            'replyToReplyId',
            'parentOwnerId',
            'deleted',
        ],
        'immutableAllowSetting': ['deleted'],
    },
    # Created, queried and deleted — never replaced. `targetId` is required and
    # is the first key of the unique `[targetId, $ownerId]` index, so freezing
    # it stops a replace from walking one request onto a different target.
    # `publicKey` stays mutable: a requester rotating their key in place is a
    # coherent future edit.
    'followRequest': {'immutable': ['targetId']},
}

# Deliberately frozen NOWHERE:
#
#   post/reply `content`, `mediaUrl`, `sensitive`, `encryptedContent`
#     The tombstone blanks `content` and drops the rest; freezing any of them
#     would make a tombstone impossible.
#   post/reply `epoch`, `nonce`
#     These are the XChaCha20-Poly1305 key-derivation parameters OF
#     `encryptedContent`, which stays mutable. They are one unit with the
#     ciphertext: frozen, a tombstone would have to keep decryption parameters
#     for a ciphertext it just removed, and re-encrypting a private post in
#     place would become impossible while the ciphertext itself stayed
#     replaceable. They carry no structural meaning on their own.
#   profile (bio, website, avatarId, location, bannerUrl, displayName),
#   blockFilter (filterData, itemCount, version), blockFollow
#   (followedBlockers)
#     Every property on these is exactly the user-editable state the doctype
#     exists to hold; they are replaced on every profile edit and on every
#     block/unblock.


# The denormalized-owner columns describe themselves as bound to the attested
# `author`; with the agreement moved to `$ownerId` those sentences are wrong.
DESCRIPTIONS = {
    ('like', 'postAuthor'): "The liked post's owner (consensus-bound to the post's $ownerId)",
    ('likeReply', 'replyAuthor'): "The liked reply's owner (consensus-bound to the reply's $ownerId)",
    ('repost', 'postOwnerId'): 'Owner of the reposted post, for notification queries '
                               "(consensus-bound to the post's $ownerId)",
}


def rewrite_agreements(schemas):
    """Point the like/likeReply agreements at `$ownerId`, bind repost.postId."""
    for doc_type, (prop, agreement) in AGREEMENTS.items():
        refers_to = schemas[doc_type]['properties'][prop]['refersTo']
        assert refers_to['type'] == 'permanentDocument', f'{doc_type}.{prop} is not a permanentDocument reference'
        refers_to['propertyAgreement'] = dict(agreement)
    for (doc_type, prop), description in DESCRIPTIONS.items():
        schemas[doc_type]['properties'][prop]['description'] = description


def drop_attested_author(schemas):
    """Delete the `author` column from `post` and `reply`, compacting positions.

    Nothing reads it: a Post's `author.id` is transformed from the document's
    `$ownerId` (lib/services/post-service.ts), which is now also what consensus
    compares the likes against.
    """
    for doc_type in ('post', 'reply'):
        schema = schemas[doc_type]
        assert ATTESTED_AUTHOR in schema['properties'], f'v6 {doc_type} must carry the attested author'
        del schema['properties'][ATTESTED_AUTHOR]
        schema['required'] = [name for name in schema['required'] if name != ATTESTED_AUTHOR]
        compact_positions(schema)


def compact_positions(schema):
    """Renumber top-level `position`s to 0..n-1, preserving their order.

    Removing a property in the middle of the list would otherwise leave a hole
    (`post.hashtag` sat at 15 behind `author` at 14). v7 is a fresh
    registration rather than a contract update, so renumbering costs nothing
    and keeps the positions a contiguous sequence.
    """
    ordered = sorted(schema['properties'].items(), key=lambda item: item[1]['position'])
    for index, (_, definition) in enumerate(ordered):
        definition['position'] = index


def add_immutable(schemas):
    """Attach the `immutable` / `immutableAllowSetting` lists."""
    for doc_type, lists in IMMUTABLE.items():
        schema = schemas[doc_type]
        # The keyword is only accepted on a mutable document type; on an
        # immutable one every property is already frozen.
        assert schema.get('documentsMutable', True) is True, f'{doc_type} is not documentsMutable'
        for name in lists['immutable']:
            assert name in schema['properties'], f'{doc_type}.{name} is not a declared property'
        for name in lists.get('immutableAllowSetting', []):
            assert name in lists['immutable'], f'{doc_type}.{name} allows setting but is not immutable'
            # An allowance only means anything for an OPTIONAL property: a
            # required one always has a value from creation onward.
            assert name not in schema['required'], f'{doc_type}.{name} is required, so the allowance is dead'
        schema['immutable'] = list(lists['immutable'])
        if 'immutableAllowSetting' in lists:
            schema['immutableAllowSetting'] = list(lists['immutableAllowSetting'])


def drop_inferred_countable(schemas):
    """Remove `"countable": "countable"` wherever `rangeCountable: true` implies it.

    beta.2's meta-schema documents the inference and drops the
    `dependentRequired` row that used to demand the pairing. An explicit
    `"countableAllowingOffset"` would still be meaningful (it is NOT what
    rangeCountable promotes to), so only the exact redundant value is removed.
    """
    for schema in schemas.values():
        for index in schema.get('indices', []):
            if index.get('rangeCountable') is True and index.get('countable') == 'countable':
                del index['countable']


def build():
    contract = json.load(open(SRC))
    schemas = contract['documentSchemas']

    assert 'beat' in schemas, 'expected the v6 windowed-rankings contract as the source'
    rewrite_agreements(schemas)
    drop_attested_author(schemas)
    add_immutable(schemas)
    drop_inferred_countable(schemas)
    return contract


# ---------------------------------------------------------------------------


def self_test():
    built = build()
    committed = json.load(open(DST))
    failures = []

    def check(name, condition):
        print(('PASS  ' if condition else 'FAIL  ') + name)
        if not condition:
            failures.append(name)

    check('committed v7 JSON matches a fresh build', built == committed)

    v6 = json.load(open(SRC))['documentSchemas']
    v7 = committed['documentSchemas']

    check('no doctype is added or removed relative to v6', sorted(v7) == sorted(v6))

    # ---- 1. propertyAgreement ------------------------------------------------
    agreements = {
        (doc_type, prop): definition['refersTo']['propertyAgreement']
        for doc_type, schema in v7.items()
        for prop, definition in schema['properties'].items()
        if 'propertyAgreement' in definition.get('refersTo', {})
    }
    check('every propertyAgreement in v7 is exactly the declared set', agreements == {
        ('like', 'postId'): {'hashtag': 'hashtag', 'postAuthor': '$ownerId'},
        ('likeReply', 'replyId'): {'replyAuthor': '$ownerId'},
        ('repost', 'postId'): {'postOwnerId': '$ownerId'},
        ('beat', 'postId'): {'hashtag': 'hashtag'},
    })
    check('no agreement names the removed `author` property',
          not any(ATTESTED_AUTHOR in pairs.values() for pairs in agreements.values()))
    check('no property description still claims a binding to the removed `author`',
          not [f'{t}.{p}' for t, s in v7.items() for p, d in s['properties'].items()
               if 'author)' in d.get('description', '') or 'post.author' in d.get('description', '')
               or 'reply.author' in d.get('description', '')])
    check('no agreement declares a writer gate (anyone may like/beat/repost)',
          not any('$ownerId' in pairs for pairs in agreements.values()))
    check('every referring side of an $ownerId pair is an identifier property',
          all(v7[doc_type]['properties'][referring].get('contentMediaType')
              == 'application/x.dash.dpp.identifier'
              for (doc_type, _), pairs in agreements.items()
              for referring, referenced in pairs.items() if referenced == '$ownerId'))

    # ---- 2. the attested author is gone --------------------------------------
    for doc_type in ('post', 'reply'):
        check(f'{doc_type}.author is no longer a schema property',
              ATTESTED_AUTHOR not in v7[doc_type]['properties'])
        check(f'{doc_type}.author is no longer required',
              ATTESTED_AUTHOR not in v7[doc_type]['required'])
        check(f'{doc_type} keeps every OTHER v6 property, unchanged',
              {name: definition for name, definition in v7[doc_type]['properties'].items()}
              == {name: dict(definition, position=position)
                  for position, (name, definition) in enumerate(
                      sorted(((n, d) for n, d in v6[doc_type]['properties'].items() if n != ATTESTED_AUTHOR),
                             key=lambda item: item[1]['position']))})
        positions = sorted(d['position'] for d in v7[doc_type]['properties'].values())
        check(f'{doc_type} positions are a contiguous 0..n-1 sequence',
              positions == list(range(len(positions))))

    check('like.byAuthorPost stays preallocated (authorId agrees with the post $ownerId)',
          next(i for i in v7['like']['indices'] if i['name'] == 'byAuthorPost').get('preallocated') is True)

    # ---- 3. immutable / immutableAllowSetting --------------------------------
    declared = {doc_type: (schema.get('immutable'), schema.get('immutableAllowSetting'))
                for doc_type, schema in v7.items()
                if 'immutable' in schema or 'immutableAllowSetting' in schema}
    check('exactly post, reply and followRequest freeze properties',
          sorted(declared) == ['followRequest', 'post', 'reply'])
    check('post freezes the structural/identity columns and nothing else',
          declared['post'] == (['language', 'hashtag', 'quotedPostId', 'quotedReplyId', 'quotedPostOwnerId',
                                'embedContractId', 'embedDocType', 'embedId', 'deleted'], ['deleted']))
    check('reply freezes its parent linkage and `deleted`',
          declared['reply'] == (['rootPostId', 'replyToReplyId', 'parentOwnerId', 'deleted'], ['deleted']))
    check('followRequest freezes only targetId', declared['followRequest'] == (['targetId'], None))

    for doc_type, (immutable, allow_setting) in declared.items():
        schema = v7[doc_type]
        check(f'{doc_type} is documentsMutable (immutable is meaningless otherwise)',
              schema.get('documentsMutable', True) is True)
        check(f'{doc_type} freezes only declared, non-system, top-level properties',
              all(name in schema['properties'] and not name.startswith('$') and '.' not in name
                  for name in immutable))
        check(f'{doc_type} immutable entries are unique', len(set(immutable)) == len(immutable))
        check(f'{doc_type} allows setting only immutable, OPTIONAL properties',
              all(name in immutable and name not in schema['required'] for name in allow_setting or []))

    # The tombstone writes `content: ''` and `deleted: true` and drops the rest,
    # so anything a tombstone must be able to blank cannot be frozen.
    tombstone_blanks = {'content', 'mediaUrl', 'sensitive', 'encryptedContent', 'epoch', 'nonce'}
    for doc_type in ('post', 'reply'):
        check(f'{doc_type} freezes nothing the tombstone has to blank or drop',
              not (set(v7[doc_type]['immutable']) & tombstone_blanks))
    check('post.deleted and reply.deleted are OPTIONAL, so the allowance can fire',
          all('deleted' not in v7[t]['required'] for t in ('post', 'reply')))

    # ---- 4. countable inference ----------------------------------------------
    indices = [(doc_type, index) for doc_type, schema in v7.items() for index in schema.get('indices', [])]
    check('no index pairs rangeCountable with a now-redundant explicit countable',
          not [f"{t}.{i['name']}" for t, i in indices
               if i.get('rangeCountable') is True and i.get('countable') == 'countable'])
    check('every rangeCountable index in v6 survives as a rangeCountable index in v7',
          sorted(f"{t}.{i['name']}" for t, i in indices if i.get('rangeCountable') is True)
          == sorted(f'{t}.{i["name"]}' for t, s in v6.items() for i in s.get('indices', [])
                    if i.get('rangeCountable') is True))
    check('indexes countable WITHOUT a range tree keep their explicit countable',
          all(i.get('countable') is not None for t, i in indices
              if i.get('rangeCountable') is not True
              and any(j.get('countable') is not None for u, j in
                      [(t2, i2) for t2, s2 in v6.items() for i2 in s2.get('indices', [])]
                      if u == t and j['name'] == i['name'])))

    # ---- the read surface is untouched ---------------------------------------
    def index_shape(schema):
        return [{k: v for k, v in index.items() if k != 'countable'} for index in schema.get('indices', [])]

    check('every index keeps v6\'s properties, terminal, ranked axes, timeRange and preallocation',
          all(index_shape(v7[t]) == index_shape(v6[t]) for t in v7))
    check('the token costs, config and contract version are v6\'s',
          all(v7[t].get('tokenCost') == v6[t].get('tokenCost') for t in v7)
          and committed['config'] == json.load(open(SRC))['config']
          and committed['version'] == json.load(open(SRC))['version'])

    print()
    print('SELF-TEST PASSED' if not failures else f'{len(failures)} CHECK(S) FAILED')
    return 1 if failures else 0


if __name__ == '__main__':
    if '--self-test' in sys.argv:
        sys.exit(self_test())
    json.dump(build(), open(DST, 'w'), indent=2)
    open(DST, 'a').write('\n')
    print(f'wrote {DST}')
