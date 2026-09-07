'use client'

import type { ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/lib/store'

interface ModalProps {
  open: boolean
  /** Called with `false` when the overlay is clicked or Escape is pressed. */
  onOpenChange: (open: boolean) => void
  children: ReactNode
  /** Classes on the panel; set the width here, e.g. `w-[420px] max-w-[90vw]`. */
  className?: string
  /**
   * `card` is a padded panel that fades and scales in over a plain overlay.
   * `sheet` is an unpadded panel that also slides up, over a blurred overlay
   * (the blur is skipped in potato mode); it is the shape of the multi-step
   * flows such as compose and checkout.
   */
  variant?: 'card' | 'sheet'
  /** Overlay classes; `sheet` compose uses this to top-align on tall screens. */
  overlayClassName?: string
}

const CARD_MOTION = { initial: { opacity: 0, scale: 0.95 }, animate: { opacity: 1, scale: 1 }, exit: { opacity: 0, scale: 0.95 } }
const SHEET_MOTION = {
  initial: { opacity: 0, scale: 0.95, y: 20 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.95, y: 20 },
  transition: { duration: 0.2, ease: 'easeOut' as const },
}

/**
 * A centred dialog on a dimmed overlay: Radix for focus, escape and the
 * accessibility tree, framer-motion for the enter/exit animation. Put a
 * `<Dialog.Title>` (or `<ModalTitle>`) inside so screen readers get a name.
 */
export function Modal({ open, onOpenChange, children, className, variant = 'card', overlayClassName }: ModalProps) {
  const potatoMode = useSettingsStore((s) => s.potatoMode)
  const sheet = variant === 'sheet'
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className={cn(
                  'fixed inset-0 z-50 flex items-center justify-center px-4',
                  sheet ? 'bg-black/60' : 'bg-black/50',
                  sheet && !potatoMode && 'backdrop-blur-sm',
                  overlayClassName
                )}
              >
                <Dialog.Content asChild>
                  <motion.div
                    {...(sheet ? SHEET_MOTION : CARD_MOTION)}
                    className={cn(
                      'bg-white dark:bg-neutral-900 rounded-2xl relative',
                      sheet ? 'w-full shadow-2xl overflow-hidden' : 'p-6 shadow-xl',
                      className
                    )}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {children}
                  </motion.div>
                </Dialog.Content>
              </motion.div>
            </Dialog.Overlay>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}

/** The default heading inside a `card` modal. */
export function ModalTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <Dialog.Title className={cn('text-xl font-bold mb-2 flex items-center gap-2', className)}>{children}</Dialog.Title>
}
