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

/** The lists the engine filters by the NSFW mode as it builds them (`hide` drops posts). */
const NSFW_FILTERED = [queryKeys.feed.all, queryKeys.explore.all, queryKeys.profile.all, queryKeys.post.all, queryKeys.bookmarks];

const refetch = (queryKey: readonly unknown[]) => {
  queryClient.invalidateQueries({ queryKey }).catch(() => undefined);
};

/** Saves not yet answered: a re-read while one is out could show the engine before it lands. */
let saving = 0;

/**
 * Changes settings at once (the control moves before the engine answers),
 * then saves them through the engine. A refused save puts back only the
 * fields this patch changed, so a later change to another field survives.
 */
export async function updateSettings(patch: SettingsPatch): Promise<boolean> {
  selectionTick();
  // Read after the cancel: a change made while it waited must stay under this one.
  await queryClient.cancelQueries({ queryKey: queryKeys.settings });
  const before = queryClient.getQueryData<SettingsDTO>(queryKeys.settings);
  if (before) queryClient.setQueryData<SettingsDTO>(queryKeys.settings, applyPatch(before, patch));
  saving += 1;
  try {
    const saved = await engine.api.settings.set(patch);
    // The cache already shows this patch, and any later one still in flight: keep it.
    if (!queryClient.getQueryData(queryKeys.settings)) queryClient.setQueryData(queryKeys.settings, saved);
    // Turning a type off hides its items from every loaded list at once (NOTIF-05).
    if (patch.notificationSettings) refetch(queryKeys.notificationsAll);
    // Loaded lists were built under the old mode: Hide must drop NSFW posts, and leaving it bring them back.
    if (patch.sensitiveContentMode !== undefined) NSFW_FILTERED.forEach(refetch);
    return true;
  } catch (error) {
    appendLog('warn', 'host', `Saving settings failed: ${errorMessage(error)}`);
    if (before) {
      const undo = undoOf(before, patch);
      queryClient.setQueryData<SettingsDTO>(queryKeys.settings, (current) => (current ? applyPatch(current, undo) : current));
    }
    // Two refused changes to one field can undo in the wrong order: once the last answer is in,
    // settle on what the engine has.
    if (saving === 1) refetch(queryKeys.settings);
    toast.error(copy.saveFailed);
    return false;
  } finally {
    saving -= 1;
  }
}
