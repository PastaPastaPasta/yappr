import { methodKind, methodTimeoutMs } from './methods';

describe('engine method kinds', () => {
  it.each([
    'safety.blocked',
    'safety.isBlocked',
    'safety.blockedBy',
    'safety.ownReport',
    'engage.bookmarks',
    'writes.check',
    'dm.status',
    'dm.conversations',
    'dm.search',
    'dm.messages',
    'dm.createdGroup',
    'dm.refresh',
    'safety.followedBlockLists',
    'safety.reportsOpen',
    'feed.home',
    'posts.get',
  ])('%s is a read: replayed once after a restart, with the 30 s read deadline (SR-15)', (path) => {
    expect(methodKind(path)).toBe('read');
    expect(methodTimeoutMs(path)).toBe(30_000);
  });

  it.each(['safety.block', 'dm.setBlocked', 'safety.report', 'safety.withdrawReport', 'engage.like', 'writes.retry', 'dm.send', 'dm.open', 'dm.markRead', 'posts.publish'])(
    '%s is a write: never replayed, 15 s deadline',
    (path) => {
      expect(methodKind(path)).toBe('write');
      expect(methodTimeoutMs(path)).toBe(15_000);
    },
  );

  it.each(['store.discover', 'store.item', 'store.checkout', 'store.myOrders', 'store.sellerOrders', 'store.order', 'store.deliveryPlan', 'store.kit', 'cart.get'])(
    '%s is a storefront read',
    (path) => {
      expect(methodKind(path)).toBe('read');
    },
  );

  it.each(['store.placeOrder', 'store.saveStore', 'store.saveItem', 'store.saveZone', 'store.updateOrderStatus', 'store.review', 'store.report', 'cart.add', 'cart.setQuantity', 'cart.remove'])(
    '%s is a storefront write: never replayed (an order or a cart line twice)',
    (path) => {
      expect(methodKind(path)).toBe('write');
      expect(methodTimeoutMs(path)).toBe(15_000);
    },
  );

  it('gives digital delivery and kit saves the time they take', () => {
    expect(methodKind('store.deliver')).toBe('write');
    expect(methodTimeoutMs('store.deliver')).toBe(180_000);
    expect(methodTimeoutMs('store.deliverReady')).toBe(600_000);
    expect(methodTimeoutMs('store.saveKit')).toBe(120_000);
  });

  it('treats an unknown path as a write, and keeps the session and control kinds', () => {
    expect(methodKind('posts.somethingNew')).toBe('write');
    expect(methodKind('session.signInWithKey')).toBe('session');
    expect(methodTimeoutMs('session.awaitKeyExchange')).toBe(130_000);
    expect(methodKind('engine.lifecycle')).toBe('control');
  });
});
