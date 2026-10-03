import { MenuView, type MenuAction } from '@react-native-menu/menu';
import { useMemo, type ReactNode } from 'react';
import { Platform } from 'react-native';

import { keepHandlesWhole } from './handle';
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
 * UIMenu on iOS, a popup menu on Android (`@react-native-menu/menu`). No
 * ref: the library's Android `show()` throws on the New Architecture (a null
 * command argument), so code opens an action sheet instead. Wrap only a small
 * trigger: on iOS the menu view is a UIButton, which takes every tap inside
 * it, so a wrapped card's own buttons would stop working.
 */
export function ContextMenu({ items, onSelect, children, testID }: ContextMenuProps) {
  const dark = useIsDark();
  const actions = useMemo<MenuAction[]>(
    () =>
      items.map((item) => ({
        id: item.id,
        // The native menu wraps and hyphenates long titles: never inside a handle.
        title: keepHandlesWhole(item.title),
        image: Platform.OS === 'ios' ? item.systemImage : undefined,
        attributes: item.destructive ? { destructive: true } : undefined,
      })),
    [items],
  );
  return (
    <MenuView
      actions={actions}
      onPressAction={({ nativeEvent }) => onSelect(nativeEvent.event)}
      themeVariant={dark ? 'dark' : 'light'}
      testID={testID}
    >
      {children}
    </MenuView>
  );
}
