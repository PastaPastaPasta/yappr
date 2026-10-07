import { useCallback, useMemo, useRef, type RefObject } from 'react';
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent, ScrollView } from 'react-native';

import { isOverContentLimit, type ContentLimits } from './limits';

export interface Frame {
  y: number;
  height: number;
}

/**
 * Where compose's scroll view has to go so a part's end (its last line, and
 * the hints under it) shows above the keyboard: `null` when it already does.
 */
export function revealOffset(part: Frame | undefined, viewport: Frame): number | null {
  if (!part || viewport.height <= 0) return null;
  const bottom = part.y + part.height;
  return bottom > viewport.y + viewport.height ? bottom - viewport.height : null;
}

/**
 * Edits after which the part's end must be in view: text added at the end
 * (a paste, where the caret then is), or the text going over a limit, whose
 * red overflow and explanation are at the end.
 */
export function revealsEnd(before: string, after: string, limits: ContentLimits): boolean {
  const appended = after.length > before.length && after.startsWith(before);
  return appended || (!isOverContentLimit(before.trim(), limits) && isOverContentLimit(after.trim(), limits));
}

/**
 * How long after an edit its part's layout is still the edit's: the new
 * height arrives within a few frames. A later layout (the media row opening,
 * a part removed so the indexes shift) must not scroll.
 */
const EDIT_LAYOUT_MS = 500;

/**
 * Keeps the end of the part just edited in view (PRD COMP-12, D-L2i-001).
 * Each editor grows instead of scrolling itself (`scrollEnabled={false}`),
 * so after a long paste nothing scrolled the caret, the overflow highlight
 * or the too-long line out from under the keyboard. The part's new height
 * arrives with its layout, so the scroll happens then (and once the edit has
 * rendered, for an edit that changes no height).
 */
export function useEditorReveal(scroll: RefObject<ScrollView | null>) {
  const parts = useRef<Frame[]>([]);
  const viewport = useRef<Frame>({ y: 0, height: 0 });
  const pending = useRef<{ index: number; at: number } | null>(null);

  const reveal = useCallback(
    (index: number) => {
      const y = revealOffset(parts.current[index], viewport.current);
      if (y !== null) scroll.current?.scrollTo({ y, animated: true });
    },
    [scroll],
  );

  return useMemo(
    () => ({
      onEdit(index: number, before: string, after: string, limits: ContentLimits) {
        pending.current = revealsEnd(before, after, limits) ? { index, at: Date.now() } : null;
        if (pending.current) requestAnimationFrame(() => reveal(index));
      },
      onPartLayout(index: number, frame: Frame) {
        parts.current[index] = frame;
        const edit = pending.current;
        if (edit?.index !== index) return;
        pending.current = null;
        if (Date.now() - edit.at <= EDIT_LAYOUT_MS) reveal(index);
      },
      onViewportLayout(e: LayoutChangeEvent) {
        viewport.current = { ...viewport.current, height: e.nativeEvent.layout.height };
      },
      onScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
        viewport.current = { ...viewport.current, y: e.nativeEvent.contentOffset.y };
      },
    }),
    [reveal],
  );
}
