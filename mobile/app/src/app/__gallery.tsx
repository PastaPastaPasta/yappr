import { Stack, router, useLocalSearchParams } from 'expo-router';
import { ScrollView, View } from 'react-native';

import { GALLERY_SECTIONS, type GallerySectionId } from '~/ui/gallery/sections';
import { Screen } from '~/ui/Screen';
import { FilterChips } from '~/ui/Tabs';
import { ToastHost } from '~/ui/ToastHost';

type Filter = GallerySectionId | 'all';

const FILTERS = [{ value: 'all' as const, label: 'All' }, ...GALLERY_SECTIONS.map(({ id, label }) => ({ value: id, label }))];

const isFilter = (value: unknown): value is Filter => FILTERS.some((f) => f.value === value);

/**
 * Dev-only (guarded in the root layout): every design-system primitive and
 * PostCard state, for review and screenshots in light and dark (ADR-001 E8).
 * `/__gallery?section=posts` opens one section.
 */
export default function GalleryScreen() {
  const { section } = useLocalSearchParams<{ section?: string }>();
  // The URL is the state, so a deep link to another section updates an open gallery.
  const filter: Filter = isFilter(section) ? section : 'all';
  const setFilter = (next: Filter) => router.setParams({ section: next });
  const shown = filter === 'all' ? GALLERY_SECTIONS : GALLERY_SECTIONS.filter((s) => s.id === filter);

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Gallery' }} />
      <ScrollView contentInsetAdjustmentBehavior="automatic" stickyHeaderIndices={[0]} contentContainerClassName="pb-16">
        <View className="bg-white dark:bg-neutral-900">
          <FilterChips options={FILTERS} value={filter} onChange={setFilter} testID="gallery-filter" />
        </View>
        {shown.map((s) => (
          <View key={s.id} testID={`gallery-${s.id}`}>
            {s.render()}
          </View>
        ))}
      </ScrollView>
      {/* The root layout doesn't mount a toast host yet; the gallery brings its own. */}
      <ToastHost />
    </Screen>
  );
}
