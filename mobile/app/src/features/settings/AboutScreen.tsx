import * as Clipboard from 'expo-clipboard';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import {
  ArrowTopRightOnSquareIcon,
  CodeBracketIcon,
  DocumentTextIcon,
  GlobeAltIcon,
  LifebuoyIcon,
  LockClosedIcon,
  PaperAirplaneIcon,
  ShieldCheckIcon,
} from 'react-native-heroicons/outline';

import icon from '@assets/images/icon.png';

import { config } from '~/config';
import { useEngineStatus } from '~/engine/hooks';
import { appendLog, errorMessage } from '~/engine/logs';
import { COMMUNITY_RULES } from '~/features/auth/terms';
import { cn } from '~/lib-allowlist';
import { Sheet } from '~/ui/Sheet';
import { Text } from '~/ui/Text';
import { toast } from '~/ui/toast';
import { colors, tw, useColors } from '~/ui/tokens';

import { copy } from './copy';
import { appVersion, buildDetails, emailSupport, links, openInApp, SUPPORT_EMAIL } from './links';
import { sendDiagnostics } from './send-diagnostics';
import { SettingsGroup, SettingsHeader, SettingsRow, SettingsScroll } from './SettingsList';

const ios = Platform.OS === 'ios';

/** An external page: opens in the in-app browser, with the "opens elsewhere" mark. */
function ExternalMark() {
  const c = useColors();
  return <ArrowTopRightOnSquareIcon size={16} color={c.textDisabled} />;
}

/**
 * The community rules (PRD SET-07, AUTH-09), bundled and readable offline:
 * the summary the terms gate shows first, then the full rules it expands
 * under "Community rules". yap.pr has no rules page yet (COMPLIANCE C4). It
 * scrolls, so large text or a short landscape screen still reaches every rule.
 */
function CommunityRulesSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title={copy.about.communityRules} scrollable testID="about-community-rules-sheet">
      <View className="gap-6 pb-2">
        <View className="gap-3" testID="about-rules-summary">
          <Text variant="body">{copy.about.rulesIntro}</Text>
          {copy.about.rulesSummary.map((rule) => (
            <View key={rule} className="flex-row gap-2">
              <Text variant="body" tone="secondary">
                •
              </Text>
              <Text variant="body" className="flex-1">
                {rule}
              </Text>
            </View>
          ))}
        </View>
        <View className="gap-4">
          {COMMUNITY_RULES.map((rule) => (
            <View key={rule.title} className="gap-1">
              <Text variant="bodyStrong">{rule.title}</Text>
              <Text variant="body" tone="secondary">
                {rule.body}
              </Text>
            </View>
          ))}
        </View>
      </View>
    </Sheet>
  );
}

/**
 * The muted last row: the diagnostics screen (PRD SET-08), for support. It
 * stays reachable in release builds and signed out; nothing else links it.
 */
function TroubleshootingRow() {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copy.sections.diagnostics}
      onPress={() => router.push('/settings/diagnostics')}
      testID="settings-diagnostics"
      className={cn('mt-8 min-h-11 items-center justify-center px-4', tw.pressed)}
    >
      <Text variant="subhead" tone="secondary">
        {copy.sections.diagnostics}
      </Text>
    </Pressable>
  );
}

/** Settings → About (UX_SPEC §4.31; PRD SET-06, SET-07). */
export function AboutScreen() {
  const { info } = useEngineStatus();
  const [rulesOpen, setRulesOpen] = useState(false);
  const copyBuildDetails = () => {
    Clipboard.setStringAsync(buildDetails(info?.evoSdkVersion ?? config.engine?.evoSdkVersion))
      .then(() => toast.success(copy.about.versionCopied))
      .catch((error: unknown) => appendLog('warn', 'host', `Copying the version failed: ${errorMessage(error)}`));
  };

  return (
    <SettingsScroll testID="about-settings">
      <SettingsHeader title={copy.sections.about} />

      <View className="items-center gap-1 px-8 pt-8" accessible accessibilityLabel={`${copy.about.name}. ${copy.about.tagline}. ${copy.about.version} ${appVersion}`}>
        <Image source={icon} style={{ width: 64, height: 64, borderRadius: 14 }} accessible={false} />
        <Text variant="title" tone="emphasis" className="pt-2">
          {copy.about.name}
        </Text>
        <Text variant="subhead" tone="secondary" className="text-center">
          {copy.about.tagline}
        </Text>
      </View>

      <SettingsGroup>
        <SettingsRow
          label={copy.about.version}
          value={appVersion}
          chevron={false}
          onLongPress={copyBuildDetails}
          testID="about-version"
        />
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow
          label={copy.about.terms}
          icon={DocumentTextIcon}
          iconTint={colors.gray500}
          accessibilityRole="link"
          trailing={<ExternalMark />}
          onPress={() => openInApp(links.terms)}
          testID="about-terms"
        />
        <SettingsRow
          label={copy.about.privacy}
          icon={LockClosedIcon}
          iconTint={colors.gray500}
          accessibilityRole="link"
          trailing={<ExternalMark />}
          onPress={() => openInApp(links.privacy)}
          testID="about-privacy"
        />
        <SettingsRow
          label={copy.about.communityRules}
          icon={ShieldCheckIcon}
          iconTint={colors.amber500}
          onPress={() => setRulesOpen(true)}
          testID="about-community-rules"
        />
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow
          label={copy.about.support}
          value={SUPPORT_EMAIL}
          icon={LifebuoyIcon}
          iconTint={colors.green500}
          chevron={false}
          onPress={() => {
            emailSupport().catch(() => undefined);
          }}
          testID="about-support"
        />
        <SettingsRow
          label={copy.about.sendDiagnostics}
          icon={PaperAirplaneIcon}
          iconTint={colors.gray500}
          chevron={false}
          onPress={() => {
            sendDiagnostics().catch((error: unknown) =>
              appendLog('warn', 'host', `Sending diagnostics failed: ${errorMessage(error)}`),
            );
          }}
          testID="about-send-diagnostics"
        />
        <SettingsRow
          label={copy.about.licenses}
          icon={CodeBracketIcon}
          iconTint={colors.gray700}
          onPress={() => router.push('/settings/licenses')}
          testID="about-licenses"
        />
        <SettingsRow
          label={copy.about.web}
          value={ios ? undefined : links.web.replace('https://', '')}
          icon={GlobeAltIcon}
          iconTint={colors.yappr500}
          accessibilityRole="link"
          trailing={<ExternalMark />}
          onPress={() => openInApp(links.web)}
          testID="about-web"
        />
      </SettingsGroup>

      <TroubleshootingRow />

      <CommunityRulesSheet open={rulesOpen} onClose={() => setRulesOpen(false)} />
    </SettingsScroll>
  );
}
