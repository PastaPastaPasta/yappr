'use client'

import { ThemeProvider } from 'next-themes'
import { AuthProvider } from '@/contexts/auth-context'
import { SdkProvider } from '@/contexts/sdk-context'
import { UsernameModalProvider } from '@/components/dpns/username-modal-provider'
import { KeyBackupModal } from '@/components/auth/key-backup-modal'
import { TipModal } from '@/components/post/tip-modal'
import { HashtagRecoveryModal } from '@/components/post/hashtag-recovery-modal'
import { DashPayContactsModal } from '@/components/contacts/dashpay-contacts-modal'

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <SdkProvider>
        <AuthProvider>
          {children}
          <UsernameModalProvider />
          <KeyBackupModal />
          <TipModal />
          <HashtagRecoveryModal />
          <DashPayContactsModal />
        </AuthProvider>
      </SdkProvider>
    </ThemeProvider>
  )
}