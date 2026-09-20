#!/usr/bin/env python3
"""Builds contracts/yappr-social-contract-v8.json from the v7 contract.

v8 is the 4.2.0-beta.3 cut (docs/SOCIAL_V8.md). The query surface is v7's:
every index, terminal, ranked axis and timeRange window is unchanged, so the
whole client read path carries over. What v8 adds is the beta.3 grammar that
cannot be added to a live contract by an update, which is why it is a fresh
registration rather than a `dataContractUpdate`:

1.  **Contract moderation** (#4830/#4849/#4857/#4864). The contract config
    moves to `$formatVersion: "2"` and declares `moderation`: a banlist, a
    suspension list, and who edits them. A banned or suspended identity has
    every document transition against the contract refused (41107/41108);
    which lists a contract keeps is fixed at creation, so both are on.
    The committed JSON names `contractOwner` as the moderators; the
    registration script may appoint identities at publish time
    (`--moderators`), and every appointed identity must exist on chain
    (41110).

2.  **Moderator takedown of posts and replies.** `canBeDeletedByModerators:
    true` on `post` and `reply`, with NO window: a moderator may delete any
    post or reply at any time, leaving a removal record with a reason. The
    documents stay `canBeDeleted: false` for their OWNERS, whose "delete" is
    still the tombstone replace.

    A type a moderator can delete counts as DELETABLE for references, so every
    `refersTo: permanentDocument` at `post`/`reply` is refused at registration
    (40122) and becomes `deletableDocument` (#4860). The agreements are
    unchanged. `preallocated` is only available through `permanentDocument`,
    so it is dropped from the four like indexes that carried it; the first
    like on a fresh post creates the count entry instead of finding one.

3.  **Free usage** (#4826/#4828). The five YAPP-priced types set
    `tokenCost.create.optional: true` and `gasFeesPaidBy: 2`
    (PreferContractOwner): a transition that carries `$tokenPaymentInfo` pays
    YAPP and the contract owner pays its gas when the owner's balance covers
    it; one that leaves the payment info out pays credits as an unpriced
    action, with no sponsorship. The client chooses before signing.

4.  **Starter grant** (#4827). The YAPP token's distribution rules move to
    `$formatVersion: "1"` and declare `oncePerIdentityDistribution` of 100
    YAPP, claimable exactly once per identity (40722 on a second claim).
    Registration carries a +0.1 DASH surcharge for a token with this rule.

5.  **Action fees to the moderators pot** (#4851/#4856/#4858). `post.create`
    and `reply.create` charge a fixed credit fee on top of gas, scaled by the
    epoch fee multiplier (`pricing: feeMultiplier`), paid entirely into the
    contract's MODERATORS pot (no `owner` part: a sponsored action never pays
    the owner part anyway, and the pot is what pays the moderation team).
    Every create of those two types must carry `$actionFeeAgreement` naming
    these exact amounts (40132 without, 40133 mismatched).

Everything else is byte-identical to v7: immutable lists, `$ownerId`
agreements, indexes, TTLs, the token's supply and rules.

Deterministic transform so the diff against v7 is reviewable as code; running
it twice produces byte-identical output.

Run:
  python3 scripts/build-v8-contract.py              # (re)write the v8 JSON
  python3 scripts/build-v8-contract.py --self-test  # assert the committed JSON
"""
import json
import sys

SRC = 'contracts/yappr-social-contract-v7.json'
DST = 'contracts/yappr-social-contract-v8.json'

# ---------------------------------------------------------------------------
# 1. Contract moderation. Both lists on (fixed at creation, never changeable);
# the moderators default to the owner and are a publish-time parameter.
MODERATION = {
    'banlist': True,
    'suspensions': True,
    'moderators': {'$type': 'contractOwner'},
}
# `moderation` is a field of config V2 only (rs-dpp DataContractConfigV2); a
# `$formatVersion: "1"` config silently drops it on parse.
CONFIG_FORMAT_VERSION = '2'

# ---------------------------------------------------------------------------
# 2. Moderator takedown, and the reference cascade it forces.
MODERATOR_DELETABLE = ['post', 'reply']

# Indexes whose `preallocated` rides a reference that is now deletable.
PREALLOCATED_TO_DROP = {
    'like': ['byPost', 'byHashtagPost', 'byAuthorPost'],
    'likeReply': ['byReply'],
}

# ---------------------------------------------------------------------------
# 3. Free usage: optional token cost + owner-preferred gas on the priced types.
GAS_PREFER_CONTRACT_OWNER = 2
YAPP_PRICED = ['post', 'reply', 'like', 'likeReply', 'repost']

# ---------------------------------------------------------------------------
# 4. Starter grant.
STARTER_GRANT = {'$formatVersion': '0', 'amount': 100}
DISTRIBUTION_RULES_FORMAT_VERSION = '1'

# ---------------------------------------------------------------------------
# 5. Action fees, in credits before the epoch multiplier (1 DASH = 1e11
# credits; ~$0.05 and ~$0.01 at $60/DASH).
ACTION_FEES = {
    'post': {'pricing': 'feeMultiplier', 'create': {'moderators': 80_000_000}},
    'reply': {'pricing': 'feeMultiplier', 'create': {'moderators': 16_000_000}},
}

DESCRIPTIONS = {
    'post': 'A top-level post in the social network (not a reply). Permanent for its owner '
            '(a delete is a tombstone replace); the contract\'s moderators may remove it',
    'reply': 'A reply, anchored to its thread root; replyToReplyId is presentational nesting only. '
             'Permanent for its owner (a delete is a tombstone replace); the contract\'s moderators may remove it',
}


def add_moderation(contract, moderators=None):
    config = contract['config']
    config['$formatVersion'] = CONFIG_FORMAT_VERSION
    config['moderation'] = dict(MODERATION, moderators=moderators or MODERATION['moderators'])


def add_moderator_delete(schemas):
    for doc_type in MODERATOR_DELETABLE:
        schema = schemas[doc_type]
        assert schema.get('canBeDeleted') is False, f'{doc_type} must stay permanent for its owner'
        assert not schema.get('documentsKeepHistory') and not schema.get('indexOnly'), \
            f'{doc_type} cannot be moderator-deletable'
        schema['canBeDeletedByModerators'] = True
        schema['description'] = DESCRIPTIONS[doc_type]


def cascade_deletable_references(schemas):
    """Every reference at a moderator-deletable type becomes `deletableDocument`."""
    for schema in schemas.values():
        for definition in schema['properties'].values():
            refers_to = definition.get('refersTo')
            if refers_to and refers_to.get('documentType') in MODERATOR_DELETABLE:
                assert refers_to['type'] == 'permanentDocument', 'v7 references are all permanentDocument'
                refers_to['type'] = 'deletableDocument'
    for doc_type, names in PREALLOCATED_TO_DROP.items():
        for index in schemas[doc_type]['indices']:
            if index['name'] in names:
                assert index.pop('preallocated') is True, f'{doc_type}.{index["name"]} was not preallocated'


def add_optional_token_cost(schemas):
    for doc_type in YAPP_PRICED:
        create = schemas[doc_type]['tokenCost']['create']
        assert create['tokenPosition'] == 0 and 'optional' not in create
        create['optional'] = True
        create['gasFeesPaidBy'] = GAS_PREFER_CONTRACT_OWNER


def add_starter_grant(contract):
    rules = contract['tokens']['0']['distributionRules']
    assert rules['$formatVersion'] == '0' and 'oncePerIdentityDistribution' not in rules
    rules['$formatVersion'] = DISTRIBUTION_RULES_FORMAT_VERSION
    rules['oncePerIdentityDistribution'] = dict(STARTER_GRANT)


def add_action_fees(schemas):
    for doc_type, fees in ACTION_FEES.items():
        assert 'actionFees' not in schemas[doc_type]
        schemas[doc_type]['actionFees'] = json.loads(json.dumps(fees))


def build(moderators=None):
    contract = json.load(open(SRC))
    schemas = contract['documentSchemas']
    assert 'immutable' in schemas['post'], 'expected the v7 beta.2 contract as the source'
    add_moderation(contract, moderators)
    add_moderator_delete(schemas)
    cascade_deletable_references(schemas)
    add_optional_token_cost(schemas)
    add_starter_grant(contract)
    add_action_fees(schemas)
    return contract


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

    check('committed v8 JSON matches a fresh build', built == committed)

    v7 = source['documentSchemas']
    v8 = committed['documentSchemas']
    check('no doctype is added or removed relative to v7', sorted(v8) == sorted(v7))

    # ---- 1. moderation -------------------------------------------------------
    config = committed['config']
    check('the config is format version 2 (the only one that carries moderation)',
          config['$formatVersion'] == CONFIG_FORMAT_VERSION)
    check('both moderation lists are kept and the owner moderates by default',
          config['moderation'] == MODERATION)
    check('every other config field is v7\'s',
          {k: v for k, v in config.items() if k not in ('$formatVersion', 'moderation')}
          == {k: v for k, v in source['config'].items() if k != '$formatVersion'})

    # ---- 2. moderator delete + deletable references -------------------------
    deletable = sorted(t for t, s in v8.items() if s.get('canBeDeletedByModerators'))
    check('exactly post and reply are moderator-deletable', deletable == sorted(MODERATOR_DELETABLE))
    check('no moderator-deletable type carries a window',
          not any('canBeDeletedByModeratorsFor' in v8[t] for t in deletable))
    check('post and reply stay canBeDeleted: false for their owners',
          all(v8[t]['canBeDeleted'] is False for t in deletable))

    refs = {(t, p): d['refersTo'] for t, s in v8.items() for p, d in s['properties'].items() if 'refersTo' in d}
    at_deletable = {k: r for k, r in refs.items() if r.get('documentType') in deletable}
    check('the nine references at post/reply are exactly the expected set',
          sorted(f'{t}.{p}' for t, p in at_deletable)
          == ['beat.postId', 'bookmark.postId', 'like.postId', 'likeReply.replyId', 'post.quotedPostId',
              'post.quotedReplyId', 'reply.replyToReplyId', 'reply.rootPostId', 'repost.postId'])
    check('every reference at post/reply is a deletableDocument reference',
          all(r['type'] == 'deletableDocument' for r in at_deletable.values()))
    check('no deletableDocument reference points anywhere else',
          all(r.get('documentType') in deletable for r in refs.values() if r['type'] == 'deletableDocument'))
    check('every propertyAgreement is v7\'s, unchanged',
          {k: r.get('propertyAgreement') for k, r in refs.items()}
          == {(t, p): d['refersTo'].get('propertyAgreement')
              for t, s in v7.items() for p, d in s['properties'].items() if 'refersTo' in d})
    check('no index is preallocated any more (preallocation needs permanentDocument)',
          not any(i.get('preallocated') for s in v8.values() for i in s.get('indices', [])))
    check('the four indexes that lost preallocated are exactly the v7 preallocated set',
          sorted(f"{t}.{i['name']}" for t, s in v7.items() for i in s.get('indices', []) if i.get('preallocated'))
          == sorted(f'{t}.{n}' for t, names in PREALLOCATED_TO_DROP.items() for n in names))

    def index_shape(schema):
        return [{k: v for k, v in index.items() if k != 'preallocated'} for index in schema.get('indices', [])]
    check('every index keeps v7\'s properties, terminal, ranked axes and timeRange',
          all(index_shape(v8[t]) == index_shape(v7[t]) for t in v8))

    # ---- 3. optional token cost + gas sponsorship ---------------------------
    priced = sorted(t for t, s in v8.items() if 'tokenCost' in s)
    check('the YAPP-priced types are v7\'s five', priced == sorted(YAPP_PRICED)
          and priced == sorted(t for t, s in v7.items() if 'tokenCost' in s))
    check('every priced create is optional and offers PreferContractOwner gas',
          all(v8[t]['tokenCost']['create'].get('optional') is True
              and v8[t]['tokenCost']['create'].get('gasFeesPaidBy') == GAS_PREFER_CONTRACT_OWNER for t in priced))
    check('amounts and token positions are v7\'s',
          all({k: v for k, v in v8[t]['tokenCost']['create'].items() if k not in ('optional', 'gasFeesPaidBy')}
              == v7[t]['tokenCost']['create'] for t in priced))

    # ---- 4. starter grant ----------------------------------------------------
    rules = committed['tokens']['0']['distributionRules']
    check('distribution rules are format version 1 with a 100 YAPP once-per-identity grant',
          rules['$formatVersion'] == DISTRIBUTION_RULES_FORMAT_VERSION
          and rules['oncePerIdentityDistribution'] == STARTER_GRANT)
    check('every other distribution rule is v7\'s',
          {k: v for k, v in rules.items() if k not in ('$formatVersion', 'oncePerIdentityDistribution')}
          == {k: v for k, v in source['tokens']['0']['distributionRules'].items() if k != '$formatVersion'})
    check('the rest of the token configuration is v7\'s',
          {k: v for k, v in committed['tokens']['0'].items() if k != 'distributionRules'}
          == {k: v for k, v in source['tokens']['0'].items() if k != 'distributionRules'})

    # ---- 5. action fees -------------------------------------------------------
    check('exactly post.create and reply.create charge action fees, to the moderators pot only',
          {t: s['actionFees'] for t, s in v8.items() if 'actionFees' in s} == ACTION_FEES)
    check('no action fee names an owner part',
          not any('owner' in fee for s in v8.values() for k, fee in s.get('actionFees', {}).items() if k != 'pricing'))

    # ---- everything else is v7 -----------------------------------------------
    added = {'canBeDeletedByModerators', 'actionFees', 'description'}
    check('every doctype is v7\'s apart from the keys v8 adds, its references and tokenCost',
          all({k: v for k, v in v8[t].items() if k not in added | {'properties', 'indices', 'tokenCost'}}
              == {k: v for k, v in v7[t].items() if k not in added | {'properties', 'indices', 'tokenCost'}}
              for t in v8))
    check('every property is v7\'s apart from the reference type',
          all({p: {k: v for k, v in d.items() if k != 'refersTo'} for p, d in v8[t]['properties'].items()}
              == {p: {k: v for k, v in d.items() if k != 'refersTo'} for p, d in v7[t]['properties'].items()}
              for t in v8))
    check('immutable lists are v7\'s',
          all((v8[t].get('immutable'), v8[t].get('immutableAllowSetting'))
              == (v7[t].get('immutable'), v7[t].get('immutableAllowSetting')) for t in v8))
    check('the contract version is v7\'s', committed['version'] == source['version'])

    print()
    print('SELF-TEST PASSED' if not failures else f'{len(failures)} CHECK(S) FAILED')
    return 1 if failures else 0


if __name__ == '__main__':
    if '--self-test' in sys.argv:
        sys.exit(self_test())
    json.dump(build(), open(DST, 'w'), indent=2)
    open(DST, 'a').write('\n')
    print(f'wrote {DST}')
