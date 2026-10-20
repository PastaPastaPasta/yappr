import type {
  ItemSaveInput, PlaceOrderInput, ReviewInput, StatusUpdateInput, StoreReportTarget, StoreSaveInput, WriteTicket, ZoneSaveInput,
} from '@engine/api';

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

export const saveStoreWrite: WriteSpec<StoreSaveInput> = {
  key: () => 'store:save',
  submit: (api, vars) => api.store.saveStore(vars),
  failureText: engineSentence,
  onRejected: sayRefusal,
  onConfirmed: () => refetch(queryKeys.store.all),
  failureMessage: ({ storeId }) => (storeId ? "Couldn't save your store. Try again." : "Couldn't create your store. Try again."),
};

export const saveItemWrite: WriteSpec<ItemSaveInput> = {
  key: ({ itemId }) => `store:item:${itemId ?? 'new'}`,
  submit: (api, vars) => api.store.saveItem(vars),
  failureText: engineSentence,
  onRejected: sayRefusal,
  onConfirmed: () => refetch(queryKeys.store.all),
  failureMessage: ({ archive, itemId }) =>
    archive ? "Couldn't remove this product. Try again." : itemId ? "Couldn't save this product. Try again." : "Couldn't add this product. Try again.",
};

export const saveZoneWrite: WriteSpec<ZoneSaveInput> = {
  key: ({ zoneId }) => `store:zone:${zoneId ?? 'new'}`,
  submit: (api, vars) => api.store.saveZone(vars),
  failureText: engineSentence,
  onRejected: sayRefusal,
  onConfirmed: () => refetch(queryKeys.store.all),
  failureMessage: ({ delete: removing }) => (removing ? "Couldn't delete this zone. Try again." : "Couldn't save this zone. Try again."),
};

export const placeOrderWrite: WriteSpec<PlaceOrderInput> = {
  key: ({ storeId }) => `store:order:${storeId}`,
  submit: (api, vars) => api.store.placeOrder(vars),
  failureText: engineSentence,
  onRejected: sayRefusal,
  onConfirmed: () => {
    refetch(queryKeys.store.cart());
    refetch(queryKeys.store.orders());
  },
  matches: (ticket, { storeId }) => ticket.op === 'store.order' && targetIdentity(ticket) !== null && storeId.length > 0,
  failureMessage: "Couldn't place your order. Nothing was charged. Try again.",
};

export const orderStatusWrite: WriteSpec<StatusUpdateInput> = {
  key: ({ orderId }) => `store:status:${orderId}`,
  submit: (api, vars) => api.store.updateOrderStatus(vars),
  failureText: engineSentence,
  onRejected: sayRefusal,
  onConfirmed: () => refetch(queryKeys.store.orders()),
  failureMessage: "Couldn't update this order. Try again.",
};

export const reviewWrite: WriteSpec<ReviewInput> = {
  key: ({ orderId }) => `store:review:${orderId}`,
  submit: (api, vars) => api.store.review(vars),
  failureText: engineSentence,
  onRejected: sayRefusal,
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
  failureText: engineSentence,
  onRejected: sayRefusal,
  onConfirmed: (ticket, { target }) => refetch(queryKeys.store.ownReport(target.targetId)),
  failureMessage: "Couldn't send your report. Try again.",
};

export const withdrawStoreReportWrite: WriteSpec<{ reportId: string; targetId: string }> = {
  key: ({ targetId }) => `store:report:${targetId}`,
  submit: (api, { reportId }) => api.store.withdrawReport(reportId),
  failureText: engineSentence,
  onRejected: sayRefusal,
  onConfirmed: (ticket, { targetId }) => refetch(queryKeys.store.ownReport(targetId)),
  failureMessage: "Couldn't withdraw your report. Try again.",
};
