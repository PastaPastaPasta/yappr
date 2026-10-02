import type { SettingsDTO, SettingsPatch } from '@engine/api';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { engine } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { queryClient } from '~/state/query-client';
import { selectionTick } from '~/ui/haptics';
import { toast } from '~/ui/toast';

import { copy } from './copy';

/**
 * The content settings (`settings.get` / `settings.set`): link previews, the
 * media gate, the NSFW mode, read receipts and the notification types. They
 * are device-wide, so account switches and sign-out keep them (PRD SET-09).
 * Persisted so the screens (and the gates that read them) paint at launch.
 */
export function useSettings() {
  return useEngineQuery(queryKeys.settings, (api) => api.settings.get(), { persist: true });
}

/** Applies a patch to a settings object, notification types merged. */
export function applyPatch(settings: SettingsDTO, patch: SettingsPatch): SettingsDTO {
  return {
    ...settings,
    ...patch,
    notificationSettings: { ...settings.notificationSettings, ...patch.notificationSettings },
  };
}

/** The fields of `from` that `patch` touches: the undo of that patch. */
function undoOf(from: SettingsDTO, patch: SettingsPatch): SettingsPatch {
  const undo: Record<string, unknown> = {};
  for (const key of Object.keys(patch) as (keyof SettingsPatch)[]) {
    if (key === 'notificationSettings') {
      const types = Object.keys(patch.notificationSettings ?? {}) as (keyof SettingsDTO['notificationSettings'])[];
      undo.notificationSettings = Object.fromEntries(types.map((type) => [type, from.notificationSettings[type]]));
    } else {
      undo[key] = from[key];
    }
  }
  return undo as SettingsPatch;
}

/**
 * Changes settings at once (the control moves before the engine answers),
 * then saves them through the engine. A refused save puts back only the
 * fields this patch changed, so a later change to another field survives.
 */
export async function updateSettings(patch: SettingsPatch): Promise<boolean> {
  const before = queryClient.getQueryData<SettingsDTO>(queryKeys.settings);
  await queryClient.cancelQueries({ queryKey: queryKeys.settings });
  if (before) queryClient.setQueryData<SettingsDTO>(queryKeys.settings, applyPatch(before, patch));
  selectionTick();
  try {
    const saved = await engine.api.settings.set(patch);
    // The cache already shows this patch, and any later one still in flight: keep it.
    if (!queryClient.getQueryData(queryKeys.settings)) queryClient.setQueryData(queryKeys.settings, saved);
    if (patch.notificationSettings) {
      // Turning a type off hides its items from every loaded list at once (NOTIF-05).
      queryClient.invalidateQueries({ queryKey: queryKeys.notificationsAll }).catch(() => undefined);
    }
    return true;
  } catch (error) {
    appendLog('warn', 'host', `Saving settings failed: ${errorMessage(error)}`);
    if (before) {
      const undo = undoOf(before, patch);
      queryClient.setQueryData<SettingsDTO>(queryKeys.settings, (current) => (current ? applyPatch(current, undo) : current));
    }
    toast.error(copy.saveFailed);
    return false;
  }
}
