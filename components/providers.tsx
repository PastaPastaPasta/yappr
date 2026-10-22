'use client'

import { ThemeProvider } from 'next-themes'
import { AuthProvider } from '@/contexts/auth-context'
import { SdkProvider } from '@/contexts/sdk-context'
import { UsernameModalProvider } from '@/components/dpns/username-modal-provider'
import { TipModal } from '@/components/post/tip-modal'
import { RecoveryModal } from '@/components/post/recovery-modal'
import { DeleteConfirmationModal } from '@/components/post/delete-confirmation-modal'
import { ModeratorRemoveModal } from '@/components/moderation/moderator-remove-modal'
import { ModeratorHideModal } from '@/components/moderation/moderator-hide-modal'
import { BulkHideModal } from '@/components/moderation/bulk-hide-modal'
import { ReportPostModal } from '@/components/moderation/report-post-modal'
import { DashPayContactsModal } from '@/components/contacts/dashpay-contacts-modal'
import { EncryptionKeyModal } from '@/components/auth/encryption-key-modal'
import { BuyYappModal } from '@/components/token/buy-yapp-modal'
import { StarterGrantModal } from '@/components/token/starter-grant-modal'
import { QueryInspectorGate } from '@/components/query-inspector/inspector-gate'
import { yappIsLocked } from '@/lib/contract-topology'
import { AppConnectSessionNotices } from '@/components/auth/app-connect-session-notices'
import { PasskeyPrompts } from '@/components/auth/passkey-prompts'
import { isAppConnectBuild } from '@/lib/app-connect/config'

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
          <TipModal />
          {!yappIsLocked() && <BuyYappModal />}
          <StarterGrantModal />
          <RecoveryModal />
          <DeleteConfirmationModal />
          <ModeratorRemoveModal />
          <ModeratorHideModal />
          <BulkHideModal />
          <ReportPostModal />
          <DashPayContactsModal />
          <EncryptionKeyModal />
          <QueryInspectorGate />
          {isAppConnectBuild() && <AppConnectSessionNotices />}
          <PasskeyPrompts />
        </AuthProvider>
      </SdkProvider>
    </ThemeProvider>
  )
}