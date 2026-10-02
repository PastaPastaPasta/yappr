import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { BackHandler } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from './Text';
import { useColors, useIsDark } from './tokens';

export interface SheetProps {
  open: boolean;
  /** Called once the sheet is fully dismissed, by any means. */
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** False while a write is in flight: no scrim tap, swipe or back to close (UX_SPEC §2.13). */
  dismissible?: boolean;
  /**
   * Content that can outgrow the screen (long text, large type, landscape):
   * the sheet stops below the status bar and its content scrolls.
   */
  scrollable?: boolean;
  testID?: string;
}

/**
 * A bottom sheet (UX_SPEC §2.13): `@gorhom/bottom-sheet` sized to its
 * content, with a grabber, `radius.2xl` top corners, `bg.elevated` and the
 * `overlay.sheet` scrim. Android's back gesture closes it first.
 */
export function Sheet({ open, onClose, title, children, dismissible = true, scrollable = false, testID }: SheetProps) {
  const ref = useRef<BottomSheetModal>(null);
  const insets = useSafeAreaInsets();
  const c = useColors();
  const dark = useIsDark();

  // Only dismiss what was presented: gorhom ignores a later present() after
  // dismiss() on a sheet that never opened.
  const presented = useRef(false);
  useEffect(() => {
    if (open) {
      ref.current?.present();
      presented.current = true;
    } else if (presented.current) {
      ref.current?.dismiss();
      presented.current = false;
    }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (dismissible) ref.current?.dismiss();
      return true;
    });
    return () => sub.remove();
  }, [open, dismissible]);

  // A close the user starts (swipe, scrim, back, escape) ends here too. Clear
  // the flag first, so the parent's `open=false` doesn't dismiss() again: that
  // leaves gorhom DISMISSING, and the next present() would never render.
  const handleDismiss = useCallback(() => {
    presented.current = false;
    onClose();
  }, [onClose]);

  const backdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        opacity={0.6}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        pressBehavior={dismissible ? 'close' : 'none'}
      />
    ),
    [dismissible],
  );

  const contentProps = {
    testID,
    accessibilityViewIsModal: true,
    onAccessibilityEscape: () => {
      if (dismissible) ref.current?.dismiss();
    },
  };
  const contentStyle = { paddingHorizontal: 20, paddingTop: 8, paddingBottom: insets.bottom + 16, gap: 12 };
  const body = (
    <>
      {title ? (
        <Text variant="headline" tone="emphasis" accessibilityRole="header">
          {title}
        </Text>
      ) : null}
      {children}
    </>
  );

  return (
    <BottomSheetModal
      ref={ref}
      topInset={insets.top}
      onDismiss={handleDismiss}
      enablePanDownToClose={dismissible}
      backdropComponent={backdrop}
      backgroundStyle={{
        backgroundColor: c.bg,
        borderTopLeftRadius: 16,
        borderTopRightRadius: 16,
        // Dark surfaces separate with a border, not a shadow (UX_SPEC §1.5).
        borderWidth: dark ? 1 : 0,
        borderColor: c.border,
      }}
      handleIndicatorStyle={{ backgroundColor: c.textDecorative }}
    >
      {scrollable ? (
        <BottomSheetScrollView {...contentProps} contentContainerStyle={contentStyle}>
          {body}
        </BottomSheetScrollView>
      ) : (
        <BottomSheetView {...contentProps} style={contentStyle}>
          {body}
        </BottomSheetView>
      )}
    </BottomSheetModal>
  );
}
