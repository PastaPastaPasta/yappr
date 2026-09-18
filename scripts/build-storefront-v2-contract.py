#!/usr/bin/env python3
"""Builds contracts/yappr-storefront-contract-v2.json from the v1 storefront contract.

Deterministic transform (running it twice yields byte-identical output) so the
diff against the deployed v1 shape is reviewable as code. See
docs/STOREFRONT_V2.md for the rationale and the query shapes each index serves.

What v2 adds, per document type:

  store        canBeDeleted:false (permanentDocument target; `closed` is the tombstone)
  storeItem    canBeDeleted:false (`deleted` status is the tombstone);
               storeId refersTo store
  storeOrder   canBeDeleted:false; buyerId (poster-attested, == $ownerId);
               storeId refersTo store; sellerId refersTo identity;
               countable buyer/seller/store order indexes; storeOrderCount
               ranked by count ("most ordered stores")
  orderStatusUpdate
               sellerId (propertyAgreement with the order) so only a document
               carrying the order's seller id is accepted; the app checks
               $ownerId == sellerId; buyerId copied the same way so buyers can
               query their own status feed
  storeReview  one per order (unique orderId); orderId refersTo storeOrder with
               propertyAgreement {storeId, sellerId, buyerId}; `rating` averaged
               and ranked per store and per seller; rating distribution countable;
               YAPP cost 3 (charged from the social contract's token)
  itemReview   NEW, one per (orderId, itemId); orderId/itemId refersTo with the
               same agreement chain plus {storeId} agreement against the item;
               `rating` averaged and ranked per item and per (store, item);
               YAPP cost 1
  shippingZone storeId refersTo store
  savedAddress unchanged

Run:
  python3 scripts/build-storefront-v2-contract.py              # (re)write the v2 JSON
  python3 scripts/build-storefront-v2-contract.py --self-test  # assert the committed JSON
"""
import copy
import json
import sys

SRC = 'contracts/yappr-storefront-contract.json'
DST = 'contracts/yappr-storefront-contract-v2.json'

# The social contract that defines YAPP (token position 0). Reviews on the
# storefront contract are priced in YAPP through tokenCost.contractId, so the
# id is a build-time input: pass the deployment's social contract id through
# the environment or edit here before registering.
SOCIAL_CONTRACT_ID_PLACEHOLDER = 'SOCIAL_CONTRACT_ID'
YAPP_TOKEN_POSITION = 0
REVIEW_COST = {'storeReview': 3, 'itemReview': 1}

# The "average tree" flags, spelled out the way upstream's restaurants fixture
# does: count + sum + average axes, each with its range variant.
AVERAGE_FLAGS = {
    'countable': 'countable',
    'summable': 'rating',
    'averageable': 'rating',
    'rangeCountable': True,
    'rangeSummable': True,
    'rangeAverageable': True,
}

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

    # ---- store --------------------------------------------------------------
    store = out['store']
    store['canBeDeleted'] = False
    store['description'] = (
        'A merchant store profile (one per user). Permanent so items, orders '
        'and reviews can reference it; `closed` is the tombstone.'
    )

    # ---- storeItem ----------------------------------------------------------
    item = out['storeItem']
    item['canBeDeleted'] = False
    item['properties']['storeId'] = identifier(0, 'ID of the store this item belongs to', permanent('store'))
    item['description'] = (
        'A product listing with optional embedded variants. Permanent so orders '
        'and item reviews can reference it; status `deleted` is the tombstone.'
    )

    # ---- shippingZone -------------------------------------------------------
    zone = out['shippingZone']
    zone['properties']['storeId'] = identifier(0, 'ID of the store this zone belongs to', permanent('store'))

    # ---- storeOrder ---------------------------------------------------------
    order = out['storeOrder']
    order.pop('mutable', None)
    order['documentsMutable'] = False
    order['canBeDeleted'] = False
    order['description'] = (
        'An encrypted order created by a buyer. Permanent so status updates '
        'and reviews can reference it. `buyerId` is poster-attested (must '
        'equal $ownerId; the app checks) and is the propertyAgreement source '
        'that pins reviews and status updates to this order.'
    )
    props = {
        'storeId': identifier(0, 'ID of the store', permanent('store')),
        'sellerId': identifier(1, 'Identity ID of the store owner (for seller queries)', {'type': 'identity'}),
        'buyerId': identifier(2, 'Buyer identity; must equal $ownerId (poster-attested)'),
        'encryptedPayload': order['properties']['encryptedPayload'],
        'nonce': order['properties']['nonce'],
    }
    renumber(props)
    order['properties'] = props
    order['required'] = ['$createdAt', 'storeId', 'sellerId', 'buyerId', 'encryptedPayload', 'nonce']
    order['indices'] = [
        {'name': 'buyerOrders', 'properties': [{'$ownerId': 'asc'}, {'$createdAt': 'asc'}]},
        {'name': 'sellerOrders', 'properties': [{'sellerId': 'asc'}, {'$createdAt': 'asc'}]},
        {'name': 'storeOrders', 'properties': [{'storeId': 'asc'}, {'$createdAt': 'asc'}]},
        # O(1) totals for the seller badge, buyer history and store card; the
        # storeOrderCount ranking serves "most ordered stores". Kept as
        # single-property siblings so the timeline indexes above stay plain
        # (a ranked index's prefix may not terminate an aggregating index).
        {'name': 'buyerOrderCount', 'properties': [{'$ownerId': 'asc'}], 'countable': 'countable'},
        {'name': 'sellerOrderCount', 'properties': [{'sellerId': 'asc'}], 'countable': 'countable'},
        {'name': 'storeOrderCount', 'properties': [{'storeId': 'asc'}],
         'countable': 'countable', 'rangeCountable': True, 'rankedCountable': True},
    ]

    # ---- orderStatusUpdate --------------------------------------------------
    status = out['orderStatusUpdate']
    status.pop('mutable', None)
    status['documentsMutable'] = False
    status['description'] = (
        'A status update for an order (append-only history). Only a document '
        'carrying the order\'s own sellerId/buyerId is accepted (propertyAgreement); '
        'the app treats an update whose $ownerId != sellerId as invalid.'
    )
    props = {
        'orderId': identifier(0, 'ID of the order being updated',
                              permanent('storeOrder', {'sellerId': 'sellerId', 'buyerId': 'buyerId'})),
        'sellerId': identifier(1, 'Seller identity; must equal the order\'s sellerId and this $ownerId'),
        'buyerId': identifier(2, 'Buyer identity; must equal the order\'s buyerId (for buyer status feeds)'),
        'status': status['properties']['status'],
        'trackingNumber': status['properties']['trackingNumber'],
        'trackingCarrier': status['properties']['trackingCarrier'],
        'message': status['properties']['message'],
    }
    renumber(props)
    status['properties'] = props
    status['required'] = ['$createdAt', 'orderId', 'sellerId', 'buyerId', 'status']
    status['indices'] = [
        {'name': 'orderAndTime', 'properties': [{'orderId': 'asc'}, {'$createdAt': 'asc'}]},
        {'name': 'sellerStatusUpdates', 'properties': [{'$ownerId': 'asc'}, {'$createdAt': 'asc'}]},
        {'name': 'buyerStatusUpdates', 'properties': [{'buyerId': 'asc'}, {'$createdAt': 'asc'}]},
    ]

    # ---- storeReview --------------------------------------------------------
    review = out['storeReview']
    review.pop('mutable', None)
    review['documentsMutable'] = False
    review['description'] = (
        'A review of a store from a buyer, one per order. orderId must name a '
        'real order whose storeId/sellerId/buyerId agree with this document; '
        'the app shows "verified purchase" when $ownerId == buyerId.'
    )
    props = {
        'storeId': identifier(0, 'ID of the store being reviewed', permanent('store')),
        'orderId': identifier(1, 'ID of the completed order (proves purchase)',
                              permanent('storeOrder', {'storeId': 'storeId', 'sellerId': 'sellerId', 'buyerId': 'buyerId'})),
        'sellerId': identifier(2, 'Identity ID of the store owner (for seller queries)'),
        'buyerId': identifier(3, 'Buyer identity copied from the order; the app requires it to equal $ownerId'),
        'rating': review['properties']['rating'],
        'title': review['properties']['title'],
        'content': review['properties']['content'],
    }
    renumber(props)
    review['properties'] = props
    review['required'] = ['$createdAt', 'storeId', 'orderId', 'sellerId', 'buyerId', 'rating']
    review['indices'] = [
        {'name': 'storeReviews', 'properties': [{'storeId': 'asc'}, {'$createdAt': 'asc'}]},
        {'name': 'sellerReviews', 'properties': [{'sellerId': 'asc'}, {'$createdAt': 'asc'}]},
        {'name': 'buyerReviews', 'properties': [{'$ownerId': 'asc'}, {'$createdAt': 'asc'}]},
        {'name': 'orderReview', 'unique': True, 'properties': [{'orderId': 'asc'}]},
        # The "average tree": count + sum of `rating` per store, with ranked
        # secondaries so "top rated" and "most reviewed" are one query each.
        # Spelled out in full (the meta-schema's `averageable` sugar is not
        # expanded before the rankedCountable/rangeCountable dependency check,
        # so consensus wants every underlying flag present — same spelling as
        # upstream's restaurants fixture).
        {'name': 'storeRating', 'properties': [{'storeId': 'asc'}],
         **AVERAGE_FLAGS, 'rankedAverageable': True, 'rankedCountable': True},
        {'name': 'sellerRating', 'properties': [{'sellerId': 'asc'}],
         **AVERAGE_FLAGS, 'rankedAverageable': True},
        # 1..5 distribution: `count where storeId == S and rating in [1..5] groupBy rating`.
        {'name': 'storeRatingDistribution', 'properties': [{'storeId': 'asc'}, {'rating': 'asc'}],
         'countable': 'countable'},
    ]
    review['tokenCost'] = {'create': {
        'contractId': SOCIAL_CONTRACT_ID_PLACEHOLDER,
        'tokenPosition': YAPP_TOKEN_POSITION,
        'amount': REVIEW_COST['storeReview'],
    }}

    # ---- itemReview (new) ---------------------------------------------------
    props = {
        'storeId': identifier(0, 'ID of the store the item belongs to', permanent('store')),
        'itemId': identifier(1, 'ID of the item being reviewed; must belong to storeId',
                             permanent('storeItem', {'storeId': 'storeId'})),
        'orderId': identifier(2, 'ID of the order the item was bought in',
                              permanent('storeOrder', {'storeId': 'storeId', 'buyerId': 'buyerId'})),
        'buyerId': identifier(3, 'Buyer identity copied from the order; the app requires it to equal $ownerId'),
        'rating': {'type': 'integer', 'minimum': 1, 'maximum': 5, 'position': 4, 'description': 'Star rating (1-5)'},
        'content': {'type': 'string', 'maxLength': 1000, 'position': 5, 'description': 'Review content'},
    }
    renumber(props)
    out['itemReview'] = {
        'type': 'object',
        'documentsMutable': False,
        'description': (
            'A review of one item from an order, one per (order, item). The item '
            'must belong to the same store as the order; the buyer is pinned by '
            'propertyAgreement against the order. Reviewing an item publishes '
            'that this order contained it.'
        ),
        'indices': [
            {'name': 'itemReviews', 'properties': [{'itemId': 'asc'}, {'$createdAt': 'asc'}]},
            {'name': 'buyerItemReviews', 'properties': [{'$ownerId': 'asc'}, {'$createdAt': 'asc'}]},
            {'name': 'orderItemReview', 'unique': True, 'properties': [{'orderId': 'asc'}, {'itemId': 'asc'}]},
            # Global item ranking (top rated / most reviewed items anywhere).
            {'name': 'itemRating', 'properties': [{'itemId': 'asc'}],
             **AVERAGE_FLAGS, 'rankedAverageable': True, 'rankedCountable': True},
            # Per-store item ranking: pin storeId, group by itemId.
            {'name': 'storeItemRating', 'properties': [{'storeId': 'asc'}, {'itemId': 'asc'}],
             **AVERAGE_FLAGS, 'rankedAverageable': True},
        ],
        'properties': props,
        'required': ['$createdAt', 'storeId', 'itemId', 'orderId', 'buyerId', 'rating'],
        'additionalProperties': False,
        'tokenCost': {'create': {
            'contractId': SOCIAL_CONTRACT_ID_PLACEHOLDER,
            'tokenPosition': YAPP_TOKEN_POSITION,
            'amount': REVIEW_COST['itemReview'],
        }},
    }

    # Stable doctype order for reviewable diffs.
    order_of = ['store', 'storeItem', 'shippingZone', 'storeOrder', 'orderStatusUpdate',
                'storeReview', 'itemReview', 'savedAddress']
    return {name: out[name] for name in order_of}


def main(argv):
    with open(SRC) as f:
        src = json.load(f)
    built = build(src)
    text = json.dumps(built, indent=2) + '\n'
    if '--self-test' in argv:
        with open(DST) as f:
            current = f.read()
        if current != text:
            print(f'{DST} is stale — run scripts/build-storefront-v2-contract.py', file=sys.stderr)
            return 1
        print(f'{DST} matches the transform')
        return 0
    with open(DST, 'w') as f:
        f.write(text)
    print(f'wrote {DST} ({len(built)} document types)')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
