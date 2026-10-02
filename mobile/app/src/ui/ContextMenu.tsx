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
  /** The trigger, a small button. */
  children: ReactNode;
  testID?: string;
}

/**
 * A native dropdown menu (UX_SPEC §2.4.10) opened by tapping its child:
 * UIMenu on iOS, a popup menu on Android (`@react-native-menu/menu`). The
 * ref's `show()` opens it from code, on Android only. Wrap only a small
 * trigger: on iOS the menu view is a UIButton, which takes every tap inside
 * it, so a wrapped card's own buttons would stop working.
 */
export const ContextMenu = forwardRef<MenuComponentRef, ContextMenuProps>(function ContextMenu(
  { items, onSelect, children, testID },
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
      onPressAction={({ nativeEvent }) => onSelect(nativeEvent.event)}
      themeVariant={dark ? 'dark' : 'light'}
      testID={testID}
    >
      {children}
    </MenuView>
  );
});
