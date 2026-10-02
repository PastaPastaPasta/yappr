import { useSession } from '~/data/session';
import { SignedOutPlaceholder } from '~/features/auth/SignedOutPlaceholder';
import { Placeholder } from '~/ui/Placeholder';

export default function MessagesScreen() {
  const { status } = useSession();
  if (status === 'signed-out') return <SignedOutPlaceholder kind="messages" screenTitle="Messages" />;
  return <Placeholder title="Messages" comingIn="the messages PR" />;
}
