import { MenuView, type MenuAction, type MenuComponentRef } from '@react-native-menu/menu';
import { forwardRef, useMemo, type ReactNode } from 'react';
import { Platform } from 'react-native';

import { useIsDark } from './tokens';

export interface MenuItem {
  id: string;
  title: string;
  /** iOS: an SF Symbol (`link`, `trash`, ...). Android menus show titles only. */
  systemImage?: string;
  destructive?: boolean;
}

export interface ContextMenuProps {
  items: MenuItem[];
  onSelect: (id: string) => void;
  /**
   * `press`: a dropdown from a "⋯" button (its child must not handle the tap
   * itself). `longPress`: the iOS context menu, with a preview of the child.
   */
  trigger?: 'press' | 'longPress';
  children: ReactNode;
  testID?: string;
}

/**
 * A native menu (UX_SPEC §2.4.10): UIMenu on iOS, a popup menu on Android
 * (`@react-native-menu/menu`). The ref's `show()` opens it on Android only.
 */
export const ContextMenu = forwardRef<MenuComponentRef, ContextMenuProps>(function ContextMenu(
  { items, onSelect, trigger = 'press', children, testID },
  ref,
) {
  const dark = useIsDark();
  const actions = useMemo<MenuAction[]>(
    () =>
      items.map((item) => ({
        id: item.id,
        title: item.title,
        image: Platform.OS === 'ios' ? item.systemImage : undefined,
        attributes: item.destructive ? { destructive: true } : undefined,
      })),
    [items],
  );
  return (
    <MenuView
      ref={ref}
      actions={actions}
      shouldOpenOnLongPress={trigger === 'longPress'}
      onPressAction={({ nativeEvent }) => onSelect(nativeEvent.event)}
      themeVariant={dark ? 'dark' : 'light'}
      testID={testID}
    >
      {children}
    </MenuView>
  );
});
