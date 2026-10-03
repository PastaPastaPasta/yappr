import licensesFile from '@assets/licenses.json';
import { useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { ChevronDownIcon } from 'react-native-heroicons/outline';

import { cn } from '~/lib-allowlist';
import { Text } from '~/ui/Text';
import { monoFont, tw, useColors } from '~/ui/tokens';

import { copy } from './copy';
import { SettingsHeader } from './SettingsList';

/** One shipped package (plugins/licenses/generate.js). `texts` index into the file's deduplicated `texts`. */
export interface LicensedPackage {
  name: string;
  version: string;
  license: string;
  texts: number[];
}

export interface LicensesFile {
  packages: LicensedPackage[];
  texts: string[];
}

/** Generated from the lockfiles at build time (`npm run licenses`, and every prebuild). */
export const licenses: LicensesFile = licensesFile;

function PackageRow({ pkg, texts }: { pkg: LicensedPackage; texts: readonly string[] }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const expandable = pkg.texts.length > 0;
  const id = `${pkg.name}@${pkg.version}`;
  return (
    <View className={cn('border-b', tw.border)}>
      <Pressable
        accessibilityRole={expandable ? 'button' : undefined}
        accessibilityState={expandable ? { expanded: open } : undefined}
        accessibilityLabel={`${pkg.name} ${pkg.version}, ${pkg.license}`}
        disabled={!expandable}
        onPress={() => setOpen((value) => !value)}
        testID={`license-${id}`}
        className={cn('min-h-14 flex-row items-center gap-3 px-4 py-2', tw.pressed)}
      >
        <View className="flex-1 gap-0.5">
          <Text variant="body" numberOfLines={2}>
            {pkg.name}
          </Text>
          <Text variant="subhead" tone="secondary">
            {`${pkg.version} · ${pkg.license}`}
          </Text>
        </View>
        {expandable ? (
          <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}>
            <ChevronDownIcon size={16} color={c.textSecondary} />
          </View>
        ) : null}
      </Pressable>
      {open ? (
        <View className="gap-4 px-4 pb-4" testID={`license-text-${id}`}>
          {pkg.texts.map((index) => (
            <Text key={index} variant="caption" tone="secondary" selectable style={monoFont}>
              {texts[index]}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * Settings → About → Open-source licenses (PRD SET-06): every third-party
 * package the app ships, with its license; a package that carries its
 * license text opens to show it. Native and offline.
 */
export function LicensesScreen() {
  return (
    <View className={cn('flex-1', tw.bg)}>
      <SettingsHeader title={copy.about.licenses} />
      <FlatList
        data={licenses.packages}
        keyExtractor={(pkg) => `${pkg.name}@${pkg.version}`}
        renderItem={({ item }) => <PackageRow pkg={item} texts={licenses.texts} />}
        contentInsetAdjustmentBehavior="automatic"
        initialNumToRender={20}
        testID="licenses-list"
      />
    </View>
  );
}
