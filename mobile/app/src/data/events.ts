import type {
  ContentCreatedEvent,
  DmEvents,
  EngineNotice,
  NotificationCountEvent,
  SessionEvents,
  WriteTicket,
} from '@engine/api';
import { useEffect, useRef } from 'react';

import { engine } from '~/engine';

/** Engine events (ENGINE.md §8) and their payloads. */
export interface EngineEventMap {
  'session.changed': SessionEvents['session.changed'];
  'session.keyRequired': SessionEvents['session.keyRequired'];
  /** Every write ticket transition. `src/data/writes.ts` already tracks them; screens rarely need this. */
  'write.status': WriteTicket;
  /** A post or reply this device published (the first part of a thread). */
  'content.created': ContentCreatedEvent;
  /** lib's toasts (`react-hot-toast` in the engine). */
  'engine.notice': EngineNotice;
  'notifications.count': NotificationCountEvent;
  'dm.changed': DmEvents['dm.changed'];
  'dm.message': DmEvents['dm.message'];
}

export type EngineEventName = keyof EngineEventMap;

/** Subscribe outside React. The subscription survives engine restarts; call the result to stop. */
export function onEngineEvent<E extends EngineEventName>(
  event: E,
  handler: (payload: EngineEventMap[E]) => void,
): () => void {
  return engine.on(event, (payload) => handler(payload as EngineEventMap[E]));
}

/**
 * Subscribe to an engine event for the component's lifetime. The handler
 * may change every render; the subscription doesn't.
 */
export function useEngineEvent<E extends EngineEventName>(
  event: E,
  handler: (payload: EngineEventMap[E]) => void,
): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => onEngineEvent(event, (payload) => latest.current(payload)), [event]);
}
