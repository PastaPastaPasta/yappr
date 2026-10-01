import { Platform, Pressable, Switch as RNSwitch, View, type SwitchProps as RNSwitchProps } from 'react-native';

import { Text } from './Text';
import { colors, useColors, useIsDark } from './tokens';

export type SwitchProps = Omit<RNSwitchProps, 'trackColor' | 'thumbColor' | 'ios_backgroundColor'>;

/**
 * The native switch in the web's colors: `accent` when on, gray-200 /
 * gray-800 when off (components/ui/switch.tsx), white thumb on Android.
 */
export function Switch({ disabled, style, ...props }: SwitchProps) {
  const c = useColors();
  const off = useIsDark() ? colors.gray800 : colors.gray200;
  return (
    <RNSwitch
      trackColor={{ true: c.accent, false: off }}
      ios_backgroundColor={off}
      thumbColor={Platform.OS === 'android' ? colors.white : undefined}
      disabled={disabled}
      style={[disabled ? { opacity: 0.5 } : null, style]}
      {...props}
    />
  );
}

export interface SwitchRowProps {
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  testID?: string;
}

/** A settings row whose whole area toggles the switch (UX_SPEC §2.9). */
export function SwitchRow({ label, description, value, onValueChange, disabled, testID }: SwitchRowProps) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={description}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
      testID={testID}
      className="min-h-14 flex-row items-center gap-3 px-4 py-3 active:bg-gray-50 dark:active:bg-gray-950"
    >
      <View className="flex-1 gap-0.5">
        <Text variant="bodyStrong">{label}</Text>
        {description ? (
          <Text variant="subhead" tone="secondary">
            {description}
          </Text>
        ) : null}
      </View>
      {/* The row is the control; the switch is only its visual. */}
      <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden pointerEvents="none">
        <Switch value={value} disabled={disabled} />
      </View>
    </Pressable>
  );
}
