/**
 * The deletion sweep (docs/DM_V5.md §5.6): fee saving, not privacy.
 *
 * Per conversation, walk my own `prev` chain back from my newest message
 * (it crosses weeks and epochs, so no epoch is enumerated) and collect every
 * message in a tag week that lies entirely before the retention cutoff. The
 * collected deletes run oldest week first, in shuffled order across
 * conversations within a week. The oldest surviving own message is cached per
 * conversation so later sweeps stop there.
 */

import { weekOf } from '@/lib/dm/kdf'
import { isStrictlyBefore } from '@/lib/dm/stream'
import type { MessagePointer } from '@/lib/dm/types'
import { logger } from '@/lib/logger'
import { newestOwn, type Conv } from './conversation'
import type { DmContext } from './context'
import { backfill } from './poller'
import { DAY_MS, RETENTION_MS, comparePointers, groupBy, pointerKey, runNow, shuffled, type Exclusive } from './util'

/** One sweep a day is plenty: retention is measured in whole weeks. */
export const SWEEP_INTERVAL_MS = DAY_MS
const MAX_WALK = 5_000

export interface SweepTarget {
  conv: Conv
  pointer: MessagePointer
  docId: string
}

/**
 * The first tag week the sweep keeps. Week `w` spans `[weekStart(w),
 * weekStart(w + 1))`, so it lies entirely before the cutoff `now − retention`
 * exactly when `w < weekOf(cutoff)`. On the 30-day default a message lives 30
 * to 37 days. Null when retention is "never".
 */
export function firstKeptWeek(now: number, retentionMs: number | null): number | null {
  if (retentionMs === null) return null
  const cutoff = now - retentionMs
  return cutoff > 0 ? weekOf(cutoff) : null
}

/**
 * Walk my own `prev` chain in one conversation, from my newest message back
 * to the cached oldest survivor, and collect what the sweep deletes. A link
 * not held yet is fetched with the backfill walk (100 tags per query).
 */
export async function collectSweepTargets(ctx: DmContext, conv: Conv, keepFrom: number): Promise<{ targets: SweepTarget[]; oldestSurvivor: MessagePointer | null }> {
  const targets: SweepTarget[] = []
  const stopAt = ctx.cache.oldestOwn(conv.key)
  let pointer: MessagePointer | null = newestOwn(conv, ctx.me.id)?.pointer ?? null
  let oldestSurvivor: MessagePointer | null = null
  for (let steps = 0; pointer && steps < MAX_WALK; steps++) {
    const current: MessagePointer = pointer
    let held = conv.held.get(pointerKey(ctx.me.id, current))
    if (!held) {
      await backfill(ctx, conv, ctx.me.id, current, { full: true, horizon: conv.entry.since })
      held = conv.held.get(pointerKey(ctx.me.id, current))
      if (!held) break
    }
    if (current.w < keepFrom) targets.push({ conv, pointer: current, docId: held.docId })
    else oldestSurvivor = current
    if (stopAt && comparePointers(current, stopAt) <= 0) break
    if (!held.prev || !isStrictlyBefore(held.prev, current)) break
    pointer = held.prev
  }
  return { targets, oldestSurvivor }
}

/** Order the deletes: oldest week first, shuffled across conversations within each week. */
export function orderTargets(targets: SweepTarget[]): SweepTarget[] {
  const byWeek = groupBy(targets, (target) => target.pointer.w)
  return Array.from(byWeek.keys())
    .sort((a, b) => a - b)
    .flatMap((w) => shuffled(byWeek.get(w) ?? []))
}

export interface SweepPlan {
  /** Deletes in order: oldest week first, shuffled across conversations within a week. */
  targets: SweepTarget[]
  /** Each conversation's oldest surviving own message, cached once its deletes all succeed. */
  survivors: Map<Conv, MessagePointer>
}

/** Plan a sweep: walk every conversation's own `prev` chain, one conversation per queued task. */
export async function planSweep(ctx: DmContext, exclusive: Exclusive = runNow): Promise<SweepPlan> {
  const plan: SweepPlan = { targets: [], survivors: new Map() }
  const keepFrom = firstKeptWeek(ctx.chain.now(), RETENTION_MS[ctx.store.state.settings.retention])
  if (keepFrom === null) return plan
  for (const conv of Array.from(ctx.convs.values())) {
    try {
      const { targets, oldestSurvivor } = await exclusive(() => collectSweepTargets(ctx, conv, keepFrom))
      plan.targets.push(...targets)
      if (oldestSurvivor) plan.survivors.set(conv, oldestSurvivor)
    } catch (error) {
      logger.warn('DM v5 sweep: walking a conversation failed:', error)
    }
  }
  plan.targets = orderTargets(plan.targets)
  return plan
}

/** Delete one planned message. Returns true when it was deleted. */
async function deleteTarget(ctx: DmContext, target: SweepTarget): Promise<boolean> {
  const outcome = await ctx.chain.deleteMessage(target.docId)
  if (!outcome.ok) {
    logger.warn('DM v5 sweep: delete refused:', outcome.error)
    return false
  }
  target.conv.held.delete(pointerKey(ctx.me.id, target.pointer))
  return true
}

/**
 * Record where the next sweep may stop: a conversation's oldest survivor is
 * cached only when every delete below it succeeded, so a refused or skipped
 * delete is retried next time instead of being hidden behind the cache.
 */
function commitSweep(ctx: DmContext, plan: SweepPlan, failed: Set<Conv>): void {
  for (const [conv, survivor] of Array.from(plan.survivors.entries())) {
    if (!failed.has(conv)) ctx.cache.setOldestOwn(conv.key, survivor)
  }
  ctx.cache.lastSweep = ctx.chain.now()
}

/**
 * Run one whole sweep: plan, then delete one message per `exclusive` task
 * (each is a write). A cancelled sweep stops without recording survivors.
 * Returns the number of messages deleted.
 */
export async function sweep(ctx: DmContext, exclusive: Exclusive = runNow, cancelled: () => boolean = () => false): Promise<number> {
  const plan = await planSweep(ctx, exclusive)
  const failed = new Set<Conv>()
  let deleted = 0
  for (const target of plan.targets) {
    if (cancelled()) return deleted
    if (await exclusive(() => deleteTarget(ctx, target))) deleted++
    else failed.add(target.conv)
  }
  commitSweep(ctx, plan, failed)
  return deleted
}
