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
