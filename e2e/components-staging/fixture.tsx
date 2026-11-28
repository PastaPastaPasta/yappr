import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'react-hot-toast'
import { DpnsRegistrationWizard } from '@/components/dpns/registration-wizard'
import { ComposeModal } from '@/components/compose/compose-modal'
import { ModerationTeamsView } from '@/components/moderation-teams/moderation-teams-view'
import { useDpnsRegistration } from '@/hooks/use-dpns-registration'
import { useAppStore } from '@/lib/store'
import { bindCurrentIdentity } from '@/lib/auth/active-identity'
import { storePrivateKey } from '@/lib/secure-storage'
import { hasSkippedUsername } from '@/lib/username-skip'
import { fixtureAuth, gate, router, settleRegistration } from './mocks'
import '@/app/globals.css'

declare global {
  interface Window {
    fixture: {
      auth: typeof fixtureAuth
      settleRegistration: typeof settleRegistration
      hasSkippedUsername: typeof hasSkippedUsername
      pushed: string[]
      gate: typeof gate
    }
  }
}
window.fixture = { auth: fixtureAuth, settleRegistration, hasSkippedUsername, pushed: router.pushed, gate }

// WIF for public scalar 1. Never use with an actual identity or funds.
for (const id of ['fixture-alice', 'fixture-bob']) storePrivateKey(id, 'cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87JcbXMTcA')
bindCurrentIdentity(() => 'fixture-alice')

/** The wizard at its review step, one contested name approved and its vote acknowledged. */
function DpnsFixture() {
  useEffect(() => {
    useDpnsRegistration.setState({
      step: 'review',
      usernames: [{ id: 'entry-1', label: 'contested-name', status: 'contested', isContested: true }],
      contestedAcknowledged: true,
      quote: {
        status: 'ready',
        balance: 10n ** 12n,
        quote: { names: [{ label: 'contested-name', contestFund: null, fees: 0n }], contestFunds: 0n, fees: 0n, total: 0n, needed: 0n },
      },
    })
  }, [])
  return <DpnsRegistrationWizard />
}

function ComposeFixture() {
  useEffect(() => { useAppStore.getState().openCompose() }, [])
  return <ComposeModal />
}

const fixture = new URLSearchParams(window.location.search).get('fixture')
const root = document.getElementById('root')
if (!root) throw new Error('Fixture root is missing')
createRoot(root).render(
  <>
    {fixture === 'dpns' ? <DpnsFixture /> : fixture === 'compose' ? <ComposeFixture /> : <ModerationTeamsView />}
    <Toaster toastOptions={{ duration: Infinity }} />
  </>
)
