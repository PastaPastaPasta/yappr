import { Stack, router, useLocalSearchParams } from 'expo-router';
import { ScrollView, View } from 'react-native';

import { LiveFeedGallery } from '~/features/post/LiveFeedGallery';
import { AvatarSvgProvider } from '~/ui/avatar-svg';
import { GALLERY_SECTIONS, type GallerySectionId } from '~/ui/gallery/sections';
import { fixtureAvatarSvg } from '~/ui/post/fixtures';
import { Screen } from '~/ui/Screen';
import { FilterChips } from '~/ui/Tabs';
import { tw } from '~/ui/tokens';

type Filter = GallerySectionId | 'all' | 'live';

const FILTERS = [
  { value: 'all' as const, label: 'All' },
  ...GALLERY_SECTIONS.map(({ id, label }) => ({ value: id, label })),
  // Not part of "All": a live engine feed, with its own list.
  { value: 'live' as const, label: 'Live' },
];

const isFilter = (value: unknown): value is Filter => FILTERS.some((f) => f.value === value);

/**
 * Dev-only (guarded in the root layout): every design-system primitive and
 * PostCard state, for review and screenshots in light and dark (ADR-001 E8).
 * `/__gallery?section=posts` opens one section; `section=live` is the real
 * For You feed through the data layer and `PostItem`.
 */
export default function GalleryScreen() {
  const { section } = useLocalSearchParams<{ section?: string }>();
  // The URL is the state, so a deep link to another section updates an open gallery.
  const filter: Filter = isFilter(section) ? section : 'all';
  const setFilter = (next: Filter) => router.setParams({ section: next });
  const shown = filter === 'all' ? GALLERY_SECTIONS : GALLERY_SECTIONS.filter((s) => s.id === filter);
  const chips = (
    <View className={tw.bg}>
      <FilterChips options={FILTERS} value={filter} onChange={setFilter} testID="gallery-filter" />
    </View>
  );

  if (filter === 'live') {
    // The engine renders the avatars here, through the root layout's provider.
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Gallery' }} />
        {chips}
        <LiveFeedGallery />
      </Screen>
    );
  }

  return (
    // The static sections show fixture authors, with their own avatars.
    <AvatarSvgProvider resolve={fixtureAvatarSvg}>
      <Screen>
        <Stack.Screen options={{ title: 'Gallery' }} />
        <ScrollView
          // A new section starts at the top.
          key={filter}
          contentInsetAdjustmentBehavior="automatic"
          stickyHeaderIndices={[0]}
          contentContainerClassName="pb-16"
        >
          {chips}
          {shown.map(({ id, Component }) => (
            <View key={id} testID={`gallery-${id}`}>
              <Component />
            </View>
          ))}
        </ScrollView>
      </Screen>
    </AvatarSvgProvider>
  );
}
