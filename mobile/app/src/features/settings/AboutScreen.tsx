import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useState } from 'react';
import { Platform, View } from 'react-native';
import {
  ArrowTopRightOnSquareIcon,
  CodeBracketIcon,
  DocumentTextIcon,
  GlobeAltIcon,
  LifebuoyIcon,
  LockClosedIcon,
  ShieldCheckIcon,
  UserGroupIcon,
} from 'react-native-heroicons/outline';

import icon from '@assets/images/icon.png';

import { config } from '~/config';
import { useEngineStatus } from '~/engine/hooks';
import { COMMUNITY_RULES } from '~/features/auth/terms';
import { Sheet } from '~/ui/Sheet';
import { Text } from '~/ui/Text';
import { colors, useColors } from '~/ui/tokens';

import { copy } from './copy';
import { appVersion, emailSupport, links, openInApp, SUPPORT_EMAIL } from './links';
import { SettingsGroup, SettingsHeader, SettingsRow, SettingsScroll } from './SettingsList';

const ios = Platform.OS === 'ios';

/** An external page: opens in the in-app browser, with the "opens elsewhere" mark. */
function ExternalMark() {
  const c = useColors();
  return <ArrowTopRightOnSquareIcon size={16} color={c.textDisabled} />;
}

/**
 * The bundled community-rules summary (PRD SET-07, AUTH-09), readable offline.
 * It scrolls, so large text or a short landscape screen still reaches every rule.
 */
function RulesSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title={copy.about.rules} scrollable testID="about-rules-sheet">
      <View className="gap-3 pb-2">
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
    </Sheet>
  );
}

/**
 * The full community rules (PRD SET-07), the text the terms gate shows under
 * "Community rules". Bundled: yap.pr has no rules page yet (COMPLIANCE C4).
 */
function CommunityRulesSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title={copy.about.communityRules} scrollable testID="about-community-rules-sheet">
      <View className="gap-4 pb-2">
        {COMMUNITY_RULES.map((rule) => (
          <View key={rule.title} className="gap-1">
            <Text variant="bodyStrong">{rule.title}</Text>
            <Text variant="body" tone="secondary">
              {rule.body}
            </Text>
          </View>
        ))}
      </View>
    </Sheet>
  );
}

/** Settings → About (UX_SPEC §4.31; PRD SET-06, SET-07). */
export function AboutScreen() {
  const status = useEngineStatus();
  const [sheet, setSheet] = useState<'rules' | 'summary' | null>(null);
  const closeSheet = () => setSheet(null);
  const evoSdk = status.info?.evoSdkVersion ?? config.engine?.evoSdkVersion;
  const bundle = (status.hello?.bundleHash ?? config.engine?.bundleHash)?.slice(0, 8);
  const engineLine = [evoSdk ? `evo-sdk ${evoSdk}` : null, bundle].filter(Boolean).join(' · ');

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
        <SettingsRow label={copy.about.version} value={appVersion} testID="about-version" />
        <SettingsRow label={copy.about.network} value={config.network} testID="about-network" />
        {engineLine ? <SettingsRow label={copy.about.engine} value={engineLine} testID="about-engine" /> : null}
        {config.commit ? (
          <SettingsRow label={copy.about.commit} value={config.commit.slice(0, 8)} testID="about-commit" />
        ) : null}
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
          onPress={() => setSheet('rules')}
          testID="about-community-rules"
        />
        <SettingsRow
          label={copy.about.rules}
          icon={UserGroupIcon}
          iconTint={colors.amber500}
          onPress={() => setSheet('summary')}
          testID="about-rules"
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

      <Text variant="caption" tone="secondary" className="px-4 pt-8 text-center">
        {copy.about.poweredBy}
      </Text>

      <CommunityRulesSheet open={sheet === 'rules'} onClose={closeSheet} />
      <RulesSheet open={sheet === 'summary'} onClose={closeSheet} />
    </SettingsScroll>
  );
}
