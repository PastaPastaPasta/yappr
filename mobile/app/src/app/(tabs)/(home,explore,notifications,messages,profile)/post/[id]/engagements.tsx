import { useLocalSearchParams } from 'expo-router';

import { Placeholder } from '~/ui/Placeholder';

export default function EngagementsScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <Placeholder title="Engagements" detail={`id: ${id ?? ''}`} comingIn="the post detail PR" />;
}
