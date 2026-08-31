#!/usr/bin/env python3
"""Builds contracts/yappr-social-contract-v5.json from the v4 contract.

v5 = v4 + the dev.7 aggregate-index grammar (PLAN_DEV6_V5.md, decision D-V5-1
RESOLVED as merged multi-at index + plain sibling):

  - post.hashtag becomes OPTIONAL (the '' sentinel dies) with the MANDATORY
    61-char ceiling (63 is rejected by the ranked-key-size validation).
  - like.hashtag becomes optional; byHashtagPost gains skipIfAbsent (untagged
    likes write no entry at all) + rankedCountable at "hashtag" (provable
    trending hashtags); byAuthorPost gains the multi-at form
    {at: ["postAuthor", "postId"]} (creator leaderboard + per-author Top from
    ONE index); byPost gains terminal ranking; byAuthorTimePost stays PLAIN —
    carrying NO aggregate flags is load-bearing for the #4543 count-exempt
    sibling admission next to the at-chain.
  - follow.followerCount gains the ranked chain (provable most-followed +
    O(1) follower counts).
  - Everything else passes through unchanged (postHashtag stayed deleted).

The exact like-index shape was verified end-to-end (scratch e2e against the
merged platform code that shipped in v4.2.0-dev.7); the grammar spellings match
the upstream fixture
packages/rs-drive/tests/supporting_files/contract/trending/trending-contract.json
(`plike` doctype). Deterministic transform so the diff against v4 is reviewable
as code; running it twice produces byte-identical output.

Run:
  python3 scripts/build-v5-contract.py              # (re)write the v5 JSON
  python3 scripts/build-v5-contract.py --self-test  # assert the committed JSON
"""
import copy
import json
import sys

SRC = 'contracts/yappr-social-contract-v4.json'
DST = 'contracts/yappr-social-contract-v5.json'

# Optional now: absence == untagged. The v4 '' sentinel (the `^$|` pattern
# alternative and minLength 0) dies with it. maxLength 61 is MANDATORY: an
# at-level ranked string key must fit the 247-byte encoded ceiling, and 63 was
# rejected at contract validation during the dev.7 scratch e2e.
HASHTAG = {
    'type': 'string', 'pattern': '^[a-z0-9_]{1,61}$', 'minLength': 1,
    'maxLength': 61, 'description': 'Lowercase hashtag without # prefix; omitted entirely when untagged',
}
RANKED_CHAIN = {'countable': 'countable', 'rangeCountable': True}


def build():
    c = json.load(open(SRC))
    d = c['documentSchemas']

    # ---- post: hashtag optional, 61-char ceiling --------------------------------
    post = d['post']
    assert 'hashtag' in post['required'], 'v4 post must carry required hashtag'
    post['required'] = [r for r in post['required'] if r != 'hashtag']
    post['properties']['hashtag'] = dict(HASHTAG, position=post['properties']['hashtag']['position'])

    # ---- reply: carries NO hashtag in v4 — nothing to mirror --------------------
    assert 'hashtag' not in d['reply']['properties'], 'reply gained a hashtag since v4? mirror the post treatment'

    # ---- like: skipIfAbsent hashtag + prefix rankings ---------------------------
    # Same doctype as v4 except: hashtag optional, byHashtagPost skip+at-ranked,
    # byAuthorPost multi-at-ranked, byPost terminal-ranked, byAuthorTimePost
    # stripped to a PLAIN index. byLiker unchanged.
    like = d['like']
    assert like['required'] == ['$createdAt', 'postId', 'hashtag', 'postAuthor'], 'unexpected v4 like required set'
    like['required'] = ['$createdAt', 'postId', 'postAuthor']
    like['properties']['hashtag'] = dict(HASHTAG, position=like['properties']['hashtag']['position'])
    like['indices'] = [
        {'name': 'byPost', 'properties': [{'postId': 'asc'}],
         'terminal': '$ownerId', 'preallocated': True, **RANKED_CHAIN, 'rankedCountable': True},
        # skipIfAbsent: an untagged like (hashtag ABSENT) writes no entry here at
        # all. Multi-at {at: [hashtag, postId]}: the hashtag level ranks tags by
        # total like count (trending), and the terminal postId level (array's
        # last name folds to the boolean form) ranks posts WITHIN a pinned tag —
        # the tag page's Top toggle. Live wipe-day calibration proved the
        # single-level {at: "hashtag"} form serves ONLY trending: the router
        # refuses `group_by=[postId]` with a hashtag pin ("no ranked index
        # covers ..."), which silently killed per-tag Top. The optional trigger
        # must be FIRST and this must be its only index (closure rules).
        {'name': 'byHashtagPost', 'properties': [{'hashtag': 'asc'}, {'postId': 'asc'}],
         'terminal': '$ownerId', 'preallocated': True, **RANKED_CHAIN,
         'rankedCountable': {'at': ['hashtag', 'postId']}, 'skipIfAbsent': True},
        # Multi-at: postAuthor level = creator leaderboard (authors by likes
        # received), terminal postId level = per-author Top posts — one index
        # serves both (D-V5-1 merged option).
        {'name': 'byAuthorPost', 'properties': [{'postAuthor': 'asc'}, {'postId': 'asc'}],
         'terminal': '$ownerId', 'preallocated': True, **RANKED_CHAIN,
         'rankedCountable': {'at': ['postAuthor', 'postId']}},
        # PLAIN on purpose (no countable/rangeCountable/rankedCountable/
        # preallocated): #4543 admits a count-exempt sibling sharing the
        # at-chain's postAuthor level ONLY while it carries no aggregate flags.
        # $createdAt is the like's own timestamp — not derivable from the post —
        # so it could never be preallocated anyway.
        {'name': 'byAuthorTimePost',
         'properties': [{'postAuthor': 'asc'}, {'$createdAt': 'asc'}, {'postId': 'asc'}],
         'terminal': '$ownerId'},
        {'name': 'byLiker', 'properties': [{'$ownerId': 'asc'}], 'terminal': 'postId'},
    ]
    # propertyAgreement keeps binding hashtag — dev.7 agreement is absence-aware:
    # both absent = agree, so a like omits hashtag exactly when the post does.
    assert like['properties']['postId']['refersTo']['propertyAgreement'] == \
        {'hashtag': 'hashtag', 'postAuthor': 'author'}, 'unexpected v4 like propertyAgreement'

    # ---- likeReply: no hashtag in v4 → unchanged --------------------------------
    assert 'hashtag' not in d['likeReply']['properties'], 'likeReply gained a hashtag since v4?'

    # ---- follow: ranked chain on [followingId] ----------------------------------
    # Deferred since the v4 freeze: provable most-followed leaderboard + O(1)
    # follower counts. The existing followerCount index already is
    # [followingId] countable; upgrade it in place (legacy boolean `countable`
    # normalizes to the enum form the chain requires under rangeCountable).
    follow_counts = [i for i in d['follow']['indices'] if i['name'] == 'followerCount']
    assert len(follow_counts) == 1 and follow_counts[0]['properties'] == [{'followingId': 'asc'}] \
        and follow_counts[0].get('countable') is True, 'unexpected v4 follow.followerCount shape'
    follow_counts[0].update({**RANKED_CHAIN, 'rankedCountable': True})

    c['version'] = 1
    return c


# ---- Self-test ----------------------------------------------------------------

PASSTHROUGH_DOCTYPES = [
    'repost', 'bookmark', 'block', 'blockFilter', 'blockFollow', 'followRequest',
    'postMention', 'privateFeedGrant', 'privateFeedRekey', 'privateFeedState',
    'profile', 'likeReply',
]


def self_test(built):
    checks = []

    def check(name, cond, detail=''):
        checks.append((name, bool(cond), detail))

    src = json.load(open(SRC))
    try:
        on_disk = open(DST).read()
    except FileNotFoundError:
        on_disk = None
    d = built['documentSchemas']

    # Determinism / staleness: the committed file must be byte-identical to a
    # fresh build (json.dump adds no trailing newline; neither does the file).
    check('committed v5 JSON is byte-identical to a fresh build',
          on_disk is not None and on_disk == json.dumps(built, indent=2),
          'run the script to (re)write it' if on_disk is None else '')

    # ---- hashtag: pattern / bounds / optionality ----
    for owner, dt in [('post', d['post']), ('like', d['like'])]:
        h = dt['properties']['hashtag']
        check(f'{owner}.hashtag pattern is ^[a-z0-9_]{{1,61}}$ (no empty alternative)',
              h['pattern'] == '^[a-z0-9_]{1,61}$', h['pattern'])
        check(f'{owner}.hashtag maxLength is 61 (MANDATORY ranked-key ceiling)', h['maxLength'] == 61)
        check(f'{owner}.hashtag minLength is 1 (the 0-length sentinel died)', h['minLength'] == 1)
        check(f'{owner}.hashtag is NOT required', 'hashtag' not in dt['required'], str(dt['required']))
    check('reply carries no hashtag (parity with v4)', 'hashtag' not in d['reply']['properties'])
    check('like.required is exactly [$createdAt, postId, postAuthor]',
          d['like']['required'] == ['$createdAt', 'postId', 'postAuthor'], str(d['like']['required']))

    # ---- like indexes: the verified end-to-end shape, flag-exact ----
    idx = {i['name']: i for i in d['like']['indices']}
    check('like has exactly the 5 verified indexes',
          list(idx) == ['byPost', 'byHashtagPost', 'byAuthorPost', 'byAuthorTimePost', 'byLiker'],
          str(list(idx)))
    check('byPost = [postId] terminal $ownerId, countable+rangeCountable+rankedCountable:true+preallocated',
          idx.get('byPost') == {
              'name': 'byPost', 'properties': [{'postId': 'asc'}], 'terminal': '$ownerId',
              'preallocated': True, 'countable': 'countable', 'rangeCountable': True,
              'rankedCountable': True,
          }, json.dumps(idx.get('byPost')))
    check('byHashtagPost = [hashtag, postId] + skipIfAbsent + rankedCountable {at: ["hashtag", "postId"]} (upstream "both" fixture spelling)',
          idx.get('byHashtagPost') == {
              'name': 'byHashtagPost', 'properties': [{'hashtag': 'asc'}, {'postId': 'asc'}],
              'terminal': '$ownerId', 'preallocated': True, 'countable': 'countable',
              'rangeCountable': True, 'rankedCountable': {'at': ['hashtag', 'postId']}, 'skipIfAbsent': True,
          }, json.dumps(idx.get('byHashtagPost')))
    check('byAuthorPost = [postAuthor, postId] + rankedCountable {at: ["postAuthor", "postId"]} (multi-at form)',
          idx.get('byAuthorPost') == {
              'name': 'byAuthorPost', 'properties': [{'postAuthor': 'asc'}, {'postId': 'asc'}],
              'terminal': '$ownerId', 'preallocated': True, 'countable': 'countable',
              'rangeCountable': True, 'rankedCountable': {'at': ['postAuthor', 'postId']},
          }, json.dumps(idx.get('byAuthorPost')))
    check('byAuthorTimePost is PLAIN — name/properties/terminal and NOTHING else (#4543 sibling admission)',
          idx.get('byAuthorTimePost') == {
              'name': 'byAuthorTimePost',
              'properties': [{'postAuthor': 'asc'}, {'$createdAt': 'asc'}, {'postId': 'asc'}],
              'terminal': '$ownerId',
          }, json.dumps(idx.get('byAuthorTimePost')))
    check('byLiker unchanged from v4',
          idx.get('byLiker') == {'name': 'byLiker', 'properties': [{'$ownerId': 'asc'}], 'terminal': 'postId'},
          json.dumps(idx.get('byLiker')))
    check('like propertyAgreement is {hashtag: "hashtag", postAuthor: "author"}',
          d['like']['properties']['postId']['refersTo'] == {
              'type': 'permanentDocument', 'documentType': 'post',
              'propertyAgreement': {'hashtag': 'hashtag', 'postAuthor': 'author'},
          }, json.dumps(d['like']['properties']['postId'].get('refersTo')))

    # ---- skipIfAbsent closure rules (document-meta v3) ----
    # trigger optional; trigger FIRST in every index containing it, all such
    # indexes skip-flagged; >=1 $createdAt-free non-skip index (proof index).
    for i in d['like']['indices']:
        props = [list(p)[0] for p in i['properties']]
        if 'hashtag' in props:
            check(f'{i["name"]}: hashtag is first and the index is skipIfAbsent',
                  props[0] == 'hashtag' and i.get('skipIfAbsent') is True, json.dumps(i))
    check('like keeps a $createdAt-free non-skip proof index',
          any('$createdAt' not in [list(p)[0] for p in i['properties']] and not i.get('skipIfAbsent')
              for i in d['like']['indices']))

    # ---- follow: ranked chain on [followingId] ----
    fidx = {i['name']: i for i in d['follow']['indices']}
    check('follow.followerCount = [followingId] countable+rangeCountable+rankedCountable:true',
          fidx.get('followerCount') == {
              'name': 'followerCount', 'properties': [{'followingId': 'asc'}],
              'countable': 'countable', 'rangeCountable': True, 'rankedCountable': True,
          }, json.dumps(fidx.get('followerCount')))
    check('follow index names unchanged from v4',
          list(fidx) == ['ownerAndFollowing', 'following', 'followers', 'followerCount', 'followingCount'],
          str(list(fidx)))

    # ---- passthrough parity ----
    check('doctype set = v4 doctypes (postHashtag stays deleted)',
          sorted(d) == sorted(src['documentSchemas']), str(sorted(d)))
    for name in PASSTHROUGH_DOCTYPES:
        check(f'{name} passes through byte-identical to v4',
              d[name] == src['documentSchemas'][name])
    src_post = copy.deepcopy(src['documentSchemas']['post'])
    src_post['required'] = [r for r in src_post['required'] if r != 'hashtag']
    del src_post['properties']['hashtag']
    v5_post = copy.deepcopy(d['post'])
    del v5_post['properties']['hashtag']
    check('post is untouched apart from the hashtag property/required change', v5_post == src_post)
    check('reply passes through byte-identical to v4', d['reply'] == src['documentSchemas']['reply'])
    src_like = src['documentSchemas']['like']
    check('like tokenCost/flags unchanged from v4',
          all(d['like'].get(k) == src_like.get(k)
              for k in ['type', 'indexOnly', 'documentsMutable', 'canBeDeleted', 'tokenCost', 'additionalProperties']))

    failures = 0
    for name, ok, detail in checks:
        print(f'{"PASS" if ok else "FAIL"}  {name}{f" — {detail}" if (detail and not ok) else ""}')
        if not ok:
            failures += 1
    print(f'\n{len(checks) - failures}/{len(checks)} self-test checks passed')
    return failures == 0


if __name__ == '__main__':
    contract = build()
    if '--self-test' in sys.argv[1:]:
        sys.exit(0 if self_test(contract) else 1)
    json.dump(contract, open(DST, 'w'), indent=2)
    print(f'wrote {DST}: {len(contract["documentSchemas"])} doctypes:',
          ', '.join(sorted(contract['documentSchemas'])))
