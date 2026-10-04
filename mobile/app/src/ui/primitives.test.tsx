import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AccessibilityInfo, Alert, StyleSheet } from 'react-native';
import { EllipsisHorizontalIcon } from 'react-native-heroicons/outline';
import { FullWindowOverlay } from 'react-native-screens';

import { Avatar, svgFromDataUri } from './Avatar';
import { AvatarSvgProvider } from './avatar-svg';
import { badgeLabel, CountBadge } from './Badge';
import { Button } from './Button';
import { nextLabelChangeAt } from './clock';
import { ConfirmDialog, confirmAlert } from './Dialog';
import { EmptyState, ErrorState } from './EmptyState';
import { IconButton } from './IconButton';
import { LoadingState } from './LoadingState';
import { chipStateOf, NetworkChip } from './NetworkChip';
import { FIXTURE_AVATARS } from './post/fixture-avatars';
import { RadioGroup } from './RadioGroup';
import { SwitchRow } from './Switch';
import { FilterChips, TopTabs } from './Tabs';
import { Text } from './Text';
import { TextField } from './TextField';
import { colors } from './tokens';
import { toast, toastDuration, useToastStore } from './toast';
import { ToastHost } from './ToastHost';
import { followLabel, UserRow } from './UserRow';
import { hostViewAbove } from './testing/native-parent';
import { WriteStatus } from './WriteStatus';

describe('Button', () => {
  it('presses, and labels itself with its text', () => {
    const onPress = jest.fn();
    render(<Button label="Post" onPress={onPress} />);
    fireEvent.press(screen.getByRole('button', { name: 'Post' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('does nothing while disabled or loading, and says so', () => {
    const onPress = jest.fn();
    const { rerender } = render(<Button label="Post" disabled onPress={onPress} />);
    fireEvent.press(screen.getByRole('button'));
    expect(screen.getByRole('button')).toBeDisabled();

    rerender(<Button label="Post" loading onPress={onPress} />);
    fireEvent.press(screen.getByRole('button'));
    expect(screen.getByRole('button')).toBeBusy();
    expect(screen.getByTestId('button-spinner')).toBeTruthy();
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe('Button variants', () => {
  const labelColor = () => StyleSheet.flatten(screen.getByText(/^Follow/).props.style)?.color;

  it('restyles its label when the variant changes on a mounted button', () => {
    // Follow → Following → Follow, as the profile header does.
    const { rerender } = render(<Button label="Follow" variant="primary" size="sm" />);
    expect(labelColor()).toBe(colors.white);
    rerender(<Button label="Following" variant="outline" size="sm" />);
    expect(labelColor()).toBe(colors.gray900);
    rerender(<Button label="Follow" variant="primary" size="sm" />);
    expect(labelColor()).toBe(colors.white);
  });

  it('never drops its border width across variants, which hid the label on Android (D-L3a-001)', () => {
    // Android resets a dropped border width to NaN, and the pill (overflow: hidden) then clips
    // everything inside it away: Following → Follow left a blank blue pill.
    const widths = (className: string) => className.split(/\s+/).filter((c) => /^border(-\d+)?$/.test(c));
    const variants = ['primary', 'outline', 'secondary', 'ghost', 'destructive', 'link'] as const;
    const { rerender } = render(<Button label="Follow" variant="primary" size="sm" />);
    for (const variant of variants) {
      rerender(<Button label="Follow" variant={variant} size="sm" />);
      const className = screen.getByRole('button').props.className as string;
      expect(className).toContain('android:overflow-hidden');
      expect(widths(className)).toEqual([variant === 'outline' ? 'border' : 'border-0']);
    }
  });

  it('keeps the label in one native parent while loading toggles', () => {
    // A flattenable wrapper whose opacity toggles would move the label between native parents,
    // which crashes Android when it happens inside a screen being popped.
    const labelBox = () => hostViewAbove(screen.getByText('Save'));
    const { rerender } = render(<Button label="Save" loading />);
    expect(labelBox()?.props.collapsable).toBe(false);
    rerender(<Button label="Save" />);
    expect(labelBox()?.props.collapsable).toBe(false);
  });

  it('colors the label like its icon and spinner, for every variant', () => {
    const { rerender } = render(<Button label="Follow" variant="link" />);
    expect(labelColor()).toBe(colors.yappr700);
    rerender(<Button label="Follow" variant="destructive" />);
    expect(labelColor()).toBe(colors.white);
    rerender(<Button label="Follow" variant="ghost" />);
    expect(labelColor()).toBe(colors.gray900);
  });
});

describe('IconButton', () => {
  it('requires and exposes a label', () => {
    const onPress = jest.fn();
    render(<IconButton icon={EllipsisHorizontalIcon} accessibilityLabel="Post options" onPress={onPress} />);
    fireEvent.press(screen.getByRole('button', { name: 'Post options' }));
    expect(onPress).toHaveBeenCalled();
  });
});

describe('SwitchRow and RadioGroup', () => {
  it('toggles from anywhere on the row', () => {
    const onValueChange = jest.fn();
    render(<SwitchRow label="Link previews" value={false} onValueChange={onValueChange} />);
    const row = screen.getByRole('switch', { name: 'Link previews' });
    expect(row).not.toBeChecked();
    fireEvent.press(row);
    expect(onValueChange).toHaveBeenCalledWith(true);
  });

  it('marks the chosen option and reports a new one', () => {
    const onChange = jest.fn();
    render(
      <RadioGroup
        value="blur"
        onChange={onChange}
        options={[
          { value: 'blur', title: 'Cover' },
          { value: 'show', title: 'Show' },
        ]}
      />,
    );
    expect(screen.getByRole('radio', { name: 'Cover' })).toBeChecked();
    fireEvent.press(screen.getByRole('radio', { name: 'Show' }));
    expect(onChange).toHaveBeenCalledWith('show');
  });
});

describe('Tabs', () => {
  const options = [
    { value: 'for-you', label: 'For You' },
    { value: 'following', label: 'Following' },
  ] as const;

  it('marks the active tab and switches', () => {
    const onChange = jest.fn();
    render(<TopTabs options={options} value="for-you" onChange={onChange} />);
    expect(screen.getByRole('tab', { name: 'For You' })).toBeSelected();
    fireEvent.press(screen.getByRole('tab', { name: 'Following' }));
    expect(onChange).toHaveBeenCalledWith('following');
  });

  it('does not re-select the active chip', () => {
    const onChange = jest.fn();
    render(
      <FilterChips options={[{ value: 'all', label: 'All', count: 120 }]} value="all" onChange={onChange} />,
    );
    fireEvent.press(screen.getByRole('button', { name: /All/ }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('99+')).toBeTruthy();
  });
});

describe('TextField', () => {
  it('shows the error and the counter near the limit', () => {
    render(
      <TextField
        label="Bio"
        value={'x'.repeat(25)}
        maxLength={30}
        error="Too long"
        onChangeText={jest.fn()}
      />,
    );
    expect(screen.getByText('Too long')).toBeTruthy();
    expect(screen.getByText('25 / 30')).toBeTruthy();
  });

  it('keeps the input in one native parent whether or not it is editable', () => {
    // The box dims while a form saves. Were it flattenable, the input would move out of it when
    // the save ends, and on Android that move crashed the app inside a closing modal.
    const { rerender } = render(<TextField label="Name" value="Jana" editable={false} onChangeText={jest.fn()} />);
    const box = () => hostViewAbove(screen.getByLabelText('Name'));
    expect(box()?.props.className).toContain('opacity-50');
    expect(box()?.props.collapsable).toBe(false);
    rerender(<TextField label="Name" value="Jana" onChangeText={jest.fn()} />);
    expect(box()?.props.className).not.toContain('opacity-50');
    expect(box()?.props.collapsable).toBe(false);
  });

  it('hides the counter far from the limit', () => {
    render(<TextField label="Bio" value="short" maxLength={160} onChangeText={jest.fn()} />);
    expect(screen.queryByText(/\/ 160/)).toBeNull();
  });

  it('hides a secret until asked, with autofill off', () => {
    render(<TextField label="Private key" secure value="secret" onChangeText={jest.fn()} />);
    const input = screen.getByLabelText('Private key');
    expect(input.props.secureTextEntry).toBe(true);
    expect(input.props.autoComplete).toBe('off');
    fireEvent.press(screen.getByRole('button', { name: 'Show key' }));
    expect(screen.getByLabelText('Private key').props.secureTextEntry).toBe(false);
    expect(screen.getByRole('button', { name: 'Hide key' })).toBeTruthy();
  });
});

describe('badges and chips', () => {
  it('caps counts at 99+ and hides zero', () => {
    expect(badgeLabel(99)).toBe('99');
    expect(badgeLabel(100)).toBe('99+');
    render(<CountBadge count={0} />);
    expect(screen.toJSON()).toBeNull();
  });

  it('names the network and the connection state in plain words, and hides on mainnet', () => {
    const { rerender } = render(<NetworkChip network="devnet" state="booting" onPress={jest.fn()} />);
    expect(screen.getByRole('button', { name: 'Devnet. Data may be reset. Connecting.' })).toBeTruthy();
    rerender(<NetworkChip network="testnet" state="ready" onPress={jest.fn()} />);
    expect(screen.getByRole('button', { name: 'Testnet. Data may be reset. Connected.' })).toBeTruthy();
    rerender(<NetworkChip network="testnet" state="unavailable" onPress={jest.fn()} />);
    expect(screen.getByRole('button', { name: "Testnet. Data may be reset. Can't connect." })).toBeTruthy();
    rerender(<NetworkChip network="devnet" state="booting" onPress={jest.fn()} />);
    expect(screen.getByTestId('network-dot-booting')).toBeTruthy();
    rerender(<NetworkChip network="mainnet" state="ready" />);
    expect(screen.queryByTestId('network-chip')).toBeNull();
  });

  it('shows a boot that failed as unavailable, not ready (NET-01, NET-07)', () => {
    expect(chipStateOf('ready')).toBe('ready');
    expect(chipStateOf('degraded')).toBe('unavailable');
    expect(chipStateOf('failed')).toBe('unavailable');
    expect(chipStateOf('unsupported')).toBe('unavailable');
    expect(chipStateOf('booting')).toBe('booting');
    expect(chipStateOf('restarting')).toBe('booting');
  });

  it('lays its label out as measured, so Android never clips a letter (D-L3a-008)', () => {
    render(<NetworkChip network="devnet" state="ready" />);
    const label = screen.getByTestId('network-chip-label', { includeHiddenElements: true });
    // The high-quality breaker wrapped the last letter onto a clipped second line ("DEVNE").
    expect(label.props.textBreakStrategy).toBe('simple');
    expect(label.props.children).toBe('DEVNET');
    expect(label.props.numberOfLines).toBeUndefined();
    // Uppercased in JS, so no textTransform between Android's measure and layout passes.
    const classes = (label.props.className as string).split(/\s+/);
    expect(classes).toContain('normal-case');
    expect(classes).not.toContain('uppercase');
  });
});

describe('states', () => {
  it('LoadingState prefers loading, then error, then empty', () => {
    const onRetry = jest.fn();
    const { rerender } = render(
      <LoadingState loading error="x">
        <Text>content</Text>
      </LoadingState>,
    );
    expect(screen.getByTestId('loading-state')).toBeTruthy();

    rerender(
      <LoadingState loading={false} error="Couldn't connect" onRetry={onRetry}>
        <Text>content</Text>
      </LoadingState>,
    );
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();

    rerender(
      <LoadingState loading={false} isEmpty emptyText="No posts">
        <Text>content</Text>
      </LoadingState>,
    );
    expect(screen.getByText('No posts')).toBeTruthy();

    rerender(
      <LoadingState loading={false}>
        <Text>content</Text>
      </LoadingState>,
    );
    expect(screen.getByText('content')).toBeTruthy();
  });

  it('EmptyState has a header title and an optional action', () => {
    const onPress = jest.fn();
    render(<EmptyState title="No bookmarks yet" action={{ label: 'Explore', onPress }} />);
    expect(screen.getByRole('header', { name: 'No bookmarks yet' })).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Explore' }));
    expect(onPress).toHaveBeenCalled();
  });

  // D-L4a-011: the signed-out "Sign in" buttons had no test ID (PRD A11Y-08).
  it('EmptyState gives its action a test ID derived from its own', () => {
    render(<EmptyState title="Sign in" action={{ label: 'Sign in', onPress: jest.fn() }} testID="signed-out-notifications" />);
    expect(screen.getByRole('button', { name: 'Sign in' }).props.testID).toBe('signed-out-notifications-action');
  });

  it('ErrorState has no button without a retry', () => {
    render(<ErrorState message="Nope" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('WriteStatus', () => {
  it.each([
    [{ state: 'posting' } as const, 'Posting…', []],
    [{ state: 'threadProgress', index: 2, total: 5 } as const, 'Posting 2 of 5…', []],
    // Only once the app's own checks ran out: Edit, never a manual check or a blind Retry.
    [{ state: 'unconfirmed' } as const, "Couldn't confirm", ['Edit']],
    [{ state: 'failed' } as const, "Couldn't post", ['Retry', 'Edit']],
    [{ state: 'partial', posted: 2, total: 5 } as const, 'Posted 2 of 5', ['Retry the rest']],
  ])('%o reads "%s" with %o', (status, text, links) => {
    render(
      <WriteStatus
        status={status}
        onRetry={jest.fn()}
        onEdit={jest.fn()}
        onRetryRest={jest.fn()}
      />,
    );
    expect(screen.getByText(text)).toBeTruthy();
    for (const link of links) expect(screen.getByRole('button', { name: link })).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(links.length);
  });

  it('gives each action a testID, and targets that never reach over a neighbour (A11Y-08, UX_SPEC §6.4)', () => {
    const onRetry = jest.fn();
    const onEdit = jest.fn();
    render(<WriteStatus status={{ state: 'failed' }} onRetry={onRetry} onEdit={onEdit} />);
    for (const id of ['write-status-retry', 'write-status-edit']) {
      const link = screen.getByTestId(id);
      expect(link.props.hitSlop).toMatchObject({ left: 0, right: 0 });
      expect(link.props.hitSlop.top).toBeGreaterThan(0);
      expect(StyleSheet.flatten(link.props.style).minWidth).toBeGreaterThanOrEqual(44);
    }
    fireEvent.press(screen.getByTestId('write-status-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('announces state changes, not its first appearance', () => {
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => undefined);
    const { rerender } = render(<WriteStatus status={{ state: 'posting' }} />);
    expect(announce).not.toHaveBeenCalled();
    rerender(<WriteStatus status={{ state: 'unconfirmed' }} />);
    expect(announce).toHaveBeenCalledWith("Couldn't confirm");
    announce.mockRestore();
  });

  it('stays quiet when a recycled cell shows another post', () => {
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => undefined);
    const { rerender } = render(<WriteStatus postId="a" status={{ state: 'posting' }} />);
    rerender(<WriteStatus postId="b" status={{ state: 'failed' }} />);
    expect(announce).not.toHaveBeenCalled();
    rerender(<WriteStatus postId="b" status={{ state: 'unconfirmed' }} />);
    expect(announce).toHaveBeenCalledWith("Couldn't confirm");
    announce.mockRestore();
  });

  it('runs the retry action', () => {
    const onRetry = jest.fn();
    render(<WriteStatus status={{ state: 'failed' }} onRetry={onRetry} />);
    fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe('dialogs', () => {
  it('ConfirmDialog confirms, cancels, and locks while loading', () => {
    const onConfirm = jest.fn();
    const onClose = jest.fn();
    const { rerender } = render(
      <ConfirmDialog
        isOpen
        title="Delete post?"
        message="Gone for good."
        confirmText="Delete"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    fireEvent.press(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <ConfirmDialog
        isOpen
        isLoading
        title="Delete post?"
        message="Gone for good."
        confirmText="Delete"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.press(screen.getByTestId('confirm-dialog-scrim'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('confirmAlert resolves with the button pressed', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      buttons?.find((b) => b.style === 'destructive')?.onPress?.();
    });
    await expect(confirmAlert({ title: 'Delete?', destructive: true })).resolves.toBe(true);
    alert.mockRestore();
  });
});

describe('toasts', () => {
  afterEach(() => act(() => toast.dismiss()));

  it('lasts 3 s, or 6 s when long or actionable', () => {
    expect(toastDuration('Saved')).toBe(3000);
    expect(toastDuration('x'.repeat(81))).toBe(6000);
    expect(toastDuration('Failed', { action: { label: 'Retry', onPress: jest.fn() } })).toBe(6000);
  });

  it('shows one at a time, runs its action and dismisses on its own', () => {
    jest.useFakeTimers();
    const onPress = jest.fn();
    render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 47, left: 0, right: 0, bottom: 34 },
        }}
      >
        <ToastHost />
      </SafeAreaProvider>,
    );
    act(() => {
      toast.success('First');
      toast.error('Second', { action: { label: 'Retry', onPress } });
    });
    expect(screen.queryByText('First')).toBeNull();
    expect(screen.getByText('Second')).toBeTruthy();

    fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(onPress).toHaveBeenCalled();
    expect(useToastStore.getState().current).toBeNull();

    act(() => {
      toast('Third');
    });
    act(() => jest.advanceTimersByTime(3000));
    expect(useToastStore.getState().current).toBeNull();
    jest.useRealTimers();
  });

  it('on iOS, lifts each toast into a window overlay above modals, unless told not to (SR-33)', () => {
    const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
    const view = render(
      <SafeAreaProvider initialMetrics={metrics}>
        <ToastHost aboveModals />
      </SafeAreaProvider>,
    );
    expect(view.UNSAFE_queryAllByType(FullWindowOverlay)).toHaveLength(0);
    act(() => {
      toast.error('Failed to update profile');
    });
    const [overlay] = view.UNSAFE_getAllByType(FullWindowOverlay);
    expect(overlay?.props.unstable_accessibilityContainerViewIsModal).toBe(false);
    expect(screen.getByText('Failed to update profile')).toBeTruthy();

    // While the app lock is up the toast stays in the root view, under the lock screen.
    view.rerender(
      <SafeAreaProvider initialMetrics={metrics}>
        <ToastHost aboveModals={false} />
      </SafeAreaProvider>,
    );
    expect(view.UNSAFE_queryAllByType(FullWindowOverlay)).toHaveLength(0);
    expect(screen.getByText('Failed to update profile')).toBeTruthy();
  });
});

describe('Avatar', () => {
  it('decodes the engine’s base64 DiceBear data URI, UTF-8 included', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><title>Körner</title></svg>';
    const uri = `data:image/svg+xml;base64,${btoa(String.fromCharCode(...new TextEncoder().encode(svg)))}`;
    expect(svgFromDataUri(uri)).toBe(svg);
    expect(svgFromDataUri(`data:image/svg+xml,${encodeURIComponent(svg)}`)).toBe(svg);
    expect(svgFromDataUri('https://example.com/a.png')).toBeNull();
  });

  it('draws SVG locally, loads other URLs, and falls back on error', () => {
    const { rerender } = render(<Avatar uri={FIXTURE_AVATARS.alice.uri} />);
    // Decorative (hidden from screen readers) unless tappable.
    expect(screen.getByTestId('avatar-svg', { includeHiddenElements: true })).toBeTruthy();

    rerender(<Avatar uri="https://example.com/a.png" fallback={FIXTURE_AVATARS.bob.uri} />);
    const image = screen.getByTestId('avatar-image', { includeHiddenElements: true });
    act(() => image.props.onError?.({ nativeEvent: { error: 'HTTP 404' } }));
    expect(screen.getByTestId('avatar-fallback', { includeHiddenElements: true })).toBeTruthy();
  });

  it('draws a DiceBear recipe from the engine-rendered SVG, cached by style and seed', async () => {
    const resolve = jest.fn(async () => '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const recipe = { uri: null, dicebear: { style: 'thumbs', seed: 'seed-1' } };
    const { unmount } = render(
      <AvatarSvgProvider resolve={resolve}>
        <Avatar avatar={recipe} identityId="id-1" />
      </AvatarSvgProvider>,
    );
    expect(await screen.findByTestId('avatar-svg', { includeHiddenElements: true })).toBeTruthy();
    expect(resolve).toHaveBeenCalledWith('id-1', 'thumbs', 'seed-1');
    unmount();

    render(
      <AvatarSvgProvider resolve={resolve}>
        <Avatar avatar={recipe} identityId="id-1" />
      </AvatarSvgProvider>,
    );
    expect(screen.getByTestId('avatar-svg', { includeHiddenElements: true })).toBeTruthy();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('puts transparent DiceBear art on a backdrop that stays light in dark mode (D-L3a-007)', () => {
    const { rerender } = render(<Avatar uri={FIXTURE_AVATARS.alice.uri} testID="avatar" />);
    const svgCircle = screen.getByTestId('avatar', { includeHiddenElements: true }).props.className as string;
    // Black line-art strokes (lorelei, notionists, micah) vanish on the dark page (neutral-900).
    expect(svgCircle).toContain('dark:bg-gray-200');
    expect(svgCircle).not.toContain('dark:bg-neutral-900');

    // A photo covers its circle: the skeleton color shows only while it loads.
    rerender(<Avatar uri="https://example.com/a.png" testID="avatar" />);
    expect(screen.getByTestId('avatar', { includeHiddenElements: true }).props.className).toContain('dark:bg-gray-800');

    // A recipe still rendering already sits on the backdrop: no dark skeleton turning light.
    const pending = { uri: null, dicebear: { style: 'lorelei', seed: 'seed-pending' } };
    render(
      <AvatarSvgProvider resolve={() => new Promise<string | null>(() => undefined)}>
        <Avatar avatar={pending} identityId="id-pending" testID="pending-avatar" />
      </AvatarSvgProvider>,
    );
    expect(screen.queryByTestId('avatar-svg', { includeHiddenElements: true })).toBeNull();
    expect(screen.getByTestId('pending-avatar', { includeHiddenElements: true }).props.className).toContain('dark:bg-gray-200');
  });

  it('is a labelled button only when tappable', () => {
    const onPress = jest.fn();
    render(<Avatar uri={FIXTURE_AVATARS.alice.uri} name="Alice" onPress={onPress} />);
    fireEvent.press(screen.getByRole('button', { name: "Alice's profile" }));
    expect(onPress).toHaveBeenCalled();
  });
});

describe('UserRow', () => {
  const user = { id: 'B2vAkPq8YjZ6uWnMx3RsT5cH9eLfG4dNy7QbVrK1mJzE', displayName: 'Bob', username: 'bob' };

  it('labels the follow button by relationship', () => {
    expect(followLabel(false, false)).toBe('Follow');
    expect(followLabel(false, true)).toBe('Follow back');
    expect(followLabel(true, true)).toBe('Following');
  });

  it('follows from the row, and shows no button on your own row', () => {
    const onFollowPress = jest.fn();
    const { rerender } = render(
      <UserRow user={user} followsYou onFollowPress={onFollowPress} testID="row" />,
    );
    expect(screen.getByText('Follows you')).toBeTruthy();
    expect(screen.getByText('Follow back')).toBeTruthy();
    fireEvent.press(screen.getByTestId('row-follow'));
    expect(onFollowPress).toHaveBeenCalled();

    rerender(<UserRow user={user} isSelf onFollowPress={onFollowPress} testID="row" />);
    expect(screen.queryByTestId('row-follow')).toBeNull();
  });

  it('reads as one element with following as an action', () => {
    const onFollowPress = jest.fn();
    render(<UserRow user={user} followsYou onFollowPress={onFollowPress} />);
    const row = screen.getByRole('button', { name: 'Bob, @bob, follows you' });
    fireEvent(row, 'accessibilityAction', { nativeEvent: { actionName: 'follow' } });
    expect(onFollowPress).toHaveBeenCalled();
  });

  it('shows the truncated id for a nameless identity', () => {
    render(<UserRow user={{ ...user, username: null }} />);
    expect(screen.getByText('B2vAkPq8...K1mJzE')).toBeTruthy();
  });

  it('aligns a bio by its first strong character', () => {
    const { rerender } = render(<UserRow user={{ ...user, bio: 'שלום, I cook' }} />);
    expect(StyleSheet.flatten(screen.getByText('שלום, I cook').props.style)).toMatchObject({
      textAlign: 'right',
      writingDirection: 'rtl',
    });
    rerender(<UserRow user={{ ...user, bio: 'I cook שלום' }} />);
    expect(StyleSheet.flatten(screen.getByText('I cook שלום').props.style)).toMatchObject({ textAlign: 'left' });
  });
});

describe('nextLabelChangeAt', () => {
  it('turns each label on its own second, minute, hour and day boundary, then stops', () => {
    const now = 1_000_000_000_000;
    expect(nextLabelChangeAt(now - 10_400, now)).toBe(now + 600);
    expect(nextLabelChangeAt(now - 90_000, now)).toBe(now + 30_000);
    expect(nextLabelChangeAt(now - 3_600_000 * 2.5, now)).toBe(now + 1_800_000);
    expect(nextLabelChangeAt(now - 86_400_000 * 1.25, now)).toBe(now + 86_400_000 * 0.75);
    expect(nextLabelChangeAt(now - 8 * 86_400_000, now)).toBeNull();
    expect(nextLabelChangeAt(Number.NaN, now)).toBeNull();
  });

  it('ticks a time just ahead of this device each second, and waits for one far ahead', () => {
    const now = 1_000_000_000_000;
    expect(nextLabelChangeAt(now + 5_000, now)).toBe(now + 1_000);
    expect(nextLabelChangeAt(now + 3_600_000, now)).toBe(now + 3_540_000);
  });
});
