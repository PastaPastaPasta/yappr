import type { CapabilitiesDTO, ProfileDTO } from '@engine/api';
import { router, Stack, useNavigation } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { useCapabilities, useViewerId } from '~/data/session';
import { useWrite } from '~/data/writes';
import { useEngineStatus } from '~/engine/hooks';
import { Avatar } from '~/ui/Avatar';
import { Button } from '~/ui/Button';
import { confirmAlert } from '~/ui/Dialog';
import { ErrorState } from '~/ui/EmptyState';
import { KeyboardAvoider } from '~/ui/KeyboardAvoider';
import { LinkText } from '~/ui/LinkText';
import { Screen } from '~/ui/Screen';
import { Spinner } from '~/ui/Spinner';
import { SwitchRow } from '~/ui/Switch';
import { Text } from '~/ui/Text';
import { TextField } from '~/ui/TextField';
import { toast } from '~/ui/toast';

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
  // A confirmed save closes the modal (below), and the form keeps its saving look until it has
  // gone. Re-enabling the fields in the render that closes it would move the inputs between
  // native parents inside a screen Android has started to animate out, which crashes the app.
  const closing = save.status === 'confirmed';
  // Sent, but not confirmed (the network stalled, or its answer never came): it may still land,
  // so it is never called saved (RC16-A-01). The form stays, its edits kept and locked, while the
  // app checks; "Check again" checks now. A check that finds it saved closes the form as a
  // confirmed save does; one that proves it absent unlocks the form, edits intact, to save again.
  const unsure = save.status === 'unconfirmed' && save.ticket?.retryable !== true;
  const [checking, setChecking] = useState(false);
  // From the tap: until the engine answers with a ticket the status is still idle, and a second
  // Save would be queued behind the first with its change shown, one save the user never meant.
  const [sending, setSending] = useState(false);
  // A second tap before the re-render that disables Save.
  const sendingNow = useRef(false);
  const saving = sending || save.status === 'pending' || closing;
  const creating = !profile.hasProfile;
  const patch = patchOf(initial, form, creating);
  const errors = validateForm(form, limits);
  const valid = Object.keys(errors).length === 0;
  // Edited since the modal opened. Without a profile document the pre-filled name already
  // makes a patch (the first save creates the profile), but leaving then loses nothing.
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const canSave = valid && !isEmptyPatch(patch) && !saving && !unsure;
  const locked = saving || unsure;
  const set = <K extends keyof ProfileForm>(key: K) => (value: ProfileForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  // Leaving with unsaved changes asks first (PRD PROF-06); a confirmed save leaves at once, and
  // so does one still being checked: its change is on its way, and nothing is discarded.
  const leaving = useRef(false);
  useEffect(
    () =>
      navigation.addListener('beforeRemove', (event) => {
        if (leaving.current || !dirty || unsure) return;
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
    [navigation, dirty, unsure],
  );

  // Only a confirmed save is "Profile updated!": its own answer, or a check that found it landed.
  useEffect(() => {
    if (save.status !== 'confirmed') return;
    toast.success('Profile updated!');
    leaving.current = true;
    // Opened on its own (a cold link), with nothing under it: the profile it edited.
    if (router.canGoBack()) router.back();
    else router.replace('/profile');
  }, [save.status]);

  const onSave = () => {
    if (!canSave || sendingNow.current) return;
    const avatar = patch.avatar === undefined ? undefined : avatarDtoOf(form.avatar, viewerId, defaultStyle);
    sendingNow.current = true;
    setSending(true);
    save
      .send({ viewerId, patch, avatar })
      .catch(() => undefined)
      .finally(() => {
        sendingNow.current = false;
        setSending(false);
      });
  };

  const onCheck = () => {
    if (checking) return;
    setChecking(true);
    save
      .check()
      .catch(() => undefined)
      .finally(() => setChecking(false));
  };

  const nameField = (
    <TextField
      label="Name"
      value={form.displayName}
      onChangeText={set('displayName')}
      maxLength={limits.profileLimits.displayName}
      error={errors.displayName}
      editable={!locked}
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
      editable={!locked}
      testID="edit-bio"
    />
  );
  const otherFields = (
    <>
      <TextField
        label="Pronouns"
        value={form.pronouns}
        onChangeText={set('pronouns')}
        maxLength={FIXED_LIMITS.pronouns}
        error={errors.pronouns}
        editable={!locked}
        testID="edit-pronouns"
      />
      <TextField
        label="Location"
        value={form.location}
        onChangeText={set('location')}
        maxLength={FIXED_LIMITS.location}
        error={errors.location}
        editable={!locked}
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
        editable={!locked}
        testID="edit-website"
      />
      <TextField
        label="Banner image link"
        value={form.bannerUri}
        onChangeText={set('bannerUri')}
        maxLength={FIXED_LIMITS.banner}
        error={errors.bannerUri}
        placeholder="Paste an image link"
        keyboardType="url"
        autoCapitalize="none"
        autoCorrect={false}
        editable={!locked}
        testID="edit-banner"
      />
      <SwitchRow
        label="NSFW content"
        description="Mark your profile as containing adult content"
        value={form.nsfw}
        onValueChange={set('nsfw')}
        disabled={locked}
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
          gestureEnabled: (!dirty || unsure) && !saving,
          headerLeft: () => (
            <Button
              label={unsure ? 'Close' : 'Cancel'}
              variant="link"
              size="sm"
              onPress={() => router.back()}
              disabled={saving}
              testID="edit-cancel"
            />
          ),
          headerRight: () =>
            saving ? (
              <Spinner size="sm" testID="edit-saving" />
            ) : (
              <Button label="Save" size="sm" onPress={onSave} disabled={!canSave} testID="edit-save" />
            ),
        }}
      />
      <KeyboardAvoider avoidOnIOS>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="pb-12" testID="edit-profile">
          {unsure ? (
            <View accessibilityLiveRegion="polite" className="gap-1 px-4 py-3" testID="edit-unconfirmed">
              <Text variant="subhead" tone="secondary">
                {"Your changes haven't been confirmed yet. We'll keep checking."}
              </Text>
              {checking ? (
                <Spinner size="sm" testID="edit-checking" />
              ) : (
                <LinkText label="Check again" role="button" onPress={onCheck} testID="edit-check-again" />
              )}
            </View>
          ) : null}
          <ProfileBanner uri={form.bannerUri.trim() || undefined} height={120} />
          <View className="-mt-11 flex-row items-end gap-3 px-4">
            <Avatar avatar={avatarDtoOf(form.avatar, viewerId, defaultStyle)} identityId={viewerId} size="profile" />
            <Pressable
              accessibilityRole="button"
              onPress={() => setPickerOpen(true)}
              disabled={locked}
              className="mb-2 active:opacity-60"
              testID="edit-change-avatar"
            >
              <Text variant="subheadStrong" tone="link">
                Change avatar
              </Text>
            </Pressable>
          </View>
          {/* One list, whichever documents the fields live in (#20). */}
          <View className="gap-4 px-4 pt-6">
            {nameField}
            {bioField}
            {limits.dashpayProfile ? (
              <Text variant="caption" tone="secondary" className="-mt-2" testID="edit-dashpay-note">
                Your name and bio also show in other Dash apps, like DashPay.
              </Text>
            ) : null}
            {otherFields}
          </View>
        </ScrollView>
      </KeyboardAvoider>
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
  // A failed read keeps the cached copy: that is the retry state, not the form.
  if (profile.data && (fresh || (!profile.isFetching && !profile.isError))) {
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
          retrying={profile.isRetrying}
        />
      ) : (
        <View className="flex-1 items-center justify-center">
          <Spinner />
        </View>
      )}
    </Screen>
  );
}
