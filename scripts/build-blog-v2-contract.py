#!/usr/bin/env python3
"""Builds contracts/yappr-blog-contract-v2.json from the v1 blog contract.

Deterministic transform (running it twice yields byte-identical output) so the
diff against the deployed v1 shape is reviewable as code. See docs/BLOG_V2.md
for the rationale and the query shapes each index serves.

What v2 adds, per document type:

  blog        unchanged (already permanent + keepHistory)
  blogPost    required poster-attested `author` (must equal $ownerId; the app
              checks) — the propertyAgreement source that pins a comment's
              blogPostOwnerId to the real post author; blogId refersTo blog
  blogComment blogPostId refersTo blogPost with propertyAgreement
              {blogPostOwnerId: 'author'}, closing the forged-owner-id
              notification hole; countable/ranked `commentCount [blogPostId]`
              ("most discussed posts"); `postOwnerAndTime` for the
              "comments on my posts" notification source; YAPP cost 1
  blogFollow  blogId refersTo blog; countable/ranked `followerCount [blogId]`
              ("most followed blogs"); `followersByDay [$createdAt, blogId]`
              on the daily grid ("trending blogs today")

Run:
  python3 scripts/build-blog-v2-contract.py              # (re)write the v2 JSON
  python3 scripts/build-blog-v2-contract.py --self-test  # assert the committed JSON
"""
import copy
import json
import sys

SRC = 'contracts/yappr-blog-contract.json'
DST = 'contracts/yappr-blog-contract-v2.json'

# The social contract that defines YAPP (token position 0). Blog comments are
# priced in YAPP through tokenCost.contractId, so the id is a registration-time
# input: scripts/register-feature-contract.mjs replaces this placeholder with
# the deployment's social contract id as a 32-byte array (the form registration
# requires; base58 is refused on chain).
SOCIAL_CONTRACT_ID_PLACEHOLDER = 'SOCIAL_CONTRACT_ID'
YAPP_TOKEN_POSITION = 0
COMMENT_COST = 1

# The full ranked-count chain, spelled out. `rankedCountable` alone is refused
# at registration ("rangeCountable" / "countable" is a required property): the
# meta-schema's dependency rules run on the literal keys, and the offline wasm
# validator compiles that check out — so it passes locally and fails on chain
# (dashpay/platform#4809).
COUNT_FLAGS = {
    'countable': 'countable',
    'rangeCountable': True,
    'rankedCountable': True,
}

# Daily UTC buckets with a seven-day drain, the same grid the social contract's
# windowed like/beat indexes use (lib/contract-topology.ts WINDOWED_DAY_GRID).
DAY_GRID = {'on': '$createdAt', 'range': 86400, 'step': 86400, 'ttl': 604800}

IDENTIFIER = {
    'type': 'array',
    'byteArray': True,
    'minItems': 32,
    'maxItems': 32,
    'contentMediaType': 'application/x.dash.dpp.identifier',
}


def identifier(position, description, refers_to=None):
    prop = dict(IDENTIFIER)
    prop['position'] = position
    prop['description'] = description
    if refers_to is not None:
        prop['refersTo'] = refers_to
    return prop


def permanent(document_type, agreement=None):
    ref = {'type': 'permanentDocument', 'documentType': document_type}
    if agreement:
        ref['propertyAgreement'] = agreement
    return ref


def renumber(properties):
    """Rewrites `position` to the insertion order of `properties`."""
    for position, prop in enumerate(properties.values()):
        prop['position'] = position


def build(src):
    out = copy.deepcopy(src)

    # ---- blog ---------------------------------------------------------------
    # Already permanent (canBeDeleted:false) and history-keeping in v1, which is
    # exactly what posts and follows need to point at it.
    out['blog']['description'] = (
        'A blog (many per user). Permanent so posts and follows can reference '
        'it; there is no tombstone flag — an abandoned blog is simply empty.'
    )

    # ---- blogPost -----------------------------------------------------------
    post = out['blogPost']
    post['description'] = (
        'A published post. Permanent and history-keeping, so every edit is '
        'retrievable through documents.history. `author` is poster-attested '
        '(must equal $ownerId; the app checks) and is the propertyAgreement '
        'source that pins each comment\'s blogPostOwnerId to the real author.'
    )
    props = {
        'blogId': identifier(0, 'Reference to parent blog document', permanent('blog')),
        'author': identifier(1, 'Post author; must equal $ownerId (poster-attested). Source of the comment propertyAgreement.'),
        'title': post['properties']['title'],
        'subtitle': post['properties']['subtitle'],
        'data0': post['properties']['data0'],
        'data1': post['properties']['data1'],
        'data2': post['properties']['data2'],
        'data3': post['properties']['data3'],
        'coverImage': post['properties']['coverImage'],
        'labels': post['properties']['labels'],
        'commentsEnabled': post['properties']['commentsEnabled'],
        'slug': post['properties']['slug'],
        'publishedAt': post['properties']['publishedAt'],
    }
    renumber(props)
    post['properties'] = props
    post['required'] = ['$createdAt', 'blogId', 'author', 'title', 'data0', 'slug']
    # No `authorAndTime [author, $createdAt]`: `author` is required to equal
    # $ownerId, so the v1 `ownerAndTime` index already serves every
    # "posts by this author" query at the same cost. A second index would only
    # add write cost for a query nothing makes.

    # ---- blogComment --------------------------------------------------------
    comment = out['blogComment']
    comment['description'] = (
        'A comment on a post. blogPostId must name a real post whose `author` '
        'equals this document\'s blogPostOwnerId, so the notification key '
        'cannot be forged and comments on ghost posts are impossible.'
    )
    props = {
        'blogPostId': identifier(
            0, 'Reference to parent blog post document',
            permanent('blogPost', {'blogPostOwnerId': 'author'})),
        'blogPostOwnerId': identifier(1, "Author of the parent post, copied from its `author` (consensus-checked)"),
        'content': comment['properties']['content'],
    }
    renumber(props)
    comment['properties'] = props
    comment['indices'] = [
        {'name': 'postAndTime', 'properties': [{'blogPostId': 'asc'}, {'$createdAt': 'asc'}]},
        {'name': 'ownerAndTime', 'properties': [{'$ownerId': 'asc'}, {'$createdAt': 'asc'}]},
        # "Comments on my posts" — the notification source that replaces the
        # client-side scan; also the badge count since a timestamp.
        {'name': 'postOwnerAndTime', 'properties': [{'blogPostOwnerId': 'asc'}, {'$createdAt': 'asc'}]},
        # O(1) comment totals per post and the "most discussed posts" ranking.
        # Single-property sibling of the plain `postAndTime` timeline: a ranked
        # index's prefix may not terminate an aggregating index, and a
        # single-property ranked index beside a plain [same, $createdAt] one is
        # the shape already live in storefront v2 (storeOrderCount/storeOrders).
        {'name': 'commentCount', 'properties': [{'blogPostId': 'asc'}], **COUNT_FLAGS},
    ]
    comment['tokenCost'] = {'create': {
        'contractId': SOCIAL_CONTRACT_ID_PLACEHOLDER,
        'tokenPosition': YAPP_TOKEN_POSITION,
        'amount': COMMENT_COST,
    }}

    # ---- blogFollow ---------------------------------------------------------
    follow = out['blogFollow']
    follow['description'] = (
        'A follow of a blog, one per (follower, blog). Counted and ranked so '
        'discovery reads "most followed" and "trending today" instead of '
        'crawling every blog\'s followers.'
    )
    follow['properties'] = {
        'blogId': identifier(0, 'Reference to the blog being followed', permanent('blog')),
    }
    follow['indices'] = [
        {'name': 'ownerAndBlog', 'unique': True, 'properties': [{'$ownerId': 'asc'}, {'blogId': 'asc'}]},
        {'name': 'following', 'properties': [{'$ownerId': 'asc'}, {'$createdAt': 'asc'}]},
        {'name': 'followers', 'properties': [{'blogId': 'asc'}, {'$createdAt': 'asc'}]},
        # O(1) follower totals and "most followed blogs".
        {'name': 'followerCount', 'properties': [{'blogId': 'asc'}], **COUNT_FLAGS},
        # "Trending blogs today": the same ranked chain under a daily bucket of
        # $createdAt. Legal because $createdAt is required here; the seven-day
        # ttl drains old buckets' index entries (the follow documents stay).
        {'name': 'followersByDay', 'properties': [{'$createdAt': 'asc'}, {'blogId': 'asc'}],
         **COUNT_FLAGS, 'timeRange': dict(DAY_GRID)},
    ]

    # Stable doctype order for reviewable diffs.
    order_of = ['blog', 'blogPost', 'blogComment', 'blogFollow']
    built = {name: out[name] for name in order_of}

    # Self-guard: the transforms above REPLACE whole `properties` maps, so a
    # property added to v1 later would be silently dropped. v2 may add
    # properties; it may never lose one.
    for name, schema in built.items():
        dropped = set(src[name]['properties']) - set(schema['properties'])
        if dropped:
            raise AssertionError(f'{name}: v1 properties dropped by the transform: {sorted(dropped)}')
        missing = set(src[name].get('required', [])) - set(schema.get('required', []))
        if missing:
            raise AssertionError(f'{name}: v1 required fields dropped by the transform: {sorted(missing)}')
    return built


def main(argv):
    with open(SRC) as f:
        src = json.load(f)
    built = build(src)
    text = json.dumps(built, indent=2) + '\n'
    if '--self-test' in argv:
        with open(DST) as f:
            current = f.read()
        if current != text:
            print(f'{DST} is stale — run scripts/build-blog-v2-contract.py', file=sys.stderr)
            return 1
        print(f'{DST} matches the transform')
        return 0
    with open(DST, 'w') as f:
        f.write(text)
    print(f'wrote {DST} ({len(built)} document types)')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
