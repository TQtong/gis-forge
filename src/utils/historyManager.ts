import type { HistoryEntry, HistoryEntryKind } from '@/types';

/** Maximum number of history entries kept in the undo stack. */
export const MAX_HISTORY = 50;

/**
 * Creates a new history entry with a unique id and current timestamp.
 *
 * @param type - Entry category for undo UI and handlers.
 * @param description - Human-readable one-line summary.
 * @param data - Serializable payload for apply / reverse (engine-specific).
 * @returns A complete `HistoryEntry`.
 */
export function createHistoryEntry(
  type: HistoryEntryKind,
  description: string,
  data: unknown,
): HistoryEntry {
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `h-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  return {
    id,
    type,
    description,
    data,
    timestamp: Date.now(),
  };
}
