import { create } from 'zustand';
import type { HistoryEntry } from '@/types';
import { MAX_HISTORY } from '@/utils/historyManager';

/**
 * Undo/redo stacks for map edits (max {@link MAX_HISTORY} undo entries).
 */
interface HistoryState {
  /** Newest entry is at the end of this array. */
  undoStack: HistoryEntry[];
  /** Entries popped by undo, awaiting redo. */
  redoStack: HistoryEntry[];
  /** True when `undoStack` is non-empty. */
  canUndo: boolean;
  /** True when `redoStack` is non-empty. */
  canRedo: boolean;
  /** Pushes an entry onto the undo stack and clears redo; caps length. */
  pushEntry: (entry: HistoryEntry) => void;
  /** Pops last undo entry and pushes it to redo; returns the undone entry. */
  undo: () => HistoryEntry | undefined;
  /** Pops last redo entry and pushes it back to undo; returns the redone entry. */
  redo: () => HistoryEntry | undefined;
  /** Clears both stacks. */
  clear: () => void;
}

/**
 * Syncs `canUndo` / `canRedo` flags from stack lengths.
 */
function flagsFromStacks(undoStack: HistoryEntry[], redoStack: HistoryEntry[]) {
  return {
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
  };
}

/**
 * Zustand store: bounded undo/redo for the shell.
 */
export const useHistoryStore = create<HistoryState>((set, get) => ({
  undoStack: [],
  redoStack: [],
  canUndo: false,
  canRedo: false,
  pushEntry: (entry) =>
    set((s) => {
      const merged = [...s.undoStack, entry];
      const undoStack =
        merged.length > MAX_HISTORY ? merged.slice(merged.length - MAX_HISTORY) : merged;
      return {
        undoStack,
        redoStack: [],
        ...flagsFromStacks(undoStack, []),
      };
    }),
  undo: () => {
    const { undoStack, redoStack } = get();
    if (undoStack.length === 0) {
      return undefined;
    }
    const entry = undoStack[undoStack.length - 1];
    const nextUndo = undoStack.slice(0, -1);
    const nextRedo = [...redoStack, entry];
    set({
      undoStack: nextUndo,
      redoStack: nextRedo,
      ...flagsFromStacks(nextUndo, nextRedo),
    });
    return entry;
  },
  redo: () => {
    const { undoStack, redoStack } = get();
    if (redoStack.length === 0) {
      return undefined;
    }
    const entry = redoStack[redoStack.length - 1];
    const nextRedo = redoStack.slice(0, -1);
    const nextUndo = [...undoStack, entry];
    set({
      undoStack: nextUndo,
      redoStack: nextRedo,
      ...flagsFromStacks(nextUndo, nextRedo),
    });
    return entry;
  },
  clear: () =>
    set({
      undoStack: [],
      redoStack: [],
      canUndo: false,
      canRedo: false,
    }),
}));
