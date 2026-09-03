#!/usr/bin/env python3
"""Builds contracts/yappr-social-contract-v6.json from the v5 contract.

**This contract does not register on protocol v14.** It is the shape yappr
wants once time-bucketed rankings exist, written in the grammar we expect that
feature to use, so platform can point its implementation at a real application
contract. Everything else about it is production-shaped: v6 is v5 plus three
windowed indexes on `like`, and nothing is removed.

v14 rejects it at contract validation with

    a timeRange index cannot be ranked (rankedCountable / rankedSummable /
    rankedAverageable): ranked queries have no time-bucket semantics, so the
    ranked secondaries would be maintained but never servable

which is precisely the combination this file asks for. See
docs/V6_WINDOWED_RANKINGS.md for the queries each new index has to serve and
why the two objections recorded in that rejection (unservable secondaries,
overlap double-counting) do not apply when the bucket is pinned.

The windowed indexes mirror their all-time v5 counterparts one for one — same
properties, same terminal, same at-levels — with a bucketed `$createdAt`
prepended. That is deliberate: it keeps the diff against a shape already
proven on-chain (verify-v5.mjs, 91/91 live on moutai) down to the timeRange
transform itself.

Deterministic transform so the diff against v5 is reviewable as code; running
it twice produces byte-identical output.

Run:
  python3 scripts/build-v6-contract.py              # (re)write the v6 JSON
  python3 scripts/build-v6-contract.py --self-test  # assert the committed JSON
"""
import copy
import json
import sys

SRC = 'contracts/yappr-social-contract-v5.json'
DST = 'contracts/yappr-social-contract-v6.json'

# One day, non-overlapping (range == step, overlap factor 1). Non-overlapping
# grids cost the same as an ordinary index per write — a document lands in
# exactly one bucket — which is why the shipping shapes below all use this
# grid. `phase` stays 0: windows cut at UTC midnight.
DAY = {'on': '$createdAt', 'range': 86400, 'step': 86400}

# Rolling 24h refreshed every 6h (overlap factor 4, cap is 24). Included as a
# FOURTH index purely so the implementation can be tested against an
# overlapping grid; a document is indexed under 4 bucket keys, so this index
# costs ~4x its non-overlapping twin per write and yappr would not ship both.
ROLLING = {'on': '$createdAt', 'range': 86400, 'step': 21600}


def windowed(source_index, name, time_range):
    """A windowed twin of an existing all-time index.

    Prepends the bucketed timestamp to the property list and keeps everything
    else — terminal, preallocation, count/range/ranked axes — identical, so the
    only difference between the two indexes is the time bound.
    """
    index = copy.deepcopy(source_index)
    index['name'] = name
    index['properties'] = [{'$createdAt': 'asc'}] + index['properties']
    index['timeRange'] = dict(time_range)
    # preallocated cannot survive it either: a bucketed level is keyed by
    # bucket starts computed from the like's own $createdAt at write time, so
    # its path cannot be created ahead of time from the referenced post the
    # way the all-time twins' paths are (validated on upstream HEAD after
    # #4578: "declares `preallocated` together with `timeRange` ... cannot be
    # preallocated from a referenced document").
    index.pop('preallocated', None)
    # skipIfAbsent cannot survive the prepend: its trigger has to be the FIRST
    # index property, which the timeRange source now occupies. Untagged likes
    # therefore write a null entry in the windowed hashtag index — see the
    # "asks" section of docs/V6_WINDOWED_RANKINGS.md, where relaxing that rule
    # to "first non-timeRange property" is the one secondary request.
    index.pop('skipIfAbsent', None)
    return index


def build():
    contract = json.load(open(SRC))
    schemas = contract['documentSchemas']

    like = schemas['like']
    assert like.get('indexOnly') is True, 'v5 like must be indexOnly'
    assert '$createdAt' in like['required'], 'timeRange.on must be a required property'

    by_name = {index['name']: index for index in like['indices']}
    assert set(by_name) >= {'byPost', 'byHashtagPost', 'byAuthorPost'}, 'v5 like indexes moved'

    # Global "Top posts today" (Explore Top, windowed): pin the newest bucket,
    # rank at the terminal postId level. Twin of the all-time byPost.
    like['indices'].append(windowed(by_name['byPost'], 'byDayPost', DAY))

    # Trending hashtags today + top posts per tag today CANNOT live on `like`:
    # like.hashtag is optional (v5 killed the '' sentinel), and upstream HEAD
    # rejects an optional property anywhere but the FIRST position of a
    # skipIfAbsent index — under a timeRange the first position is the
    # timestamp, so the windowed hashtag index is rejected with "appears in
    # index below its first position: ... absence would strand the prefix
    # levels above it". Both escape hatches were probed on HEAD and rejected
    # too (skipIfAbsent with $createdAt first: "system properties are always
    # present"; making hashtag required: v5's own byHashtagPost then "could
    # never skip"). So the windowed hashtag rankings move to a separate
    # tagged-only doctype — see `beat` below.

    # Top creators today + top posts by one author today, and — with an `In`
    # pin set over postAuthor — "most liked recent posts by people I follow".
    # Twin of the all-time byAuthorPost.
    like['indices'].append(windowed(by_name['byAuthorPost'], 'byDayAuthorPost', DAY))

    assert len(like['indices']) <= 10, 'document meta-schema caps indices at 10 per doctype'

    # ---- beat: the windowed hashtag rankings, written ONLY for tagged likes ----
    # An indexOnly doctype with hashtag REQUIRED, so the windowed hashtag index
    # is legal. The client writes one `beat` beside every like of a tagged post
    # (same batch transition), and the `postId` refersTo carries the same
    # propertyAgreement as `like.postId` — consensus enforces beat.hashtag ==
    # post.hashtag exactly as it does for like.hashtag. Untagged likes write no
    # beat at all, which is the skipIfAbsent economy by other means.
    like_post_id = copy.deepcopy(like['properties']['postId'])
    like_post_id['refersTo'] = copy.deepcopy(like_post_id['refersTo'])
    like_post_id['refersTo']['propertyAgreement'] = {'hashtag': 'hashtag'}
    beat = {
        'type': 'object',
        'indexOnly': True,
        'documentsMutable': False,
        'canBeDeleted': True,
        'properties': {
            'postId': dict(like_post_id, position=0, description='ID of the liked (tagged) post'),
            'hashtag': dict(copy.deepcopy(like['properties']['hashtag']), position=1,
                            description='The liked post\'s hashtag; consensus-checked against it'),
        },
        'required': ['$createdAt', 'postId', 'hashtag'],
        'additionalProperties': False,
        'indices': [
            # Trending hashtags today (pin bucket, rank at hashtag) + top posts
            # for #tag today (pin bucket + hashtag, rank at postId): the
            # windowed twin of like.byHashtagPost.
            windowed(by_name['byHashtagPost'], 'byDayHashtagPost', DAY),
            # Overlapping-grid probe, test material rather than a shape we
            # would ship.
            windowed(by_name['byHashtagPost'], 'byRollingHashtagPost', ROLLING),
            # Unlike needs the beat's index entry found by post: indexOnly
            # delete-by-values resolves through this plain index.
            {'name': 'byPost', 'properties': [{'postId': 'asc'}], 'terminal': '$ownerId'},
            # ...and needs the beat's OWN $createdAt for the delete tuple. No
            # bucketed index projects it (they store the bucket START), and the
            # beat lands in a later block than its like, so the like's
            # timestamp is not a substitute (probed live: "document not
            # found"). This plain twin of like.byAuthorTimePost projects it
            # (postId pinned, $createdAt as a key, $ownerId terminal).
            {'name': 'byPostTime', 'properties': [{'postId': 'asc'}, {'$createdAt': 'asc'}], 'terminal': '$ownerId'},
        ],
    }
    assert 'beat' not in schemas, 'v5 must not already carry a beat doctype'
    schemas['beat'] = beat
    return contract


def self_test():
    built = build()
    committed = json.load(open(DST))
    failures = []

    def check(name, condition):
        print(('PASS  ' if condition else 'FAIL  ') + name)
        if not condition:
            failures.append(name)

    check('committed v6 JSON matches a fresh build', built == committed)

    v5 = json.load(open(SRC))['documentSchemas']
    v6 = committed['documentSchemas']

    check('only `like` differs from v5, plus the new `beat` doctype',
          sorted(t for t in v6 if json.dumps(v6[t]) != json.dumps(v5.get(t))) == ['beat', 'like'])

    like = {index['name']: index for index in v6['like']['indices']}
    check('all five v5 like indexes survive unchanged',
          all(index in like and like[index] == {i['name']: i for i in v5['like']['indices']}[index]
              for index in ['byPost', 'byHashtagPost', 'byAuthorPost', 'byAuthorTimePost', 'byLiker']))

    beat = {index['name']: index for index in v6['beat']['indices']}
    check('beat is indexOnly with hashtag REQUIRED (so the windowed hashtag index is legal)',
          v6['beat'].get('indexOnly') is True and 'hashtag' in v6['beat']['required'])
    check('beat.postId refersTo post with propertyAgreement on hashtag',
          v6['beat']['properties']['postId']['refersTo']['propertyAgreement'] == {'hashtag': 'hashtag'})
    check('like carries NO windowed hashtag index (optional hashtag cannot sit below the bucket)',
          not any('timeRange' in i and any('hashtag' in p for p in i['properties'])
                  for i in v6['like']['indices']))

    for name, at, index in [('byDayPost', True, like['byDayPost']),
                            ('byDayAuthorPost', {'at': ['postAuthor', 'postId']}, like['byDayAuthorPost']),
                            ('beat.byDayHashtagPost', {'at': ['hashtag', 'postId']}, beat['byDayHashtagPost'])]:
        check(name + ' buckets $createdAt on a daily NON-overlapping grid',
              index['timeRange'] == DAY)
        check(name + ' leads with the timeRange source',
              list(index['properties'][0]) == ['$createdAt'])
        check(name + ' keeps its all-time twin\'s ranked axis',
              index['rankedCountable'] == at)
        check(name + ' keeps the count axes a ranking requires',
              index['countable'] == 'countable' and index['rangeCountable'] is True)
        check(name + ' ranks over a terminal-bearing index',
              index['terminal'] == '$ownerId')
        check(name + ' drops skipIfAbsent (trigger must be the first property)',
              'skipIfAbsent' not in index)
        check(name + ' drops preallocated (bucket paths derive from the write timestamp)',
              'preallocated' not in index)

    rolling = beat['byRollingHashtagPost']
    check('byRollingHashtagPost declares an overlapping grid (factor 4)',
          rolling['timeRange']['range'] // rolling['timeRange']['step'] == 4)
    check('the overlap factor stays under the versioned cap of 24',
          rolling['timeRange']['range'] // rolling['timeRange']['step'] <= 24)

    check('like stays within the 10-index ceiling', len(v6['like']['indices']) <= 10)
    check('beat.byPostTime projects \$createdAt for the delete tuple (plain, postId-pinned, \$ownerId terminal)',
          beat['byPostTime']['properties'] == [{'postId': 'asc'}, {'$createdAt': 'asc'}] and beat['byPostTime']['terminal'] == '$ownerId' and 'timeRange' not in beat['byPostTime'])
    check('every windowed index names $createdAt as its source',
          all(i['timeRange']['on'] == '$createdAt'
              for t in ('like', 'beat') for i in v6[t]['indices'] if 'timeRange' in i))

    print()
    print('SELF-TEST PASSED' if not failures else f'{len(failures)} CHECK(S) FAILED')
    return 1 if failures else 0


if __name__ == '__main__':
    if '--self-test' in sys.argv:
        sys.exit(self_test())
    json.dump(build(), open(DST, 'w'), indent=2)
    open(DST, 'a').write('\n')
    print(f'wrote {DST}')
