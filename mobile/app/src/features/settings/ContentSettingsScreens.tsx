import type { SettingsDTO } from '@engine/api';
import { router } from 'expo-router';
import { View } from 'react-native';

import { useCapabilities, useSession } from '~/data/session';
import { useAppearance } from '~/state/appearance';
import { ErrorState } from '~/ui/EmptyState';
import { selectionTick } from '~/ui/haptics';
import { RadioGroup } from '~/ui/RadioGroup';
import { Spinner } from '~/ui/Spinner';
import { SwitchRow } from '~/ui/Switch';

import { copy } from './copy';
import { SettingsGroup, SettingsHeader, SettingsPage, SettingsRow, SettingsScroll } from './SettingsList';
import { updateSettings, useSettings } from './settings-data';

const save = (patch: Parameters<typeof updateSettings>[0]) => {
  updateSettings(patch).catch(() => undefined);
};

/**
 * The settings while they load or after a failed read: a spinner, or the
 * error with a retry. Null once there are settings to show.
 */
function useSettingsGate(title: string) {
  const settings = useSettings();
  const data = settings.data;
  let gate = null;
  if (!data) {
    gate = (
      <SettingsPage>
        <SettingsHeader title={title} />
        {settings.isError ? (
          <ErrorState
            message={copy.loadFailed}
            onRetry={() => {
              settings.refetch().catch(() => undefined);
            }}
            testID="settings-error"
          />
        ) : (
          <View className="flex-1 items-center justify-center" testID="settings-loading">
            <Spinner />
          </View>
        )}
      </SettingsPage>
    );
  }
  return { data, gate };
}

/** Settings → Notifications (UX_SPEC §4.27; PRD SET-03, NOTIF-05): one switch per type. */
export function NotificationSettingsScreen() {
  const { data, gate } = useSettingsGate(copy.sections.notifications);
  if (!data) return gate;
  return (
    <SettingsScroll testID="notification-settings">
      <SettingsHeader title={copy.sections.notifications} />
      <SettingsGroup title={copy.notifications.header} footer={copy.notifications.note}>
        {copy.notifications.types.map((type) => (
          <SwitchRow
            key={type.key}
            label={type.label}
            description={type.description}
            value={data.notificationSettings[type.key]}
            onValueChange={(on) => save({ notificationSettings: { [type.key]: on } })}
            testID={`notification-toggle-${type.key}`}
          />
        ))}
      </SettingsGroup>
    </SettingsScroll>
  );
}

/**
 * Settings → Privacy & Safety (UX_SPEC §4.28; PRD SET-04, SAFE-06, SAFE-07).
 * Signed out it keeps the content settings; blocked accounts and read
 * receipts need an account.
 */
export function PrivacySettingsScreen() {
  const { signedIn } = useSession();
  const capabilities = useCapabilities();
  const { data, gate } = useSettingsGate(copy.sections.privacy);
  if (!data) return gate;
  return (
    <SettingsScroll testID="privacy-settings">
      <SettingsHeader title={copy.sections.privacy} />

      <SettingsGroup footer={copy.privacy.linkPreviewsNote}>
        <SwitchRow
          label={copy.privacy.linkPreviews}
          description={copy.privacy.linkPreviewsDescription}
          value={data.linkPreviewsEnabled}
          onValueChange={(on) => save({ linkPreviewsEnabled: on })}
          testID="privacy-link-previews"
        />
      </SettingsGroup>

      <SettingsGroup>
        <SwitchRow
          label={copy.privacy.mediaGate}
          description={copy.privacy.mediaGateDescription}
          value={data.gateMediaFromNonFollowed}
          onValueChange={(on) => save({ gateMediaFromNonFollowed: on })}
          testID="privacy-media-gate"
        />
      </SettingsGroup>

      <SettingsGroup title={copy.privacy.nsfw}>
        <RadioGroup<SettingsDTO['sensitiveContentMode']>
          options={copy.privacy.nsfwModes}
          value={data.sensitiveContentMode}
          onChange={(mode) => {
            if (mode !== data.sensitiveContentMode) save({ sensitiveContentMode: mode });
          }}
          accessibilityLabel={copy.privacy.nsfw}
          testID="privacy-nsfw"
        />
      </SettingsGroup>

      {signedIn ? (
        <SettingsGroup>
          <SettingsRow
            label={copy.privacy.blocked}
            onPress={() => router.push('/settings/blocked')}
            testID="privacy-blocked"
          />
        </SettingsGroup>
      ) : null}

      {/* Only legacy (v3) messages have read receipts; DM v5 has none (`capabilities.dm`). */}
      {signedIn && capabilities?.dm === 'legacy' ? (
        <SettingsGroup>
          <SwitchRow
            label={copy.privacy.readReceipts}
            description={copy.privacy.readReceiptsDescription}
            value={data.sendReadReceipts}
            onValueChange={(on) => save({ sendReadReceipts: on })}
            testID="privacy-read-receipts"
          />
        </SettingsGroup>
      ) : null}
    </SettingsScroll>
  );
}

/** A feed language's name, or its tag when web offers no such language. */
const languageName = (tag: string) => copy.appearance.languages.find((l) => l.value === tag)?.title ?? tag;

/**
 * Settings → Appearance (UX_SPEC §4.30; PRD SET-05): applies at once,
 * device-wide. "Feed language" only where posts carry a language (v2,
 * `capabilities.postLanguage`; PRD FEED-10).
 */
export function AppearanceSettingsScreen() {
  const theme = useAppearance((s) => s.theme);
  const setTheme = useAppearance((s) => s.setTheme);
  const capabilities = useCapabilities();
  const feedLanguage = useSettings().data?.feedLanguage;
  return (
    <SettingsScroll testID="appearance-settings">
      <SettingsHeader title={copy.sections.appearance} />
      <SettingsGroup title={copy.appearance.theme}>
        <RadioGroup
          options={copy.appearance.themes}
          value={theme}
          onChange={(next) => {
            if (next === theme) return;
            selectionTick();
            setTheme(next);
          }}
          accessibilityLabel={copy.appearance.theme}
          testID="appearance-theme"
        />
      </SettingsGroup>
      {capabilities?.postLanguage ? (
        <SettingsGroup>
          <SettingsRow
            label={copy.appearance.language}
            value={feedLanguage === undefined ? undefined : languageName(feedLanguage)}
            onPress={() => router.push('/settings/feed-language')}
            testID="appearance-feed-language"
          />
        </SettingsGroup>
      ) : null}
    </SettingsScroll>
  );
}

/**
 * Settings → Appearance → Feed language (UX_SPEC §4.30; PRD FEED-10): the
 * language For You reads, from the languages web offers. Saving it starts
 * For You over in that language.
 */
export function FeedLanguageSettingsScreen() {
  const { data, gate } = useSettingsGate(copy.appearance.language);
  if (!data) return gate;
  return (
    <SettingsScroll testID="feed-language-settings">
      <SettingsHeader title={copy.appearance.language} />
      <SettingsGroup footer={copy.appearance.languageNote}>
        <RadioGroup<string>
          options={copy.appearance.languages}
          value={data.feedLanguage}
          onChange={(language) => {
            if (language !== data.feedLanguage) save({ feedLanguage: language });
          }}
          accessibilityLabel={copy.appearance.language}
          testID="feed-language"
        />
      </SettingsGroup>
    </SettingsScroll>
  );
}
