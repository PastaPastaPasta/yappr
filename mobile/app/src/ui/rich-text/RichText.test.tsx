import { fireEvent, render, screen } from '@testing-library/react-native';

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
});
