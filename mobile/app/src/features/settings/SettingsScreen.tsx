import { router, type Href } from 'expo-router';
import { Platform, Pressable, View } from 'react-native';
import {
  ArrowRightEndOnRectangleIcon,
  BellIcon,
  ChevronRightIcon,
  CpuChipIcon,
  EnvelopeIcon,
  InformationCircleIcon,
  PaintBrushIcon,
  ShieldCheckIcon,
} from 'react-native-heroicons/outline';

import { config } from '~/config';
import { useCapabilities, useSession } from '~/data/session';
import { useEngineStatus } from '~/engine/hooks';
import type { EngineStatus } from '~/engine/supervisor';
import { cn } from '~/lib-allowlist';
import { useAppearance } from '~/state/appearance';
import { Avatar } from '~/ui/Avatar';
import { NetworkChip, type EngineState } from '~/ui/NetworkChip';
import { Text } from '~/ui/Text';
import { colors, tw, useColors } from '~/ui/tokens';

import { accountName } from './accounts';
import { copy, THEME_LABEL } from './copy';
import { formatDash } from './format';
import { versionLine } from './links';
import { SettingsGroup, SettingsHeader, SettingsRow, SettingsScroll } from './SettingsList';
import { useViewerProfile } from './use-viewer-profile';

const ios = Platform.OS === 'ios';

function chipState(state: EngineStatus['state']): EngineState {
  if (state === 'ready' || state === 'degraded') return 'ready';
  if (state === 'unsupported' || state === 'failed') return 'unavailable';
  return 'booting';
}

/** The account summary row: avatar, name, handle and balance (UX_SPEC §4.25). */
function AccountSummary() {
  const c = useColors();
  const { session } = useSession();
  const profile = useViewerProfile();
  if (!session) return null;
  const handle = accountName(session);
  const name = profile.data?.displayName ?? handle;
  const detail = `${handle} · ${formatDash(session.credits)}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${copy.sections.account}: ${name}, ${detail}`}
      onPress={() => router.push('/settings/account')}
      testID="settings-account"
      className={cn('min-h-[72px] flex-row items-center gap-3 px-4 py-3', tw.pressed)}
    >
      <Avatar avatar={profile.data?.avatar} identityId={session.identityId} size="lg" />
      <View className="flex-1 gap-0.5">
        <Text variant="bodyStrong" numberOfLines={1}>
          {name}
        </Text>
        <Text variant="subhead" tone="secondary" numberOfLines={1} tabular>
          {detail}
        </Text>
      </View>
      {ios ? <ChevronRightIcon size={16} color={c.textDisabled} strokeWidth={2.5} /> : null}
    </Pressable>
  );
}

/**
 * Settings (UX_SPEC §4.25, PRD SET-01). Signed out it keeps Privacy & Safety
 * (content settings), Appearance, About and Engine diagnostics, and offers
 * sign-in in place of the account.
 */
export function SettingsScreen() {
  const { signedIn, status } = useSession();
  const capabilities = useCapabilities();
  const engineStatus = useEngineStatus();
  const theme = useAppearance((s) => s.theme);
  const go = (href: Href) => () => router.push(href);

  return (
    <SettingsScroll testID="settings-root">
      <SettingsHeader title={copy.title} large />

      <SettingsGroup>
        {signedIn ? (
          <AccountSummary />
        ) : (
          <SettingsRow
            label={copy.signedOut.title}
            description={copy.signedOut.description}
            icon={ArrowRightEndOnRectangleIcon}
            iconTint={colors.yappr500}
            onPress={go('/sign-in')}
            // While the engine restores the session, the old account may still come back.
            disabled={status === 'unknown'}
            testID="settings-sign-in"
          />
        )}
      </SettingsGroup>

      <SettingsGroup>
        {signedIn ? (
          <SettingsRow
            label={copy.sections.notifications}
            icon={BellIcon}
            iconTint={colors.red500}
            onPress={go('/settings/notifications')}
            testID="settings-notifications"
          />
        ) : null}
        <SettingsRow
          label={copy.sections.privacy}
          icon={ShieldCheckIcon}
          iconTint={colors.green500}
          onPress={go('/settings/privacy')}
          testID="settings-privacy"
        />
        {signedIn && capabilities?.dm === 'v5' ? (
          <SettingsRow
            label={copy.sections.messages}
            icon={EnvelopeIcon}
            iconTint={colors.yappr500}
            onPress={go('/messages/settings')}
            testID="settings-messages"
          />
        ) : null}
        <SettingsRow
          label={copy.sections.appearance}
          value={THEME_LABEL[theme]}
          icon={PaintBrushIcon}
          iconTint={colors.purple500}
          onPress={go('/settings/appearance')}
          testID="settings-appearance"
        />
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow
          label={copy.sections.about}
          icon={InformationCircleIcon}
          iconTint={colors.gray500}
          onPress={go('/settings/about')}
          testID="settings-about"
        />
        <SettingsRow
          label={copy.sections.diagnostics}
          icon={CpuChipIcon}
          iconTint={colors.gray600}
          onPress={go('/settings/diagnostics')}
          testID="settings-diagnostics"
        />
      </SettingsGroup>

      <View className="items-center gap-2 px-4 pt-8" testID="settings-version">
        {/* The chip aligns itself to the start; this row centers it. */}
        <View className="flex-row justify-center">
          <NetworkChip network={config.network} state={chipState(engineStatus.state)} />
        </View>
        <Text variant="caption" tone="secondary" selectable>
          {versionLine}
        </Text>
      </View>
    </SettingsScroll>
  );
}
