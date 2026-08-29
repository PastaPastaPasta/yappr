#!/usr/bin/env python3
"""Builds contracts/yappr-social-contract-v4.json from the v3-topology contract.

v4 = v3 topology + the like-overhaul design (PLAN_LIKE_OVERHAUL.md §7-2b):
indexOnly like/likeReply, single-hashtag on post (postHashtag doctype deleted),
author properties as propertyAgreement targets. Deterministic transform so the
diff against v3 is reviewable as code.
"""
import json

SRC = 'contracts/yappr-social-contract-v3-topology.json'
DST = 'contracts/yappr-social-contract-v4.json'

IDENTIFIER = {
    'type': 'array', 'byteArray': True, 'minItems': 32, 'maxItems': 32,
    'contentMediaType': 'application/x.dash.dpp.identifier',
}
# '' = untagged. STAND-IN for the upstream null-skip semantics: once that ships,
# hashtag becomes optional (dropped from `required`) and untagged likes skip the
# byHashtagPost index entirely; re-register before the final cutover.
HASHTAG = {
    'type': 'string', 'pattern': '^$|^[a-z0-9_]{1,63}$', 'minLength': 0,
    'maxLength': 63, 'description': "Lowercase hashtag without # prefix; '' = untagged",
}
RANKED_CHAIN = {'countable': 'countable', 'rangeCountable': True, 'rankedCountable': True}

c = json.load(open(SRC))
d = c['documentSchemas']

# ---- post: author + hashtag properties, tag listing index ----
post = d['post']
post['properties']['author'] = dict(IDENTIFIER, position=14,
    description='Author identity; must equal $ownerId (poster-attested; propertyAgreement source for likes)')
post['properties']['hashtag'] = dict(HASHTAG, position=15)
post['required'] += ['author', 'hashtag']
post_idx = post.setdefault('indices', [])
post_idx.append({'name': 'tagAndTime', 'properties': [{'hashtag': 'asc'}, {'$createdAt': 'asc'}]})

# ---- reply: author property ----
reply = d['reply']
reply['properties']['author'] = dict(IDENTIFIER, position=10,
    description='Author identity; must equal $ownerId (poster-attested; propertyAgreement source for reply likes)')
reply['required'].append('author')

# ---- like: indexOnly redesign ----
d['like'] = {
    'type': 'object',
    'indexOnly': True,
    'documentsMutable': False,
    'canBeDeleted': True,
    'indices': [
        {'name': 'byPost', 'properties': [{'postId': 'asc'}],
         'terminal': '$ownerId', 'preallocated': True, **RANKED_CHAIN},
        {'name': 'byHashtagPost', 'properties': [{'hashtag': 'asc'}, {'postId': 'asc'}],
         'terminal': '$ownerId', 'preallocated': True, **RANKED_CHAIN},
        {'name': 'byAuthorPost', 'properties': [{'postAuthor': 'asc'}, {'postId': 'asc'}],
         'terminal': '$ownerId', 'preallocated': True, **RANKED_CHAIN},
        # $createdAt is the like's own timestamp — not derivable from the post,
        # so this index cannot be preallocated.
        {'name': 'byAuthorTimePost',
         'properties': [{'postAuthor': 'asc'}, {'$createdAt': 'asc'}, {'postId': 'asc'}],
         'terminal': '$ownerId'},
        {'name': 'byLiker', 'properties': [{'$ownerId': 'asc'}], 'terminal': 'postId'},
    ],
    'required': ['$createdAt', 'postId', 'hashtag', 'postAuthor'],
    'properties': {
        'postId': dict(IDENTIFIER, position=0, description='ID of the liked post',
            refersTo={'type': 'permanentDocument', 'documentType': 'post',
                      'propertyAgreement': {'hashtag': 'hashtag', 'postAuthor': 'author'}}),
        'hashtag': dict(HASHTAG, position=1),
        'postAuthor': dict(IDENTIFIER, position=2,
            description="The liked post's author (consensus-bound to post.author)"),
    },
    'tokenCost': {'create': {'tokenPosition': 0, 'amount': 1}},
    'description': 'A like on a post (indexOnly: the index entries are the rows)',
    'additionalProperties': False,
}

# ---- likeReply: indexOnly, lean (no ranked) ----
d['likeReply'] = {
    'type': 'object',
    'indexOnly': True,
    'documentsMutable': False,
    'canBeDeleted': True,
    'indices': [
        {'name': 'byReply', 'properties': [{'replyId': 'asc'}],
         'terminal': '$ownerId', 'preallocated': True, 'countable': 'countable'},
        {'name': 'byAuthorTimeReply',
         'properties': [{'replyAuthor': 'asc'}, {'$createdAt': 'asc'}, {'replyId': 'asc'}],
         'terminal': '$ownerId'},
        {'name': 'byLiker', 'properties': [{'$ownerId': 'asc'}], 'terminal': 'replyId'},
    ],
    'required': ['$createdAt', 'replyId', 'replyAuthor'],
    'properties': {
        'replyId': dict(IDENTIFIER, position=0, description='ID of the liked reply',
            refersTo={'type': 'permanentDocument', 'documentType': 'reply',
                      'propertyAgreement': {'replyAuthor': 'author'}}),
        'replyAuthor': dict(IDENTIFIER, position=1,
            description="The liked reply's author (consensus-bound to reply.author)"),
    },
    'tokenCost': {'create': {'tokenPosition': 0, 'amount': 1}},
    'description': 'A like on a reply (indexOnly: the index entries are the rows)',
    'additionalProperties': False,
}

# ---- single-hashtag model: the postHashtag doctype dies ----
del d['postHashtag']

c['version'] = 1
json.dump(c, open(DST, 'w'), indent=2)
print(f'wrote {DST}: {len(d)} doctypes:', ', '.join(sorted(d)))
