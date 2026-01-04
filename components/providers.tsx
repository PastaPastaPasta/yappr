'use client'

import { ThemeProvider } from 'next-themes'
import { AuthProvider } from '@/contexts/auth-context'
import { SdkProvider } from '@/contexts/sdk-context'
import { UsernameModalProvider } from '@/components/dpns/username-modal-provider'
import { BiometricPrompt } from '@/components/ui/biometric-prompt'
import { useBiometricPrompt } from '@/hooks/use-biometric-prompt'
import { KeyBackupModal } from '@/components/auth/key-backup-modal'

function BiometricPromptWrapper() {
  const { isOpen } = useBiometricPrompt()
  return <BiometricPrompt isOpen={isOpen} />
}

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
          <BiometricPromptWrapper />
          <KeyBackupModal />
        </AuthProvider>
      </SdkProvider>
    </ThemeProvider>
  )
}