import type { CapabilitiesDTO, ProfileDTO } from '@engine/api';
import { router, Stack, useNavigation } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { useCapabilities, useViewerId } from '~/data/session';
import { useWrite } from '~/data/writes';
import { useEngineStatus } from '~/engine/hooks';
import { cn } from '~/lib-allowlist';
import { Avatar } from '~/ui/Avatar';
import { Button } from '~/ui/Button';
import { confirmAlert } from '~/ui/Dialog';
import { ErrorState } from '~/ui/EmptyState';
import { Screen } from '~/ui/Screen';
import { Spinner } from '~/ui/Spinner';
import { SwitchRow } from '~/ui/Switch';
import { Text } from '~/ui/Text';
import { TextField } from '~/ui/TextField';
import { toast } from '~/ui/toast';
import { tw } from '~/ui/tokens';

import { AvatarPicker, type AvatarStyles } from './AvatarPicker';
import {
  avatarDtoOf,
  FIXED_LIMITS,
  formFromProfile,
  isEmptyPatch,
  patchOf,
  validateForm,
  type ProfileForm,
} from './edit-profile-form';
import { ProfileBanner } from './ProfileBanner';
import { profileUpdateWrite } from './profile-writes';

/** Before the engine has said: the v2 profile's limits (PRD §3). */
const FALLBACK_LIMITS: Pick<CapabilitiesDTO, 'profileLimits' | 'dashpayProfile'> = {
  profileLimits: { displayName: 50, bio: 160 },
  dashpayProfile: false,
};

function Section({ title, note, children }: { title?: string; note?: string; children: ReactNode }) {
  return (
    <View className="gap-4">
      {title ? (
        <View className={cn('gap-1 border-b pb-2', tw.border)}>
          <Text variant="subheadStrong" tone="secondary" accessibilityRole="header" className="uppercase">
            {title}
          </Text>
          {note ? (
            <Text variant="caption" tone="secondary">
              {note}
            </Text>
          ) : null}
        </View>
      ) : null}
      {children}
    </View>
  );
}

function EditProfileForm({ profile, viewerId }: { profile: ProfileDTO; viewerId: string }) {
  const navigation = useNavigation();
  const capabilities = useCapabilities();
  const limits = capabilities ?? FALLBACK_LIMITS;
  const avatarStyles: AvatarStyles | null = useEngineStatus().info?.avatarStyles ?? null;
  const defaultStyle = avatarStyles?.defaultStyle ?? 'thumbs';

  const [initial] = useState(() => formFromProfile(profile, defaultStyle));
  const [form, setForm] = useState<ProfileForm>(initial);
  const [pickerOpen, setPickerOpen] = useState(false);
  const save = useWrite(profileUpdateWrite);
  const saving = save.status === 'pending';
  const creating = !profile.hasProfile;
  const patch = patchOf(initial, form, creating);
  const errors = validateForm(form, limits);
  const valid = Object.keys(errors).length === 0;
  const dirty = !isEmptyPatch(patch);
  const canSave = valid && dirty && !saving;
  const set = <K extends keyof ProfileForm>(key: K) => (value: ProfileForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  // Leaving with unsaved changes asks first (PRD PROF-06); a confirmed save leaves at once.
  const leaving = useRef(false);
  useEffect(
    () =>
      navigation.addListener('beforeRemove', (event) => {
        if (leaving.current || !dirty) return;
        event.preventDefault();
        confirmAlert({
          title: 'Discard changes?',
          confirmText: 'Discard',
          cancelText: 'Keep editing',
          destructive: true,
        })
          .then((discard) => {
            if (!discard) return;
            leaving.current = true;
            navigation.dispatch(event.data.action);
          })
          .catch(() => undefined);
      }),
    [navigation, dirty],
  );

  useEffect(() => {
    if (save.status !== 'confirmed') return;
    toast.success('Profile updated!');
    leaving.current = true;
    if (router.canGoBack()) router.back();
  }, [save.status]);

  const onSave = () => {
    if (!canSave) return;
    save.send({ viewerId, patch }).catch(() => undefined);
  };

  const dashpay = limits.dashpayProfile;
  const nameField = (
    <TextField
      label="Name"
      value={form.displayName}
      onChangeText={set('displayName')}
      maxLength={limits.profileLimits.displayName}
      error={errors.displayName}
      editable={!saving}
      testID="edit-name"
    />
  );
  const bioField = (
    <TextField
      label="Bio"
      value={form.bio}
      onChangeText={set('bio')}
      maxLength={limits.profileLimits.bio}
      error={errors.bio}
      multiline
      editable={!saving}
      testID="edit-bio"
    />
  );
  const yapprFields = (
    <>
      <TextField
        label="Pronouns"
        value={form.pronouns}
        onChangeText={set('pronouns')}
        maxLength={FIXED_LIMITS.pronouns}
        error={errors.pronouns}
        editable={!saving}
        testID="edit-pronouns"
      />
      <TextField
        label="Location"
        value={form.location}
        onChangeText={set('location')}
        maxLength={FIXED_LIMITS.location}
        error={errors.location}
        editable={!saving}
        testID="edit-location"
      />
      <TextField
        label="Website"
        value={form.website}
        onChangeText={set('website')}
        maxLength={FIXED_LIMITS.website}
        error={errors.website}
        keyboardType="url"
        autoCapitalize="none"
        autoCorrect={false}
        editable={!saving}
        testID="edit-website"
      />
      <TextField
        label="Banner image link"
        value={form.bannerUri}
        onChangeText={set('bannerUri')}
        maxLength={FIXED_LIMITS.banner}
        error={errors.bannerUri}
        placeholder="https://… or ipfs://…"
        keyboardType="url"
        autoCapitalize="none"
        autoCorrect={false}
        editable={!saving}
        testID="edit-banner"
      />
      <SwitchRow
        label="NSFW Content"
        description="Mark your profile as containing adult content"
        value={form.nsfw}
        onValueChange={set('nsfw')}
        disabled={saving}
        testID="edit-nsfw"
      />
    </>
  );

  return (
    <Screen>
      <Stack.Screen
        options={{
          title: saving ? 'Saving…' : 'Edit profile',
          // Swipe-down would drop unsaved changes without asking.
          gestureEnabled: !dirty && !saving,
          headerLeft: () => (
            <Button label="Cancel" variant="link" size="sm" onPress={() => router.back()} disabled={saving} testID="edit-cancel" />
          ),
          headerRight: () =>
            saving ? (
              <Spinner size="sm" testID="edit-saving" />
            ) : (
              <Button label="Save" size="sm" onPress={onSave} disabled={!canSave} testID="edit-save" />
            ),
        }}
      />
      <KeyboardAvoidingView className="flex-1" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="pb-12" testID="edit-profile">
          <ProfileBanner uri={form.bannerUri.trim() || undefined} height={120} />
          <View className="-mt-11 flex-row items-end gap-3 px-4">
            <Avatar avatar={avatarDtoOf(form.avatar, viewerId, defaultStyle)} identityId={viewerId} size="profile" />
            <Pressable
              accessibilityRole="button"
              onPress={() => setPickerOpen(true)}
              disabled={saving}
              className="mb-2 active:opacity-60"
              testID="edit-change-avatar"
            >
              <Text variant="subheadStrong" tone="link">
                Change avatar
              </Text>
            </Pressable>
          </View>
          <View className="gap-6 px-4 pt-6">
            {dashpay ? (
              <>
                <Section title="DashPay profile" note="This also updates your DashPay profile, which other Dash apps show.">
                  {nameField}
                  {bioField}
                </Section>
                <Section title="Yappr profile">{yapprFields}</Section>
              </>
            ) : (
              <Section>
                {nameField}
                {bioField}
                {yapprFields}
              </Section>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
      {pickerOpen ? (
        <AvatarPicker
          open
          identityId={viewerId}
          value={form.avatar}
          avatarStyles={avatarStyles}
          onClose={() => setPickerOpen(false)}
          onChoose={(choice) => {
            set('avatar')(choice);
            setPickerOpen(false);
          }}
        />
      ) : null}
    </Screen>
  );
}

/** Edit profile (PRD PROF-06 – PROF-08, UX_SPEC §4.13), a modal over the viewer's profile. */
export function EditProfileScreen() {
  const viewerId = useViewerId();
  const profile = useEngineQuery<ProfileDTO | null>(
    queryKeys.profile.detail(viewerId ?? ''),
    (api) => api.profiles.get(viewerId ?? ''),
    { persist: true, enabled: !!viewerId },
  );
  // Never edit from a stale copy: a profile read once this screen opened.
  const [openedAt] = useState(() => Date.now());
  const fresh = profile.data && profile.dataUpdatedAt >= openedAt - 60_000;

  if (!viewerId || profile.data === null) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Edit profile' }} />
        <ErrorState message="Sign in to edit your profile." />
      </Screen>
    );
  }
  if (profile.data && (fresh || !profile.isFetching)) {
    return <EditProfileForm profile={profile.data} viewerId={viewerId} />;
  }
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Edit profile' }} />
      {profile.isError ? (
        <ErrorState
          onRetry={() => {
            profile.refetch().catch(() => undefined);
          }}
        />
      ) : (
        <View className="flex-1 items-center justify-center">
          <Spinner />
        </View>
      )}
    </Screen>
  );
}
