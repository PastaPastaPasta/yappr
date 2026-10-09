import { useNetInfo } from '@react-native-community/netinfo';
import { useState } from 'react';
import { View } from 'react-native';

import { config } from '~/config';
import { useEngineStatus } from '~/engine/hooks';
import { chipStateOf, NetworkChip, type EngineState as ChipState } from '~/ui/NetworkChip';
import { Sheet } from '~/ui/Sheet';
import { Text } from '~/ui/Text';

/** UX_SPEC §5.11 network.* */
export const networkCopy = {
  body: {
    devnet: 'Yappr is running on a Dash Platform devnet. Posts and accounts may be reset.',
    testnet: 'Yappr is running on Dash Platform Testnet. Posts and accounts may be reset.',
  } as Partial<Record<string, string>>,
  /** The connection line, in the chip's states: booting and restarting both read "Connecting…". */
  state: {
    ready: 'Connected',
    booting: 'Connecting…',
    unavailable: "Can't connect right now",
    offline: "You're offline",
  } satisfies Record<ChipState, string>,
};

/**
 * What every chip shows: the engine's state, unless the device itself is
 * offline (PRD G-1), which no engine state can hide (D-014). Unknown
 * connectivity, before NetInfo's first answer, counts as online.
 */
export function useChipState(): ChipState {
  const engine = chipStateOf(useEngineStatus().state);
  return useNetInfo().isConnected === false ? 'offline' : engine;
}

/**
 * The network sheet (UX_SPEC §4.34, PRD NET-07): the chip, what the network
 * means, and whether the app is connected. A bottom sheet, so swipe, the
 * scrim and Android Back close it. Troubleshooting lives in About, not here.
 */
export function NetworkSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const chipState = useChipState();
  const body = networkCopy.body[config.network];
  return (
    <Sheet open={open} onClose={onClose} testID="network-sheet">
      <NetworkChip network={config.network} state={chipState} testID="network-sheet-chip" />
      {body ? <Text variant="body">{body}</Text> : null}
      <Text variant="subhead" tone="secondary" testID="network-sheet-status">
        {networkCopy.state[chipState]}
      </Text>
    </Sheet>
  );
}

/** The network chip that opens the network sheet: Home's header and the Settings footer (UX_SPEC §2.17). */
export function NetworkChipButton() {
  const chipState = useChipState();
  const [open, setOpen] = useState(false);
  if (config.network === 'mainnet') return null;
  return (
    <View>
      <NetworkChip network={config.network} state={chipState} onPress={() => setOpen(true)} />
      <NetworkSheet open={open} onClose={() => setOpen(false)} />
    </View>
  );
}
