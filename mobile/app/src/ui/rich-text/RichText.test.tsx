import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet, type TextStyle } from 'react-native';

import { RichText } from './RichText';

describe('RichText', () => {
  it('hands tap handlers the normalized mention, tag and link', () => {
    const onMentionPress = jest.fn();
    const onHashtagPress = jest.fn();
    const onCashtagPress = jest.fn();
    const onLinkPress = jest.fn();
    render(
      <RichText
        text="@Bob.dash #DashPlatform $dash www.dash.org."
        onMentionPress={onMentionPress}
        onHashtagPress={onHashtagPress}
        onCashtagPress={onCashtagPress}
        onLinkPress={onLinkPress}
      />,
    );

    fireEvent.press(screen.getByText('@Bob.dash'));
    fireEvent.press(screen.getByText('#DashPlatform'));
    fireEvent.press(screen.getByText('$DASH'));
    fireEvent.press(screen.getByText('www.dash.org'));

    expect(onMentionPress).toHaveBeenCalledWith('bob');
    expect(onHashtagPress).toHaveBeenCalledWith('dashplatform');
    expect(onCashtagPress).toHaveBeenCalledWith('dash_cashtag');
    expect(onLinkPress).toHaveBeenCalledWith('https://www.dash.org');
  });

  it('cuts tags to the contract ceiling when one is given', () => {
    const onHashtagPress = jest.fn();
    render(<RichText text="#abcdefghij" tagMaxLength={4} onHashtagPress={onHashtagPress} />);
    fireEvent.press(screen.getByText('#abcdefghij'));
    expect(onHashtagPress).toHaveBeenCalledWith('abcd');
  });

  it('leaves the previewed link out but keeps its punctuation', () => {
    render(<RichText text="Read https://dash.org/platform." hideFirstUrl />);
    expect(screen.queryByText('https://dash.org/platform')).toBeNull();
    expect(screen.getByText('Read .')).toBeTruthy();
  });

  it('sizes emoji-only text after the previewed link is gone, as web does', () => {
    render(<RichText text="🔥 https://x.com" hideFirstUrl />);
    expect(screen.getByText('🔥').props.className).toContain('text-4xl');
  });

  it('hands out only safe link targets', () => {
    const onLinkPress = jest.fn();
    render(<RichText text="ipfs://bafyabc/pic.png" onLinkPress={onLinkPress} />);
    fireEvent.press(screen.getByText('ipfs://bafyabc/pic.png'));
    expect(onLinkPress).toHaveBeenCalledWith('https://ipfs.io/ipfs/bafyabc/pic.png');
  });

  it('right-aligns each Arabic or Hebrew paragraph and keeps its links tappable (PRD G-9)', () => {
    const onMentionPress = jest.fn();
    const onHashtagPress = jest.fn();
    render(
      <RichText
        text={'[L2i] E-10 RTL: hello\nשלום עולם #עברית #hebrew\nمرحبا @bob\n\nmixed @writes-mina4 עם עברית'}
        onMentionPress={onMentionPress}
        onHashtagPress={onHashtagPress}
        testID="body"
      />,
    );
    const style = (text: string | RegExp) =>
      StyleSheet.flatten(screen.getByText(text).props.style as TextStyle | undefined) ?? {};
    expect(style('[L2i] E-10 RTL: hello')).toMatchObject({ textAlign: 'left', writingDirection: 'ltr' });
    expect(style(/^שלום עולם/)).toMatchObject({ textAlign: 'right', writingDirection: 'rtl' });
    // The Arabic paragraph joins the Hebrew one: one right-aligned block.
    expect(style(/^שלום עולם.*مرحبا @bob$/)).toMatchObject({ textAlign: 'right' });
    expect(style(/mixed/)).toMatchObject({ textAlign: 'left', writingDirection: 'ltr' });

    fireEvent.press(screen.getByText('#hebrew'));
    fireEvent.press(screen.getByText('@bob'));
    expect(onHashtagPress).toHaveBeenCalledWith('hebrew');
    expect(onMentionPress).toHaveBeenCalledWith('bob');
  });

  it('right-aligns a post that starts in Arabic', () => {
    render(<RichText text={'مرحبا من L2i 1040\nmore مرحبا'} />);
    expect(StyleSheet.flatten(screen.getByText(/^مرحبا من/).props.style as TextStyle)).toMatchObject({
      textAlign: 'right',
      writingDirection: 'rtl',
    });
  });

  it('links an over-long tag whole and opens the page it was indexed under', () => {
    const onHashtagPress = jest.fn();
    const tag = `#longtag${'x'.repeat(58)}`;
    render(<RichText text={`see ${tag} now`} tagMaxLength={61} onHashtagPress={onHashtagPress} />);
    fireEvent.press(screen.getByText(tag));
    expect(onHashtagPress).toHaveBeenCalledWith(tag.slice(1, 62));
  });

  it('fits several direction blocks in numberOfLines and reports every line', () => {
    const onLineCount = jest.fn();
    const text = 'english one\nשלום\nenglish two';
    const { rerender } = render(<RichText text={text} onLineCount={onLineCount} />);
    fireEvent(screen.getByText('english one'), 'textLayout', { nativeEvent: { lines: [{}, {}] } });
    fireEvent(screen.getByText('שלום'), 'textLayout', { nativeEvent: { lines: [{}] } });
    expect(onLineCount).not.toHaveBeenCalled();
    fireEvent(screen.getByText('english two'), 'textLayout', { nativeEvent: { lines: [{}, {}, {}] } });
    expect(onLineCount).toHaveBeenLastCalledWith(6);

    rerender(<RichText text={text} numberOfLines={4} />);
    expect(screen.getByText('english one').props.numberOfLines).toBe(4);
    expect(screen.getByText('שלום').props.numberOfLines).toBe(2);
    expect(screen.getByText('english two').props.numberOfLines).toBe(1);

    rerender(<RichText text={text} numberOfLines={2} />);
    expect(screen.queryByText('שלום')).toBeNull();
    expect(screen.queryByText('english two')).toBeNull();
    // The budget ran out at a block boundary: an ellipsis says the text goes on.
    expect(screen.getByText('english one \u2026').props.numberOfLines).toBe(2);
  });

  it('shows a later block only once the blocks above it are laid out, so a clamp never overshoots', () => {
    const text = 'four english lines\nשלום';
    render(<RichText text={text} numberOfLines={4} />);
    // First frame: only the first block, which may take every line.
    expect(screen.getByText('four english lines').props.numberOfLines).toBe(4);
    expect(screen.queryByText('שלום')).toBeNull();

    fireEvent(screen.getByText('four english lines'), 'textLayout', { nativeEvent: { lines: [{}, {}] } });
    expect(screen.getByText('שלום').props.numberOfLines).toBe(2);
    expect(screen.queryByText(/\u2026/)).toBeNull();

    // It grew to the whole budget: the Hebrew block goes, and the English one ends in an ellipsis.
    fireEvent(screen.getByText('four english lines'), 'textLayout', {
      nativeEvent: { lines: [{}, {}, {}, {}] },
    });
    expect(screen.queryByText('שלום')).toBeNull();
    expect(screen.getByText('four english lines \u2026')).toBeTruthy();
  });

  it('reports a single block straight from its layout', () => {
    const onLineCount = jest.fn();
    render(<RichText text={'one\ntwo'} onLineCount={onLineCount} testID="body" />);
    fireEvent(screen.getByTestId('body'), 'textLayout', { nativeEvent: { lines: [{}, {}, {}] } });
    expect(onLineCount).toHaveBeenCalledTimes(1);
    expect(onLineCount).toHaveBeenCalledWith(3);
  });
});
