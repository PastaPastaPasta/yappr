import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { ChevronRightIcon, CpuChipIcon } from 'react-native-heroicons/outline';

import { config } from '~/config';
import { useEngineStatus } from '~/engine/hooks';
import type { EngineState as SupervisorState } from '~/engine/supervisor';
import { cn } from '~/lib-allowlist';
import { chipStateOf, NetworkChip } from '~/ui/NetworkChip';
import { Sheet } from '~/ui/Sheet';
import { Text } from '~/ui/Text';
import { tw, useColors } from '~/ui/tokens';

/** UX_SPEC §5.11 (web's network banner copy) and §5.10 diag.states / diag.title. */
export const networkCopy = {
  body: {
    devnet: 'Running on a Dash Platform devnet. Data may be reset.',
    testnet: 'Running on Dash Platform Testnet. Data may be reset.',
  } as Partial<Record<string, string>>,
  engine: (state: string) => `Engine: ${state}`,
  diagnostics: 'Engine diagnostics',
};

/**
 * The engine state line's word (UX_SPEC §5.10 diag.states): Booting / Ready /
 * Restarting / Unavailable. A degraded boot could not connect (PRD NET-01), as
 * the chip above it shows.
 */
export function engineStateWord(state: SupervisorState): string {
  if (state === 'ready') return 'Ready';
  if (state === 'crashed' || state === 'restarting') return 'Restarting';
  if (state === 'degraded' || state === 'failed' || state === 'unsupported') return 'Unavailable';
  return 'Booting';
}

/**
 * The network sheet (UX_SPEC §4.34, PRD NET-07): the chip, what the network
 * means, the engine's state, and the way to Engine diagnostics. A bottom
 * sheet, so swipe, the scrim and Android Back close it.
 */
export function NetworkSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const c = useColors();
  const { state } = useEngineStatus();
  const body = networkCopy.body[config.network];
  return (
    <Sheet open={open} onClose={onClose} testID="network-sheet">
      <NetworkChip network={config.network} state={chipStateOf(state)} testID="network-sheet-chip" />
      {body ? <Text variant="body">{body}</Text> : null}
      <Text variant="subhead" tone="secondary" testID="network-sheet-engine">
        {networkCopy.engine(engineStateWord(state))}
      </Text>
      <Pressable
        accessibilityRole="link"
        onPress={() => {
          onClose();
          router.push('/settings/diagnostics');
        }}
        testID="network-sheet-diagnostics"
        className={cn('-mx-5 min-h-12 flex-row items-center gap-3 px-5', tw.pressed)}
      >
        <CpuChipIcon size={20} color={c.textSecondary} />
        <Text variant="body" tone="link" className="flex-1">
          {networkCopy.diagnostics}
        </Text>
        <ChevronRightIcon size={16} color={c.textDisabled} />
      </Pressable>
    </Sheet>
  );
}

/** The network chip that opens the network sheet: Home's header and the Settings footer (UX_SPEC §2.17). */
export function NetworkChipButton() {
  const { state } = useEngineStatus();
  const [open, setOpen] = useState(false);
  if (config.network === 'mainnet') return null;
  return (
    <View>
      <NetworkChip network={config.network} state={chipStateOf(state)} onPress={() => setOpen(true)} />
      <NetworkSheet open={open} onClose={() => setOpen(false)} />
    </View>
  );
}
