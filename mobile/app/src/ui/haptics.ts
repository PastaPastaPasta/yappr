import * as Haptics from 'expo-haptics';

/** Haptics are best-effort: no hardware, low-power mode, or the OS setting off. */
const ignore = () => undefined;

/** Segments, chips and toggles (UX_SPEC §1.9). */
export function selectionTick() {
  Haptics.selectionAsync().catch(ignore);
}

/** Like (on), follow, the FAB. */
export function lightImpact() {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(ignore);
}

/** A repost or undo repost (UX_SPEC §1.9). */
export function mediumImpact() {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(ignore);
}

/** A failed write, with its error toast (UX_SPEC §1.9). */
export function errorFeedback() {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(ignore);
}
