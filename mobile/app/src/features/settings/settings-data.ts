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

/** The fields a patch sets: `notificationSettings.<type>` for each notification type. */
function fieldsOf(patch: SettingsPatch): string[] {
  return Object.keys(patch).flatMap((key) =>
    key === 'notificationSettings' ? Object.keys(patch.notificationSettings ?? {}).map((type) => `${key}.${type}`) : [key],
  );
}

/** The fields of `from` that `patch` touches and `owns` still claims: the undo of that patch. */
function undoOf(from: SettingsDTO, patch: SettingsPatch, owns: (field: string) => boolean): SettingsPatch {
  const undo: Record<string, unknown> = {};
  for (const key of Object.keys(patch) as (keyof SettingsPatch)[]) {
    if (key === 'notificationSettings') {
      const types = (Object.keys(patch.notificationSettings ?? {}) as (keyof SettingsDTO['notificationSettings'])[]).filter(
        (type) => owns(`${key}.${type}`),
      );
      if (types.length > 0) undo.notificationSettings = Object.fromEntries(types.map((type) => [type, from.notificationSettings[type]]));
    } else if (owns(key)) {
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
/** A save was refused since the last time none was out: the cache may not match the engine. */
let refused = false;
/** Each field's latest save: only that one may put the field back. */
const latestSave = new Map<string, number>();
let saves = 0;

/**
 * Changes settings at once (the control moves before the engine answers),
 * then saves them through the engine. A refused save puts back only the
 * fields it changed that no later save has changed since, so a later change
 * survives. Once no save is out, any refusal re-reads the engine.
 */
export async function updateSettings(patch: SettingsPatch): Promise<boolean> {
  selectionTick();
  // Read after the cancel: a change made while it waited must stay under this one.
  await queryClient.cancelQueries({ queryKey: queryKeys.settings });
  const before = queryClient.getQueryData<SettingsDTO>(queryKeys.settings);
  if (before) queryClient.setQueryData<SettingsDTO>(queryKeys.settings, applyPatch(before, patch));
  const id = ++saves;
  const fields = fieldsOf(patch);
  for (const field of fields) latestSave.set(field, id);
  const owns = (field: string) => latestSave.get(field) === id;
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
      const undo = undoOf(before, patch, owns);
      queryClient.setQueryData<SettingsDTO>(queryKeys.settings, (current) => (current ? applyPatch(current, undo) : current));
    }
    refused = true;
    toast.error(copy.saveFailed);
    return false;
  } finally {
    for (const field of fields) if (owns(field)) latestSave.delete(field);
    saving -= 1;
    // Saves to one field can land in any order: once the last answer is in, settle on what the engine has.
    if (saving === 0 && refused) {
      refused = false;
      refetch(queryKeys.settings);
    }
  }
}
