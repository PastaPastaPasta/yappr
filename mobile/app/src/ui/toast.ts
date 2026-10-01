import { create } from 'zustand';

/**
 * The app's toasts, shaped like react-hot-toast (web `app/layout.tsx`) so
 * call sites read the same: `toast('…')`, `toast.success('…')`,
 * `toast.error('…', { action })`. One toast at a time; a new one replaces it.
 * `ToastHost` renders them.
 */

export type ToastKind = 'info' | 'success' | 'error';

export interface ToastAction {
  /** "Retry", "Open yap.pr", "Open in browser", "View" (UX_SPEC §2.14). */
  label: string;
  onPress: () => void;
}

export interface ToastOptions {
  action?: ToastAction;
  /** Overrides the default 3 s (6 s for long messages or with an action). */
  duration?: number;
}

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
  duration: number;
}

const SHORT_MS = 3000;
const LONG_MS = 6000;
const LONG_MESSAGE = 80;

/** 3 s, or 6 s for messages over 80 characters and for toasts with an action. */
export function toastDuration(message: string, options?: ToastOptions): number {
  if (options?.duration !== undefined) return options.duration;
  return message.length > LONG_MESSAGE || options?.action ? LONG_MS : SHORT_MS;
}

interface ToastState {
  current: ToastItem | null;
  show: (kind: ToastKind, message: string, options?: ToastOptions) => number;
  dismiss: (id?: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>()((set, get) => ({
  current: null,
  show: (kind, message, options) => {
    const id = nextId++;
    set({
      current: { id, kind, message, action: options?.action, duration: toastDuration(message, options) },
    });
    return id;
  },
  dismiss: (id) => {
    if (id === undefined || get().current?.id === id) set({ current: null });
  },
}));

type ToastFn = ((message: string, options?: ToastOptions) => number) & {
  success: (message: string, options?: ToastOptions) => number;
  error: (message: string, options?: ToastOptions) => number;
  dismiss: (id?: number) => void;
};

const show = (kind: ToastKind) => (message: string, options?: ToastOptions) =>
  useToastStore.getState().show(kind, message, options);

export const toast: ToastFn = Object.assign(show('info'), {
  success: show('success'),
  error: show('error'),
  dismiss: (id?: number) => useToastStore.getState().dismiss(id),
});
