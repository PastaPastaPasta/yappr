import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import { StyleSheet, type TextStyle } from 'react-native';

import type { TimelineItem } from './dm-model';
import { MessageBubble } from './MessageBubble';
import { BOB_ID } from './test-fixtures';

type MessageItem = Extract<TimelineItem, { type: 'message' }>;

function bubble(text: string, own = false) {
  return (
    <MessageBubble
      group={false}
      item={{
        type: 'message',
        id: 'm1',
        message: { id: 'm1', sender: BOB_ID, text, at: new Date('2026-09-30T10:00:00Z'), own, pending: false },
        firstOfRun: true,
        lastOfRun: true,
        status: null,
        statusIsError: false,
      }}
    />
  );
}

const styleOf = (text: string | RegExp) =>
  StyleSheet.flatten(screen.getByText(text).props.style as TextStyle | undefined) ?? {};

describe('MessageBubble text direction (PRD G-9)', () => {
  it('right-aligns a Hebrew or Arabic message', () => {
    render(bubble('שלום, מה שלומך?'));
    expect(styleOf('שלום, מה שלומך?')).toMatchObject({ textAlign: 'right', writingDirection: 'rtl' });
  });

  it('aligns each paragraph of a mixed message by its own direction, links still tappable', () => {
    const open = jest.spyOn(WebBrowser, 'openBrowserAsync').mockResolvedValue({ type: 'opened' } as never);
    render(bubble('Hello there\nمرحبا www.dash.org\nשלום', true));
    expect(styleOf('Hello there')).toMatchObject({ textAlign: 'left', writingDirection: 'ltr' });
    expect(styleOf(/^مرحبا.*שלום$/)).toMatchObject({ textAlign: 'right', writingDirection: 'rtl' });
    fireEvent.press(screen.getByText('www.dash.org'));
    expect(open).toHaveBeenCalledWith('https://www.dash.org');
  });
});

describe('MessageBubble (UX_SPEC §2.23)', () => {
  it("keeps a send's spoken time current while it is on its way (QA D-L4a-010)", () => {
    jest.useFakeTimers({ now: Date.UTC(2026, 9, 3, 12, 0, 0) });
    try {
      const item: MessageItem = {
        type: 'message',
        id: 'local:1',
        message: { id: 'local:1', sender: 'me', text: 'are you there?', at: new Date(), own: true, pending: true, outbox: 'sending' },
        firstOfRun: true,
        lastOfRun: true,
        status: 'Sending…',
        statusIsError: false,
      };
      render(<MessageBubble item={item} group={false} />);
      const label = () => screen.getByTestId('dm-outbox-sending').props.accessibilityLabel as string;
      expect(label()).toBe('You, are you there?, 0 seconds ago, Sending…');
      act(() => jest.advanceTimersByTime(100_000));
      expect(label()).toBe('You, are you there?, 1 minute ago, Sending…');
      act(() => jest.advanceTimersByTime(100_000));
      expect(label()).toBe('You, are you there?, 3 minutes ago, Sending…');
    } finally {
      jest.useRealTimers();
    }
  });
});
