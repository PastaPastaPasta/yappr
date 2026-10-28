import type { CapabilitiesDTO, PostingOpeningDTO } from '@engine/api';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react-native';

import { fakeEngine } from '~/data/testing/fake-engine';
import { queryClient } from '~/state/query-client';

import { PostingOpensBanner } from './PostingOpensBanner';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);

const closedCapabilities = { postingMayBeClosed: true } as CapabilitiesDTO;
const openCapabilities = { postingMayBeClosed: false } as CapabilitiesDTO;

// A week ahead: a fixed date turns "Posting opens on …" into "shortly" once it passes.
const AT = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
AT.setHours(15, 40, 0, 0);
const ATMS = AT.getTime();

function setup(capabilities: CapabilitiesDTO, answer?: PostingOpeningDTO | Promise<PostingOpeningDTO>) {
  fakeEngine.setStatus({ state: 'ready', info: { capabilities } });
  if (answer !== undefined) fakeEngine.method('moderation.postingOpening').mockReturnValue(Promise.resolve(answer));
  return render(
    <QueryClientProvider client={queryClient}>
      <PostingOpensBanner />
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  notifyManager.setScheduler((callback) => callback());
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });
});
afterAll(() => queryClient.clear());
beforeEach(() => {
  jest.clearAllMocks();
  fakeEngine.reset();
  queryClient.clear();
});

describe('PostingOpensBanner', () => {
  it('says when posting opens, from the chain\'s date', async () => {
    setup(closedCapabilities, { kind: 'at', atMs: ATMS });
    await act(async () => {});
    const banner = screen.getByTestId('posting-opens-banner');
    expect(banner).toHaveAccessibleName(new RegExp(`^Posting opens on .*${AT.getFullYear()}`));
    expect(screen.getByText(/^Posting opens on /)).toBeTruthy();
  });

  it('says what posting waits for when no charter has entered the contest, and "shortly" when a seat is about to be written', async () => {
    setup(closedCapabilities, { kind: 'pending' });
    await act(async () => {});
    expect(screen.getByText('Posting opens once the first moderators are elected')).toBeTruthy();
  });

  it('says "shortly" when a team is about to be seated', async () => {
    setup(closedCapabilities, { kind: 'soon' });
    await act(async () => {});
    expect(screen.getByText('Posting opens shortly')).toBeTruthy();
  });

  it.each([{ kind: 'open' }, { kind: 'unknown' }] as const)('shows nothing for a %j answer', async (answer) => {
    setup(closedCapabilities, answer);
    await act(async () => {});
    expect(screen.queryByTestId('posting-opens-banner')).toBeNull();
    expect(screen.queryByTestId('posting-opens-placeholder', { includeHiddenElements: true })).toBeNull();
  });

  it('holds the strip\'s height empty until the first answer, so the feed does not jump', async () => {
    let resolve!: (answer: PostingOpeningDTO) => void;
    setup(closedCapabilities, new Promise<PostingOpeningDTO>((r) => (resolve = r)));
    expect(screen.getByTestId('posting-opens-placeholder', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.queryByTestId('posting-opens-banner')).toBeNull();
    await act(async () => resolve({ kind: 'soon' }));
    expect(screen.queryByTestId('posting-opens-placeholder', { includeHiddenElements: true })).toBeNull();
    expect(screen.getByTestId('posting-opens-banner')).toBeTruthy();
  });

  it('drops the placeholder when the read fails', async () => {
    fakeEngine.setStatus({ state: 'ready', info: { capabilities: closedCapabilities } });
    fakeEngine.method('moderation.postingOpening').mockRejectedValue(new Error('offline'));
    render(
      <QueryClientProvider client={queryClient}>
        <PostingOpensBanner />
      </QueryClientProvider>,
    );
    await act(async () => {});
    expect(screen.queryByTestId('posting-opens-placeholder', { includeHiddenElements: true })).toBeNull();
    expect(screen.queryByTestId('posting-opens-banner')).toBeNull();
  });

  it('asks nothing, and draws nothing, on a contract that is not closed by an interim', async () => {
    setup(openCapabilities, { kind: 'at', atMs: ATMS });
    await act(async () => {});
    expect(fakeEngine.method('moderation.postingOpening')).not.toHaveBeenCalled();
    expect(screen.queryByTestId('posting-opens-banner')).toBeNull();
    expect(screen.queryByTestId('posting-opens-placeholder', { includeHiddenElements: true })).toBeNull();
  });
});
