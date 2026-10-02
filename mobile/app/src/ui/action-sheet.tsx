import { ActionSheetIOS, Platform, Pressable } from 'react-native';
import { create } from 'zustand';

import { cn } from '~/lib-allowlist';
import { useAppearance } from '~/state/appearance';

import { Sheet } from './Sheet';
import { Text } from './Text';
import { useRipple } from './ripple';
import { tw } from './tokens';

export interface SheetAction {
  label: string;
  destructive?: boolean;
  onPress: () => void;
}

export interface ActionSheetRequest {
  title?: string;
  actions: SheetAction[];
}

const useActionSheet = create<{ request: ActionSheetRequest | null; open: boolean }>()(() => ({
  request: null,
  open: false,
}));

/**
 * The action sheet (UX_SPEC §2.13): `UIAlertController` on iOS, a bottom
 * sheet of rows on Android (`ActionSheetHost`, mounted by the root layout).
 * For short choices: the repost menu, close-compose, unfollow.
 */
export function showActionSheet(request: ActionSheetRequest): void {
  if (Platform.OS === 'ios') {
    const { theme } = useAppearance.getState();
    const options = [...request.actions.map((a) => a.label), 'Cancel'];
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: request.title,
        options,
        cancelButtonIndex: options.length - 1,
        destructiveButtonIndex: request.actions.flatMap((a, i) => (a.destructive ? [i] : [])),
        // The app's Light/Dark override, not just the system's.
        userInterfaceStyle: theme === 'system' ? undefined : theme,
      },
      (index) => request.actions[index]?.onPress(),
    );
    return;
  }
  useActionSheet.setState({ request, open: true });
}

/** Android's action sheet. Renders nothing until `showActionSheet` asks. */
export function ActionSheetHost() {
  const { request, open } = useActionSheet();
  const close = () => useActionSheet.setState({ open: false });
  const ripple = useRipple();
  if (Platform.OS === 'ios') return null;
  return (
    <Sheet open={open} onClose={close} title={request?.title} testID="action-sheet">
      {request?.actions.map((action) => (
        <Pressable
          android_ripple={ripple}
          key={action.label}
          accessibilityRole="button"
          onPress={() => {
            close();
            action.onPress();
          }}
          className={cn('min-h-12 justify-center rounded-lg px-2 android:overflow-hidden', tw.pressed)}
          testID={`action-sheet-${action.label}`}
        >
          <Text variant="body" tone={action.destructive ? 'destructive' : 'emphasis'}>
            {action.label}
          </Text>
        </Pressable>
      ))}
    </Sheet>
  );
}
