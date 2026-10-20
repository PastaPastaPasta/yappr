import { fakeEngine, ticket } from '~/data/testing/fake-engine';
import { engine } from '~/engine';
import { syncStorage } from '~/state/storage';

import { draftKey, holdPublish, publishHeld, publishPostWrite, resolveHeldPublish } from './blog-writes';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);

const VIEWER = '4EfA9Jrvv3nnCFdSf7fad59851iiTRZ6Wcu6YVJ4iSeF';
const BLOG = 'B1YTHPCmXo6Yywxz2msLwxRZ5eWuUSMwfwiq258mzWyq';
const INPUT = { title: 'Field notes', content: [] };

/** A held publish whose ticket the engine has let go, sent with the title's address free or taken. */
async function heldAndSent(addressFree: boolean) {
  syncStorage.setItem(draftKey(VIEWER, BLOG), '{"title":"Field notes"}');
  holdPublish(VIEWER, BLOG, INPUT.title);
  fakeEngine.method('blogs.publishAddressFree').mockResolvedValue(addressFree);
  fakeEngine.method('blogs.publish').mockResolvedValue(ticket({ op: 'blogPost.publish' }));
  await publishPostWrite.submit(engine.api, { viewerId: VIEWER, blogId: BLOG, input: INPUT });
  fakeEngine.method('writes.list').mockResolvedValue([]);
}

beforeEach(() => {
  fakeEngine.reset();
  syncStorage.removeItem(`${draftKey(VIEWER, BLOG)}:sent`);
  syncStorage.removeItem(draftKey(VIEWER, BLOG));
});

describe('a held publish', () => {
  it('stays held, draft kept, when its address proves nothing', async () => {
    await heldAndSent(true);
    fakeEngine.method('blogs.publishOutcome').mockResolvedValue('unknown');
    expect(await resolveHeldPublish(VIEWER, BLOG)).toEqual({ state: 'held', ticketId: null });
    expect(publishHeld(VIEWER, BLOG)).toBe(true);
    expect(syncStorage.getItem(draftKey(VIEWER, BLOG))).not.toBeNull();
  });

  it("isn't traced by an address that was already taken when it was sent", async () => {
    await heldAndSent(false);
    expect(await resolveHeldPublish(VIEWER, BLOG)).toEqual({ state: 'held', ticketId: null });
    expect(fakeEngine.method('blogs.publishOutcome')).not.toHaveBeenCalled();
    expect(syncStorage.getItem(draftKey(VIEWER, BLOG))).not.toBeNull();
  });

  it('settles by a free address: published drops the draft', async () => {
    await heldAndSent(true);
    fakeEngine.method('blogs.publishOutcome').mockResolvedValue('published');
    expect(await resolveHeldPublish(VIEWER, BLOG)).toEqual({ state: 'published' });
    expect(publishHeld(VIEWER, BLOG)).toBe(false);
    expect(syncStorage.getItem(draftKey(VIEWER, BLOG))).toBeNull();
  });

  it('still sends when the address read fails, untraceable', async () => {
    syncStorage.setItem(draftKey(VIEWER, BLOG), '{"title":"Field notes"}');
    holdPublish(VIEWER, BLOG, INPUT.title);
    fakeEngine.method('blogs.publishAddressFree').mockRejectedValue(new Error('timeout'));
    fakeEngine.method('blogs.publish').mockResolvedValue(ticket({ op: 'blogPost.publish' }));
    await publishPostWrite.submit(engine.api, { viewerId: VIEWER, blogId: BLOG, input: INPUT });
    expect(fakeEngine.method('blogs.publish')).toHaveBeenCalledWith(BLOG, INPUT);
    fakeEngine.method('writes.list').mockResolvedValue([]);
    expect(await resolveHeldPublish(VIEWER, BLOG)).toEqual({ state: 'held', ticketId: null });
  });
});
