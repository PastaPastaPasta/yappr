import { useSession } from '~/data/session';
import { SignedOutPlaceholder } from '~/features/auth/SignedOutPlaceholder';
import { ComposeFab } from '~/ui/ComposeFab';
import { Placeholder } from '~/ui/Placeholder';

export default function OwnProfileScreen() {
  const { status } = useSession();
  if (status === 'signed-out') return <SignedOutPlaceholder kind="profile" screenTitle="Profile" />;
  return (
    <>
      <Placeholder title="Profile" comingIn="the profiles PR" />
      <ComposeFab />
    </>
  );
}
