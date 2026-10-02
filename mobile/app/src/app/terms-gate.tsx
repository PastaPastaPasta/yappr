import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { BackHandler, Pressable, ScrollView, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { ChevronDownIcon } from 'react-native-heroicons/outline';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useSession } from '~/data/session';
import { engineNetworkKey } from '~/engine';
import { signOutAccount } from '~/features/auth/accounts';
import { copy } from '~/features/auth/copy';
import { links, openInApp } from '~/features/auth/onboarding';
import { acceptTerms, COMMUNITY_RULES, TERMS_SUMMARY } from '~/features/auth/terms';
import { cn } from '~/lib-allowlist';
import { Button } from '~/ui/Button';
import { Text } from '~/ui/Text';
import { motion, tw, useColors } from '~/ui/tokens';


/**
 * UX_SPEC §4.7, PRD AUTH-09: every identity accepts the community rules,
 * with the zero-tolerance clause, before it can use the app. Not dismissible
 * by gesture or back; "Not now" signs the account out.
 */
export default function TermsGateScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { identityId, status } = useSession();
  const [rulesOpen, setRulesOpen] = useState(false);
  const [declining, setDeclining] = useState(false);
  // Leave once: "Not now" signs out, which would otherwise leave a second time below.
  const left = useRef(false);
  const leave = () => {
    if (left.current) return;
    left.current = true;
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  // Android back must not skip the gate.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);

  // Nothing to accept once nobody is signed in (signed out elsewhere, or the account switched away).
  useEffect(() => {
    if (status === 'signed-out' && !declining) leave();
  }, [status, declining]);

  const agree = () => {
    if (identityId) acceptTerms(engineNetworkKey, identityId);
    leave();
  };

  const notNow = async () => {
    if (!identityId) {
      leave();
      return;
    }
    setDeclining(true);
    try {
      await signOutAccount(identityId);
    } finally {
      setDeclining(false);
      leave();
    }
  };

  const toggleRules = () => {
    setRulesOpen((open) => !open);
  };

  return (
    <View className={cn('flex-1', tw.bg)} testID="terms-gate">
      <ScrollView contentContainerClassName="gap-5 px-6 pb-6" contentContainerStyle={{ paddingTop: insets.top + 24 }}>
        <Text variant="titleLarge" tone="emphasis" accessibilityRole="header">
          {copy.terms.title}
        </Text>
        <Text variant="body">{copy.terms.intro}</Text>
        <View className="gap-3">
          {TERMS_SUMMARY.map((rule) => (
            <View key={rule} className="flex-row gap-3">
              <View className="mt-2.5 h-1.5 w-1.5 rounded-full bg-yappr-500" />
              <Text variant="body" className="flex-1">
                {rule}
              </Text>
            </View>
          ))}
        </View>

        <View className={cn('overflow-hidden rounded-xl border', tw.border)}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: rulesOpen }}
            onPress={toggleRules}
            testID="terms-community-rules"
            className={cn('min-h-12 flex-row items-center px-4 py-3', tw.pressed)}
          >
            <Text variant="bodyStrong" className="flex-1">
              {copy.terms.communityRules}
            </Text>
            <View style={{ transform: [{ rotate: rulesOpen ? '180deg' : '0deg' }] }}>
              <ChevronDownIcon size={18} color={c.textSecondary} />
            </View>
          </Pressable>
          {rulesOpen ? (
            <Animated.View entering={FadeIn.duration(motion.base)} className={cn('gap-4 border-t px-4 py-4', tw.border)}>
              {COMMUNITY_RULES.map((rule) => (
                <View key={rule.title} className="gap-1">
                  <Text variant="subheadStrong">{rule.title}</Text>
                  <Text variant="subhead" tone="secondary">
                    {rule.body}
                  </Text>
                </View>
              ))}
            </Animated.View>
          ) : null}
        </View>

        <View className="flex-row flex-wrap items-center">
          <Button label={copy.terms.termsOfUse} variant="link" size="sm" onPress={() => openInApp(links.terms)} />
          <Text variant="caption" tone="secondary" importantForAccessibility="no" accessibilityElementsHidden>
            ·
          </Text>
          <Button
            label={copy.terms.privacyPolicy}
            variant="link"
            size="sm"
            onPress={() => openInApp(links.privacy)}
          />
        </View>
      </ScrollView>

      <View className={cn('gap-2 border-t px-6 pt-3', tw.border)} style={{ paddingBottom: Math.max(insets.bottom, 16) }}>
        <Button label={copy.terms.agree} size="block" disabled={declining} onPress={agree} testID="terms-agree" />
        <Button
          label={copy.terms.notNow}
          variant="ghost"
          size="block"
          loading={declining}
          onPress={() => {
            notNow().catch(() => undefined);
          }}
          testID="terms-not-now"
        />
      </View>
    </View>
  );
}
