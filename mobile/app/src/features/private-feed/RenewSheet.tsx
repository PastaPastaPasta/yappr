import { useState } from 'react';
import { View } from 'react-native';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { sendWrite } from '~/data/writes';
import { cn } from '~/lib-allowlist';
import { Button } from '~/ui/Button';
import { RadioGroup } from '~/ui/RadioGroup';
import { Sheet } from '~/ui/Sheet';
import { Skeleton } from '~/ui/Skeleton';
import { Text } from '~/ui/Text';
import { tw } from '~/ui/tokens';

import { copy } from './copy';
import { renewWrite } from './private-feed-data';

export type RenewReason = keyof typeof copy.renew.intro;

/** Web `formatUsd`: dollars and cents, or "less than $0.01". */
export function formatUsd(usd: number): string {
  return usd < 0.01 ? 'less than $0.01' : `$${usd.toFixed(2)}`;
}

/**
 * Renew the private feed (web `RenewPrivateFeedDialog`, PF3, PF5, PF9): the
 * cost of moving the followers, and whether older private posts come along.
 * Without the old feed's secret on this phone there is no choice: older
 * posts stay with the people who already follow.
 */
function RenewBody({ reason, onClose }: { reason: RenewReason; onClose: () => void }) {
  const renewal = useEngineQuery(queryKeys.privateFeed.renewal, (api) => api.privateFeed.renewal(), { staleTime: 0 });
  const [choice, setChoice] = useState<'yes' | 'no' | null>(null);
  const data = renewal.data;
  const bringHistory = data?.canBringHistory === 'no' ? false : (choice ?? 'yes') === 'yes';

  return (
    <View className="gap-4 pb-2" testID="private-renew-sheet">
      <Text variant="headline" tone="emphasis" accessibilityRole="header">
        {copy.renew.title}
      </Text>
      <Text variant="body" tone="secondary">
        {copy.renew.intro[reason]}
      </Text>
      {renewal.isError ? (
        <View className="gap-2">
          <Text variant="subhead">{copy.renew.loadFailed}</Text>
          <Button label={copy.settings.tryAgain} variant="outline" size="sm" layoutStyle={{ alignSelf: 'flex-start' }} onPress={() => renewal.refetch()} />
        </View>
      ) : !data ? (
        <View className="gap-2" accessibilityLabel="Loading">
          <Skeleton height={48} />
          <Skeleton height={32} />
        </View>
      ) : (
        <>
          {data.canBringHistory === 'no' ? (
            <Text variant="subhead" tone="warning" testID="private-renew-history-break">
              {copy.renew.historyBreak}
            </Text>
          ) : (
            <View className="gap-1">
              <Text variant="subheadStrong">{copy.renew.historyQuestion}</Text>
              <RadioGroup
                accessibilityLabel={copy.renew.historyQuestion}
                options={[
                  { value: 'yes', title: copy.renew.historyYes, description: copy.renew.historyYesBody },
                  { value: 'no', title: copy.renew.historyNo, description: copy.renew.historyNoBody },
                ]}
                value={bringHistory ? 'yes' : 'no'}
                onChange={setChoice}
                testID="private-renew-history"
              />
            </View>
          )}
          <View className={cn('gap-1 rounded-xl p-3', tw.bgMuted)} testID="private-renew-cost">
            <Text variant="subheadStrong">{copy.renew.cost(data.followers, formatUsd(data.usd))}</Text>
            {data.followers > 0 ? (
              <Text variant="subhead" tone="secondary">
                {copy.renew.pause}
              </Text>
            ) : null}
          </View>
        </>
      )}
      <View className="flex-row justify-end gap-2">
        <Button label={copy.renew.cancel} variant="ghost" onPress={onClose} />
        <Button
          label={copy.renew.confirm}
          disabled={!data}
          onPress={() => {
            onClose();
            sendWrite(renewWrite, { bringHistory });
          }}
          testID="private-renew-confirm"
        />
      </View>
    </View>
  );
}

export function RenewSheet({ open, onClose, reason }: { open: boolean; onClose: () => void; reason: RenewReason }) {
  return (
    <Sheet open={open} onClose={onClose} scrollable={open} testID="private-renew">
      {open ? <RenewBody reason={reason} onClose={onClose} /> : null}
    </Sheet>
  );
}
