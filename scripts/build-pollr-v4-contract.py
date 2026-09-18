#!/usr/bin/env python3
"""Builds contracts/pollr-contract-v4.json from the v3 Pollr contract.

Deterministic transform (running it twice yields byte-identical output) so the
diff against the deployed v3 shape is reviewable as code. See docs/POLLR_V4.md
for the rationale, the live query shapes, and the indexOnly rules that shaped
the index set.

What v4 changes, per document type:

  poll       canBeDeleted:false (it becomes a permanentDocument target).
             Nothing else: every ballot's `pollOwnerId` is pinned to the poll's
             own `$ownerId` by a system-field propertyAgreement, so the poll
             carries no attested `author` copy and the "a poll may name an
             author who is not its creator" gap does not exist. Still immutable
             and documentsCountable.

  vote       indexOnly. Ballots are index entries, not stored rows: flat-priced,
             body-less, and single-choice is STRUCTURAL — `byPoll [pollId]`
             terminal `$ownerId` admits one entry per (poll, voter), so the v3
             `unique` index is gone (indexOnly types cannot declare `unique`).
             `byPollChoice [pollId, choice]` carries the count tree and the
             ranked secondary, so the winner is one O(log n) query.

  multiVote  indexOnly the same way, except that its ONLY per-poll index carries
             `choice`, so the structural rule admits one entry per
             (poll, choice, voter) — exactly multi-choice's rule. No index may
             terminate at `[pollId]` here: that would re-impose one-ballot-per-
             voter and reject the second selection.

Index-set rules this had to satisfy (rs-dpp `apply_index_only`, 4.2.0-beta.1):

  * every property `required` and covered by a non-skip index; every index
    embeds `$ownerId` as a property or as its terminal;
  * a terminal is `$ownerId` or an identifier property carrying a `refersTo`
    declaration — `choice` is an integer, so it can never be one. That is why
    "my votes" is `[$ownerId, choice]` terminal `pollId` rather than the
    obvious `[$ownerId, pollId]` terminal `choice`;
  * at least one index free of `$createdAt` and of `skipIfAbsent` (the proof
    index). v4 keeps NO time index at all, so `$createdAt` stays out of
    `required` and the delete-by-values tuple is just the three properties —
    no block-timestamp recovery hop, unlike the social contract's likes;
  * `preallocated` only where every index property is the refersTo property
    itself or one of its `propertyAgreement` keys. `choice` is neither, so
    `byPollChoice` cannot be preallocated and `multiVote` gets no preallocated
    index at all; `vote.byPoll` and `vote.byPollOwner` can be, and their trees
    are created (and paid for) by the poll creator;
  * a compound ranked index's leading prefix must not also terminate a
    countable/summable index. `byPollChoice` is ranked with prefix `[pollId]`
    and `vote.byPoll` terminates exactly there — legal only because `byPoll` is
    PLAIN. Moving any aggregate flag onto `byPoll` breaks registration;
  * `rankedCountable` needs `rangeCountable` spelled out
    (dashpay/platform#4809: the sugar is not expanded before the dependency
    check, so the offline validator accepts what consensus refuses).
    `countable` is no longer spelled out: 4.2.0-beta.2 makes `rangeCountable:
    true` imply it, in the meta-schema and in the structural parser alike.

Run:
  python3 scripts/build-pollr-v4-contract.py              # (re)write the v4 JSON
  python3 scripts/build-pollr-v4-contract.py --self-test  # assert the committed JSON
"""
import copy
import json
import sys

SRC = 'contracts/pollr-contract-v3.json'
DST = 'contracts/pollr-contract-v4.json'

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


def poll_reference():
    """`pollId`'s refersTo: the poll must exist, and its OWNER pins pollOwnerId.

    The referenced side is the system field `$ownerId` (4.2.0-beta.2), so the
    binding is to the identity that actually signed the poll — there is no
    attested copy to disagree with it and nothing for the client to check.
    """
    return {
        'type': 'permanentDocument',
        'documentType': 'poll',
        'propertyAgreement': {'pollOwnerId': '$ownerId'},
    }


def index(name, properties, terminal, **flags):
    out = {'name': name, 'properties': [{prop: 'asc'} for prop in properties], 'terminal': terminal}
    out.update(flags)
    return out


# The count tree plus its ranked secondary. The `rankedCountable` dependency
# check runs on the literal keys (#4809), so `rangeCountable` stays spelled out;
# `countable` is implied by it since 4.2.0-beta.2.
COUNT_AND_RANK = {'rangeCountable': True, 'rankedCountable': True}


def ballot_properties(choice_description):
    return {
        'pollId': identifier(0, "ID of the poll being voted on (must exist; its $ownerId pins pollOwnerId)", poll_reference()),
        'pollOwnerId': identifier(1, "The poll creator's identity, consensus-bound to the poll's $ownerId"),
        'choice': {
            'type': 'integer',
            'minimum': 0,
            'maximum': 9,
            'position': 2,
            'description': choice_description,
        },
    }


def build(src):
    out = copy.deepcopy(src)

    # ---- poll ---------------------------------------------------------------
    poll = out['poll']
    poll['canBeDeleted'] = False
    poll['description'] = (
        'A poll: question plus 2-10 choices as enumerated option fields. Permanent '
        '(canBeDeleted:false) so ballots can reference it, and immutable, so the '
        'multiChoice flag that selects the ballot doctype cannot be flipped after '
        'ballots land. Every ballot\'s pollOwnerId is bound by consensus to this '
        "poll's $ownerId, so the creator needs no attested copy. Creating one "
        'preallocates the vote trees its ballots need'
    )

    # ---- vote (single choice) -----------------------------------------------
    # Neither ballot doctype declares a `tokenCost`: a poll is worthless if
    # voting costs a token, and the structural one-entry-per-voter rule already
    # caps the spam a ballot can do.
    out['vote'] = {
        'type': 'object',
        'indexOnly': True,
        'documentsMutable': False,
        'canBeDeleted': True,
        'indices': [
            # Structural single-choice: one entry per (poll, voter). PLAIN on
            # purpose — byPollChoice ranks with this as its prefix, and an
            # aggregating index terminating at a ranked prefix is refused.
            # Preallocatable: [pollId] is exactly the referring property.
            index('byPoll', ['pollId'], '$ownerId', preallocated=True),
            # Per-option tallies (count tree) and the winner (ranked secondary,
            # groupBy choice with pollId pinned).
            index('byPollChoice', ['pollId', 'choice'], '$ownerId', **COUNT_AND_RANK),
            # "Votes on my polls". pollOwnerId is an agreement key (bound to the
            # poll's $ownerId, which a reference does determine) and pollId the
            # referring property, so the poll's creation preallocates these trees.
            index('byPollOwner', ['pollOwnerId', 'pollId'], '$ownerId', preallocated=True),
            # "My votes", carrying the choice. The terminal must be $ownerId or a
            # refersTo identifier, so it is pollId; `choice` sits above it.
            index('byVoterChoice', ['$ownerId', 'choice'], 'pollId'),
        ],
        'required': ['pollId', 'pollOwnerId', 'choice'],
        'properties': ballot_properties('Index of the selected option (0-9)'),
        'description': (
            "A single-choice poll's ballot, indexOnly: the index entries ARE the "
            'ballot, so there is no stored body and nothing to fetch by id. '
            'byPoll admits one entry per (poll, voter), so Platform itself rejects '
            'a second selection — single-choice is structural, not a client '
            'convention (indexOnly types cannot declare `unique`; this is the same '
            'one-per-owner shape, used on purpose). Read only for polls whose '
            'multiChoice is false/absent; byPollChoice gives O(1) per-option '
            'tallies whose sum is the voter count'
        ),
        'additionalProperties': False,
    }

    # ---- multiVote (multiple choice) ----------------------------------------
    out['multiVote'] = {
        'type': 'object',
        'indexOnly': True,
        'documentsMutable': False,
        'canBeDeleted': True,
        'indices': [
            # The only per-poll index, and it carries `choice`: one entry per
            # (poll, choice, voter). A [pollId]-terminating sibling would make
            # the second selection a duplicate, so multiVote has none — and
            # therefore no preallocated index either (every index holds `choice`,
            # which no reference can determine).
            index('byPollChoice', ['pollId', 'choice'], '$ownerId', **COUNT_AND_RANK),
            index('byPollOwnerChoice', ['pollOwnerId', 'pollId', 'choice'], '$ownerId'),
            index('byVoterChoice', ['$ownerId', 'choice'], 'pollId'),
        ],
        'required': ['pollId', 'pollOwnerId', 'choice'],
        'properties': ballot_properties(
            'Index of one selected option (0-9). A multi-choice ballot writes one document per selection'
        ),
        'description': (
            "A multi-choice poll's ballot, indexOnly: one entry per selection, "
            'structurally unique per (poll, voter, choice) so repeating a choice '
            'is rejected while a different one is accepted. Read only for polls '
            'whose multiChoice is true; byPollChoice tallies selections, not '
            'voters (no index counts distinct voters — one that did would cap a '
            'voter at a single selection)'
        ),
        'additionalProperties': False,
    }

    # Stable doctype order for reviewable diffs.
    return {name: out[name] for name in ('poll', 'vote', 'multiVote')}


def main(argv):
    with open(SRC) as f:
        src = json.load(f)
    built = {'documentSchemas': build(src['documentSchemas'])}
    text = json.dumps(built, indent=2) + '\n'
    if '--self-test' in argv:
        with open(DST) as f:
            current = f.read()
        if current != text:
            print(f'{DST} is stale — run scripts/build-pollr-v4-contract.py', file=sys.stderr)
            return 1
        print(f'{DST} matches the transform')
        return 0
    with open(DST, 'w') as f:
        f.write(text)
    print(f'wrote {DST} ({len(built["documentSchemas"])} document types)')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
