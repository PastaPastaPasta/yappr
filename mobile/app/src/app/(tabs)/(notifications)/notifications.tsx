import { useSession } from '~/data/session';
import { SignedOutPlaceholder } from '~/features/auth/SignedOutPlaceholder';
import { Placeholder } from '~/ui/Placeholder';

export default function NotificationsScreen() {
  const { status } = useSession();
  if (status === 'signed-out') return <SignedOutPlaceholder kind="notifications" screenTitle="Notifications" />;
  return <Placeholder title="Notifications" comingIn="the notifications PR" />;
}
