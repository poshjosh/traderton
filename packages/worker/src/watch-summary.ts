// Watch-summary block relocated verbatim from the worker's runtime-composition.ts
// (whose platform body is not part of the mechanical trading loop / 9a tool surface).
// This self-contained closure — MAX_ACTIVE_WATCHES_IN_CONTEXT, MAX_ACTIVE_WATCH_NOTE_CHARS,
// watchPriority, compareWatchEntries, watchSummaryKey, mergeWatchEntry, formatWatchNote,
// formatWatchStatus, summarizeActiveWatches — operates only on RuntimeActiveWatch /
// RuntimeActiveWatchSummary (both in ./scan-types.js). The watch tool (tools/watch.ts)
// imports summarizeActiveWatches from here. Relocation seam only — no logic authored here.
import type { RuntimeActiveWatch, RuntimeActiveWatchSummary } from './scan-types.js';

const MAX_ACTIVE_WATCHES_IN_CONTEXT = 10;
const MAX_ACTIVE_WATCH_NOTE_CHARS = 40;

function watchPriority(watch: RuntimeActiveWatch): number {
  if (watch.lastConditionMet === true) {
    return 0;
  }
  if (watch.lastConditionMet === null) {
    return 1;
  }
  return 2;
}

function compareWatchEntries(left: RuntimeActiveWatch, right: RuntimeActiveWatch): number {
  return watchPriority(left) - watchPriority(right)
    || left.chain.localeCompare(right.chain)
    || left.symbol.localeCompare(right.symbol)
    || left.condition.localeCompare(right.condition)
    || left.thresholdPrice - right.thresholdPrice;
}

function watchSummaryKey(watch: RuntimeActiveWatch): string {
  return JSON.stringify([
    watch.chain,
    watch.symbol,
    watch.condition,
    watch.thresholdPrice,
  ]);
}

function mergeWatchEntry(existing: { watch: RuntimeActiveWatch; count: number }, incoming: RuntimeActiveWatch): void {
  existing.count += 1;

  const existingPriority = watchPriority(existing.watch);
  const incomingPriority = watchPriority(incoming);

  if (incomingPriority < existingPriority) {
    existing.watch = {
      ...incoming,
      note: incoming.note ?? existing.watch.note,
      lastCheckedAt: incoming.lastCheckedAt ?? existing.watch.lastCheckedAt,
    };
    return;
  }

  if (!existing.watch.note && incoming.note) {
    existing.watch = {
      ...existing.watch,
      note: incoming.note,
    };
  }

  if (!existing.watch.lastCheckedAt && incoming.lastCheckedAt) {
    existing.watch = {
      ...existing.watch,
      lastCheckedAt: incoming.lastCheckedAt,
    };
  }
}

function formatWatchNote(note: string | undefined): string {
  if (!note) {
    return '';
  }

  const compactNote = note.replace(/\s+/g, ' ').trim();
  if (compactNote.length <= MAX_ACTIVE_WATCH_NOTE_CHARS) {
    return compactNote;
  }

  return `${compactNote.slice(0, MAX_ACTIVE_WATCH_NOTE_CHARS - 1)}…`;
}

function formatWatchStatus(lastConditionMet: boolean | null): string {
  if (lastConditionMet === true) {
    return 'met';
  }
  if (lastConditionMet === false) {
    return 'not_met';
  }
  return 'unknown';
}

export function summarizeActiveWatches(watches: RuntimeActiveWatch[]): RuntimeActiveWatchSummary {
  const grouped = new Map<string, { watch: RuntimeActiveWatch; count: number }>();

  for (const watch of watches) {
    const key = watchSummaryKey(watch);
    const existing = grouped.get(key);
    if (existing) {
      mergeWatchEntry(existing, watch);
      continue;
    }
    grouped.set(key, { watch, count: 1 });
  }

  const orderedGroups = [...grouped.values()].sort((left, right) => compareWatchEntries(left.watch, right.watch));
  const visibleGroups = orderedGroups.slice(0, MAX_ACTIVE_WATCHES_IN_CONTEXT);
  const overflowCount = Math.max(0, orderedGroups.length - visibleGroups.length);

  return {
    totalCount: watches.length,
    uniqueCount: grouped.size,
    overflowCount,
    lines: visibleGroups.map(({ watch, count }) => {
      const status = formatWatchStatus(watch.lastConditionMet);
      const countSuffix = count > 1 ? ` x${count}` : '';
      const noteSuffix = formatWatchNote(watch.note);
      const noteSegment = noteSuffix ? ` — ${noteSuffix}` : '';
      const purposePrefix = watch.purpose?.trim() ? `[${watch.purpose}] ` : '';
      return `${purposePrefix}${watch.symbol} (${watch.chain}) ${watch.condition} $${watch.thresholdPrice} status=${status}${countSuffix}${noteSegment}`;
    }),
  };
}
