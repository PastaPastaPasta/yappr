import type {
  ItemSaveInput, PlaceOrderInput, ReviewInput, StatusUpdateInput, StoreManageDTO, StoreReportTarget, StoreSaveInput, WriteTicket, ZoneSaveInput,
} from '@engine/api';

import { create } from 'zustand';

import { queryKeys } from '~/data/keys';
import { errorCode, type WriteSpec } from '~/data/writes';
import { queryClient } from '~/state/query-client';
import { errorFeedback } from '~/ui/haptics';
import { toast } from '~/ui/toast';

/**
 * The storefront's writes. A refusal the engine words itself (BAD_REQUEST:
 * the store closed, the cart changed, a field the contract refuses) shows its
 * own sentence; every other failure the write's.
 */
const engineSentence = (ticket: WriteTicket): string | null =>
  ticket.error?.code === 'BAD_REQUEST' && ticket.error.userMessage ? ticket.error.userMessage : null;

/** The engine refused the call with its own sentence (a field it checks): show that, not the generic one. */
const sayRefusal = (error: unknown): boolean => {
  if (errorCode(error) !== 'BAD_REQUEST' || !(error instanceof Error)) return false;
  errorFeedback();
  toast.error(error.message);
  return true;
};

const refetch = (key: readonly unknown[]) => {
  queryClient.invalidateQueries({ queryKey: key }).catch(() => undefined);
};

const targetIdentity = (ticket: WriteTicket) => (ticket.target && 'identityId' in ticket.target ? ticket.target.identityId : null);

/** What every storefront write shares: the engine's own sentence for a refusal. */
const refusals = { failureText: engineSentence, onRejected: sayRefusal };

/** A store create, while it may still land: "Create store" waits for it (one store per owner). */
export const STORE_CREATE_KEY = 'store:create';

/** After a create confirms, how long My store keeps reading until the owner's store shows (the read can lag the chain). */
export const STORE_SHOWS_RETRY_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000];

const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** Owners whose new store confirmed but whose My store read doesn't show it yet: it still reads as being created. */
export const useConfirmingStores = create<{ owners: ReadonlySet<string> }>()(() => ({ owners: new Set<string>() }));

const setConfirming = (owner: string | null, confirming: boolean) =>
  owner !== null && useConfirmingStores.setState(({ owners }) => {
    const next = new Set(owners);
    if (confirming) next.add(owner);
    else next.delete(owner);
    return { owners: next };
  });

/** Read My store again until it shows the new store, so a lagging read never offers "Create store" again. */
async function refetchUntilStoreShows(owner: string | null): Promise<void> {
  setConfirming(owner, true);
  try {
    for (const delay of [0, ...STORE_SHOWS_RETRY_MS]) {
      if (delay > 0) await pause(delay);
      await queryClient.refetchQueries({ queryKey: queryKeys.store.manage() });
      const manage = queryClient.getQueryData<StoreManageDTO>(queryKeys.store.manage());
      // No My store read to update (the screen is gone), or it shows the store: done.
      if (!manage || manage.store) return;
    }
  } finally {
    setConfirming(owner, false);
  }
}

export const saveStoreWrite: WriteSpec<StoreSaveInput> = {
  key: ({ storeId }) => (storeId ? 'store:save' : STORE_CREATE_KEY),
  submit: (api, vars) => api.store.saveStore(vars),
  ...refusals,
  onConfirmed: (ticket, { storeId }) => {
    if (storeId) refetch(queryKeys.store.all);
    else refetchUntilStoreShows(ticket.identityId).then(() => refetch(queryKeys.store.all)).catch(() => undefined);
  },
  failureMessage: ({ storeId }) => (storeId ? "Couldn't save your store. Try again." : "Couldn't create your store. Try again."),
};

export const saveItemWrite: WriteSpec<ItemSaveInput> = {
  key: ({ itemId }) => `store:item:${itemId ?? 'new'}`,
  submit: (api, vars) => api.store.saveItem(vars),
  ...refusals,
  onConfirmed: () => refetch(queryKeys.store.all),
  failureMessage: ({ archive, itemId }) =>
    archive ? "Couldn't remove this product. Try again." : itemId ? "Couldn't save this product. Try again." : "Couldn't add this product. Try again.",
};

export const saveZoneWrite: WriteSpec<ZoneSaveInput> = {
  key: ({ zoneId }) => `store:zone:${zoneId ?? 'new'}`,
  submit: (api, vars) => api.store.saveZone(vars),
  ...refusals,
  onConfirmed: () => refetch(queryKeys.store.all),
  failureMessage: ({ delete: removing }) => (removing ? "Couldn't delete this zone. Try again." : "Couldn't save this zone. Try again."),
};

export const placeOrderWrite: WriteSpec<PlaceOrderInput> = {
  key: ({ storeId }) => `store:order:${storeId}`,
  // One order per store's cart at a time, never queued: a second tap while the first may still land would order twice.
  serial: ({ storeId }) => `store:order:${storeId}`,
  submit: (api, vars) => api.store.placeOrder(vars),
  ...refusals,
  onConfirmed: () => {
    refetch(queryKeys.store.cart());
    refetch(queryKeys.store.orders());
  },
  matches: (ticket, { storeId }) => ticket.op === 'store.order' && targetIdentity(ticket) !== null && storeId.length > 0,
  failureMessage: "Couldn't place your order. Try again.",
};

export const orderStatusWrite: WriteSpec<StatusUpdateInput> = {
  key: ({ orderId }) => `store:status:${orderId}`,
  submit: (api, vars) => api.store.updateOrderStatus(vars),
  ...refusals,
  onConfirmed: () => refetch(queryKeys.store.orders()),
  failureMessage: "Couldn't update this order. Try again.",
};

export const reviewWrite: WriteSpec<ReviewInput> = {
  key: ({ orderId }) => `store:review:${orderId}`,
  submit: (api, vars) => api.store.review(vars),
  ...refusals,
  onConfirmed: () => refetch(queryKeys.store.all),
  failureMessage: "Couldn't post your review. Try again.",
};

export interface StoreReportVars {
  target: StoreReportTarget;
  reason: number;
  note: string;
}

export const storeReportWrite: WriteSpec<StoreReportVars> = {
  key: ({ target }) => `store:report:${target.targetId}`,
  submit: (api, { target, reason, note }) => api.store.report(target, reason, note),
  ...refusals,
  onConfirmed: (ticket, { target }) => refetch(queryKeys.store.ownReport(target.targetId)),
  failureMessage: "Couldn't send your report. Try again.",
};

export const withdrawStoreReportWrite: WriteSpec<{ reportId: string; targetId: string }> = {
  key: ({ targetId }) => `store:report:${targetId}`,
  submit: (api, { reportId }) => api.store.withdrawReport(reportId),
  ...refusals,
  onConfirmed: (ticket, { targetId }) => refetch(queryKeys.store.ownReport(targetId)),
  failureMessage: "Couldn't withdraw your report. Try again.",
};
