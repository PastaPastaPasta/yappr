import { View } from 'react-native';
import { ClockIcon } from 'react-native-heroicons/outline';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { NO_READ_RETRY } from '~/data/read-retry';
import { useCapabilities } from '~/data/session';
import { cn, postingOpensText } from '~/lib-allowlist';
import { Text } from '~/ui/Text';
import { tw, useColors } from '~/ui/tokens';

/** How often the chain is asked again while posting is closed (the web banner's minute). */
const REFRESH_MS = 60_000;

const STRIP = cn('min-h-9 flex-row items-center gap-2 px-4 py-2', tw.offlineBg);

/**
 * A slim "Posting opens on <date>" strip for Home and Explore while the social
 * contract waits for its first moderation team (`capabilities.postingMayBeClosed`),
 * as on web. The engine reads the date from the chain; the strip goes away on
 * its own once a team is seated.
 *
 * The last answer is kept on the device, so a repeat visit paints in the first
 * frame. Before there is any answer a closed contract holds the strip's height
 * empty, so the feed below does not jump when it arrives; an open or unreadable
 * answer collapses it (once, ever).
 */
export function PostingOpensBanner() {
  const c = useColors();
  const mayBeClosed = useCapabilities()?.postingMayBeClosed === true;
  const { data, isError } = useEngineQuery(queryKeys.postingOpening, (api) => api.moderation.postingOpening(), {
    enabled: mayBeClosed,
    persist: true,
    meta: NO_READ_RETRY,
    // Keeps asking while posting is closed; stops for good once it is open.
    refetchInterval: (query) => (query.state.data?.kind === 'open' ? false : REFRESH_MS),
  });
  if (!mayBeClosed) return null;
  if (data === undefined) {
    return isError ? null : <View testID="posting-opens-placeholder" className="min-h-9" importantForAccessibility="no-hide-descendants" />;
  }
  const text = postingOpensText(data);
  if (!text) return null;
  return (
    <View accessible accessibilityRole="text" accessibilityLabel={text} testID="posting-opens-banner" className={STRIP}>
      <ClockIcon size={16} color={c.textPrimary} />
      <Text variant="subhead" className="shrink">
        {text}
      </Text>
    </View>
  );
}
