import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { cn } from '~/lib-allowlist';
import { Avatar } from '~/ui/Avatar';
import { Button } from '~/ui/Button';
import { useMediaUrls } from '~/ui/media-url';
import { SegmentedControl } from '~/ui/Tabs';
import { Text } from '~/ui/Text';
import { TextField } from '~/ui/TextField';
import { tw } from '~/ui/tokens';

import { isMediaUrl, randomSeed, type AvatarChoice } from './edit-profile-form';

export interface AvatarStyles {
  styles: { id: string; label: string }[];
  defaultStyle: string;
  seedMaxLength: number;
}

type Mode = 'generated' | 'link';

export interface AvatarPickerProps {
  open: boolean;
  identityId: string;
  /** The form's current choice (`null`: the identity's default). */
  value: AvatarChoice;
  /** `engine.info().avatarStyles`; null until the engine has answered. */
  avatarStyles: AvatarStyles | null;
  onClose: () => void;
  onChoose: (choice: AvatarChoice) => void;
}

/** The image-link preview: 88 round, "Couldn't load this image" when it fails (PRD PROF-08). */
function LinkPreview({ url }: { url: string }) {
  const urls = useMediaUrls();
  const source = isMediaUrl(url) ? urls.media(url.trim()) : undefined;
  const [failed, setFailed] = useState<string>();
  const error = url.trim() !== '' && (!source || failed === source);
  return (
    <View className="items-center gap-2 py-2">
      <View className={cn('h-[88px] w-[88px] overflow-hidden rounded-full', tw.bgSkeleton)}>
        {source && failed !== source ? (
          <Image
            source={{ uri: source }}
            style={{ width: 88, height: 88 }}
            contentFit="cover"
            onError={() => setFailed(source)}
            accessibilityLabel="Avatar preview"
            testID="avatar-link-preview"
          />
        ) : null}
      </View>
      {error ? (
        <Text variant="caption" tone="error" accessibilityLiveRegion="polite" testID="avatar-link-error">
          Couldn&apos;t load this image
        </Text>
      ) : null}
    </View>
  );
}

/**
 * "Change avatar" (PRD PROF-08, UX_SPEC §4.13): "Generated", a grid of the
 * DiceBear styles drawn by the engine with the current seed, a seed field
 * and "Randomize"; or "Image link", an https / ipfs URL with a preview. A
 * page sheet on iOS: it opens over the Edit profile modal, where the app's
 * bottom sheets (mounted at the root) would sit underneath.
 */
export function AvatarPicker({ open, identityId, value, avatarStyles, onClose, onChoose }: AvatarPickerProps) {
  const insets = useSafeAreaInsets();
  const initialRecipe = value && 'dicebear' in value ? value.dicebear : null;
  const [mode, setMode] = useState<Mode>(value && 'uri' in value ? 'link' : 'generated');
  const [style, setStyle] = useState(initialRecipe?.style ?? avatarStyles?.defaultStyle ?? 'thumbs');
  const [seed, setSeed] = useState(initialRecipe?.seed ?? identityId);
  const [link, setLink] = useState(value && 'uri' in value ? value.uri : '');
  // Every tile is an engine render: redraw the grid once typing pauses.
  const [previewSeed, setPreviewSeed] = useState(seed);
  useEffect(() => {
    const timer = setTimeout(() => setPreviewSeed(seed.trim() || identityId), 300);
    return () => clearTimeout(timer);
  }, [seed, identityId]);
  const seedMax = avatarStyles?.seedMaxLength ?? 100;
  const seedValid = seed.trim().length > 0 && seed.trim().length <= seedMax;
  const linkValid = isMediaUrl(link);
  const canUse = mode === 'generated' ? seedValid && !!avatarStyles : linkValid;

  const use = () => {
    if (mode === 'link') onChoose({ uri: link.trim() });
    else onChoose({ dicebear: { style, seed: seed.trim() } });
  };

  return (
    <Modal
      visible={open}
      animationType="slide"
      presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
      onRequestClose={onClose}
    >
      <View className={cn('flex-1', tw.bg)} testID="avatar-picker" style={{ paddingTop: Platform.OS === 'ios' ? 0 : insets.top }}>
        <View className={cn('min-h-14 flex-row items-center border-b px-4', tw.border)}>
          <Button label="Cancel" variant="link" size="sm" onPress={onClose} testID="avatar-cancel" />
          <Text variant="headline" tone="emphasis" className="flex-1 text-center" accessibilityRole="header">
            Change avatar
          </Text>
          {/* Balances "Cancel", so the title stays centered. */}
          <View className="w-[60px]" />
        </View>
        <View className="px-4 pt-4">
          <SegmentedControl
            options={[
              { value: 'generated', label: 'Generated' },
              { value: 'link', label: 'Image link' },
            ]}
            value={mode}
            onChange={setMode}
            testID="avatar-mode"
          />
        </View>
        <ScrollView
          className="flex-1"
          contentContainerClassName="gap-4 p-4"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          {mode === 'generated' ? (
            <>
              <View className="flex-row items-end gap-3">
                <TextField
                  label="Seed"
                  value={seed}
                  onChangeText={setSeed}
                  maxLength={seedMax}
                  autoCapitalize="none"
                  autoCorrect={false}
                  className="flex-1"
                  testID="avatar-seed"
                />
                <Button
                  label="Randomize"
                  variant="secondary"
                  size="sm"
                  onPress={() => setSeed(randomSeed(seedMax))}
                  layoutStyle={{ marginBottom: 6 }}
                  testID="avatar-randomize"
                />
              </View>
              {avatarStyles ? (
                <View className="flex-row flex-wrap" accessibilityRole="radiogroup">
                  {avatarStyles.styles.map((option) => {
                    const selected = option.id === style;
                    return (
                      <Pressable
                        key={option.id}
                        accessibilityRole="radio"
                        accessibilityLabel={option.label}
                        accessibilityState={{ selected }}
                        onPress={() => setStyle(option.id)}
                        className="w-1/4 items-center gap-1 py-2 active:opacity-70"
                        testID={`avatar-style-${option.id}`}
                      >
                        <View
                          className={cn('rounded-full border-2 p-0.5', selected ? 'border-yappr-500' : 'border-transparent')}
                        >
                          <Avatar
                            avatar={{ uri: null, dicebear: { style: option.id, seed: previewSeed } }}
                            identityId={identityId}
                            size="xl"
                          />
                        </View>
                        <Text
                          variant="caption"
                          tone={selected ? 'link' : 'secondary'}
                          numberOfLines={1}
                          className="px-1 text-center"
                        >
                          {option.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : (
                <Text variant="subhead" tone="secondary" className="text-center">
                  Connecting to Dash Platform…
                </Text>
              )}
            </>
          ) : (
            <>
              <TextField
                label="Image link"
                value={link}
                onChangeText={setLink}
                placeholder="Paste an image link"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                maxLength={512}
                testID="avatar-link"
              />
              <LinkPreview url={link} />
            </>
          )}
        </ScrollView>
        <View className={cn('border-t px-4 pt-3', tw.border)} style={{ paddingBottom: insets.bottom + 12 }}>
          <Button label="Use this avatar" size="block" disabled={!canUse} onPress={use} testID="avatar-use" />
        </View>
      </View>
    </Modal>
  );
}
