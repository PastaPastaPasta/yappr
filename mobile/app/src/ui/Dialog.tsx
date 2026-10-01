import type { ReactNode } from 'react';
import { Alert, Modal, Pressable, View } from 'react-native';
import { ExclamationTriangleIcon } from 'react-native-heroicons/outline';
import Animated, { Keyframe } from 'react-native-reanimated';

import { Button } from './Button';
import { Text } from './Text';
import { colors, motion } from './tokens';

/** The web's dialog entrance (`scale-in`): 0.95 → 1 with a fade. */
const SCALE_IN = new Keyframe({
  0: { opacity: 0, transform: [{ scale: 0.95 }] },
  100: { opacity: 1, transform: [{ scale: 1 }] },
}).duration(motion.base);

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** False while a write is in flight: the scrim and back don't close it. */
  dismissible?: boolean;
  testID?: string;
}

/**
 * A centered dialog (components/ui/modal.tsx): `overlay` scrim, a card
 * min(screen − 48, 400) wide with `radius.2xl` and `shadow-xl`.
 */
export function Dialog({ open, onClose, children, dismissible = true, testID }: DialogProps) {
  const close = () => {
    if (dismissible) onClose();
  };
  return (
    <Modal transparent visible={open} animationType="fade" onRequestClose={close} statusBarTranslucent>
      <View className="flex-1 items-center justify-center px-6">
        <Pressable
          accessibilityLabel="Close"
          className="absolute inset-0 bg-black/50"
          onPress={close}
          testID={testID ? `${testID}-scrim` : undefined}
        />
        <Animated.View entering={SCALE_IN} style={{ width: '100%', maxWidth: 400 }}>
          <View
            accessibilityViewIsModal
            onAccessibilityEscape={close}
            testID={testID}
            className="rounded-2xl bg-white p-6 shadow-xl dark:border dark:border-gray-800 dark:bg-neutral-900"
          >
            {children}
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const ICON_TONE = { danger: colors.red500, warning: colors.amber500, default: colors.gray500 } as const;
/** The web's amber confirm: the destructive button (white label, no shadow) in amber. */
const WARNING_FILL = 'bg-amber-600 active:bg-amber-700';

export interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: keyof typeof ICON_TONE;
  isLoading?: boolean;
}

/**
 * components/ui/confirm-dialog.tsx, for confirmations that stay open while
 * the action runs (`isLoading`). Simple yes / no questions use the native
 * alert instead: `confirmAlert`.
 */
export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'danger',
  isLoading = false,
}: ConfirmDialogProps) {
  return (
    <Dialog open={isOpen} onClose={onClose} dismissible={!isLoading} testID="confirm-dialog">
      <View className="flex-row items-start gap-4">
        <View className="rounded-full bg-gray-100 p-2 dark:bg-gray-800">
          <ExclamationTriangleIcon size={24} color={ICON_TONE[variant]} />
        </View>
        <View className="flex-1 gap-1">
          <Text variant="headline" tone="emphasis" accessibilityRole="header">
            {title}
          </Text>
          <Text variant="subhead" tone="secondary">
            {message}
          </Text>
        </View>
      </View>
      <View className="mt-6 flex-row flex-wrap justify-end gap-3">
        <Button label={cancelText} variant="outline" onPress={onClose} disabled={isLoading} />
        <Button
          label={confirmText}
          variant={variant === 'default' ? 'primary' : 'destructive'}
          className={variant === 'warning' ? WARNING_FILL : undefined}
          onPress={onConfirm}
          loading={isLoading}
        />
      </View>
    </Dialog>
  );
}

export interface ConfirmAlertOptions {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  /** Red confirm button (iOS `destructive` style). */
  destructive?: boolean;
}

/**
 * The native confirm (UX_SPEC §2.13): `UIAlertController` on iOS, a Material
 * AlertDialog on Android. Resolves true on confirm, false on cancel or dismiss.
 */
export function confirmAlert({
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  destructive = false,
}: ConfirmAlertOptions): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: cancelText, style: 'cancel', onPress: () => resolve(false) },
        { text: confirmText, style: destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
