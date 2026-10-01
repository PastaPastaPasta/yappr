import { colorScheme } from 'nativewind';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { syncStorage } from './storage';

/** The Settings > Appearance choice, as on web (next-themes `defaultTheme="system"`). */
export type ThemePreference = 'system' | 'light' | 'dark';

const THEMES: readonly string[] = ['system', 'light', 'dark'] satisfies ThemePreference[];

/** A persisted value we can trust, or the default. */
export function toThemePreference(value: unknown): ThemePreference {
  return typeof value === 'string' && THEMES.includes(value) ? (value as ThemePreference) : 'system';
}

const readTheme = (persisted: unknown) =>
  toThemePreference((persisted as { theme?: unknown } | null | undefined)?.theme);

interface AppearanceState {
  theme: ThemePreference;
  /**
   * Applies a preference app-wide and persists it. NativeWind forwards it to
   * `Appearance.setColorScheme`, so native chrome (status bar, alerts,
   * keyboards) follows along with `dark:` classes.
   */
  setTheme: (theme: ThemePreference) => void;
}

export const useAppearance = create<AppearanceState>()(
  persist(
    (set) => ({
      theme: 'system',
      setTheme: (theme) => {
        colorScheme.set(theme);
        set({ theme });
      },
    }),
    {
      name: 'appearance',
      version: 1,
      storage: createJSONStorage(() => syncStorage),
      partialize: (state) => ({ theme: state.theme }),
      // Unversioned (v0) and future shapes keep only a valid theme.
      migrate: (persisted) => ({ theme: readTheme(persisted) }),
      // Never hand an unknown string to Appearance.setColorScheme.
      merge: (persisted, current) => ({ ...current, theme: readTheme(persisted) }),
      onRehydrateStorage: () => (state) => {
        // MMKV is synchronous, so this runs while the module loads, before the first render.
        if (state && state.theme !== 'system') colorScheme.set(state.theme);
      },
    },
  ),
);
