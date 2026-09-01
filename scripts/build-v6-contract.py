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

    # Trending hashtags today + top posts per tag today: pin the newest bucket
    # and rank at hashtag; pin bucket + hashtag and rank at postId. Twin of the
    # all-time byHashtagPost, which is what /explore and the tag pages use now.
    like['indices'].append(windowed(by_name['byHashtagPost'], 'byDayHashtagPost', DAY))

    # Top creators today + top posts by one author today, and — with an `In`
    # pin set over postAuthor — "most liked recent posts by people I follow".
    # Twin of the all-time byAuthorPost.
    like['indices'].append(windowed(by_name['byAuthorPost'], 'byDayAuthorPost', DAY))

    # Overlapping-grid probe, test material rather than a shape we would ship.
    like['indices'].append(windowed(by_name['byHashtagPost'], 'byRollingHashtagPost', ROLLING))

    assert len(like['indices']) <= 10, 'document meta-schema caps indices at 10 per doctype'
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

    check('only `like` differs from v5',
          [t for t in v6 if json.dumps(v6[t]) != json.dumps(v5.get(t))] == ['like'])

    like = {index['name']: index for index in v6['like']['indices']}
    check('all five v5 like indexes survive unchanged',
          all(index in like and like[index] == {i['name']: i for i in v5['like']['indices']}[index]
              for index in ['byPost', 'byHashtagPost', 'byAuthorPost', 'byAuthorTimePost', 'byLiker']))

    for name, at in [('byDayPost', True),
                     ('byDayHashtagPost', {'at': ['hashtag', 'postId']}),
                     ('byDayAuthorPost', {'at': ['postAuthor', 'postId']})]:
        index = like[name]
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

    rolling = like['byRollingHashtagPost']
    check('byRollingHashtagPost declares an overlapping grid (factor 4)',
          rolling['timeRange']['range'] // rolling['timeRange']['step'] == 4)
    check('the overlap factor stays under the versioned cap of 24',
          rolling['timeRange']['range'] // rolling['timeRange']['step'] <= 24)

    check('like stays within the 10-index ceiling', len(v6['like']['indices']) <= 10)
    check('every windowed index names $createdAt as its source',
          all(i['timeRange']['on'] == '$createdAt'
              for i in v6['like']['indices'] if 'timeRange' in i))

    print()
    print('SELF-TEST PASSED' if not failures else f'{len(failures)} CHECK(S) FAILED')
    return 1 if failures else 0


if __name__ == '__main__':
    if '--self-test' in sys.argv:
        sys.exit(self_test())
    json.dump(build(), open(DST, 'w'), indent=2)
    open(DST, 'a').write('\n')
    print(f'wrote {DST}')
