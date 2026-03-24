import { create } from 'zustand';
import type { Annotation, Bookmark } from '@/types';

/** localStorage key for persisted bookmarks (annotations are session-only). */
const BOOKMARKS_STORAGE_KEY = 'geoforge:bookmarks';

/**
 * Loads bookmark array from `localStorage`; returns empty array on parse errors or missing data.
 *
 * @returns Parsed bookmarks or `[]`.
 */
function loadBookmarksFromStorage(): Bookmark[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(BOOKMARKS_STORAGE_KEY);
    if (!raw || raw.trim() === '') {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((b): b is Bookmark => {
      return (
        typeof b === 'object' &&
        b !== null &&
        typeof (b as Bookmark).id === 'string' &&
        typeof (b as Bookmark).name === 'string'
      );
    });
  } catch {
    return [];
  }
}

/**
 * Persists bookmarks to `localStorage` (no-op on server or quota errors).
 *
 * @param bookmarks - Full bookmark list to serialize.
 */
function saveBookmarksToStorage(bookmarks: Bookmark[]): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify(bookmarks));
  } catch {
    /* Quota or private mode: ignore persistence failure. */
  }
}

/**
 * Map document bookmarks and user/analysis annotations.
 */
interface AnnotationState {
  /** Saved view bookmarks (persisted). */
  bookmarks: Bookmark[];
  /** Drawn shapes and measurements (session). */
  annotations: Annotation[];
  /** Appends or replaces a bookmark; persists. */
  addBookmark: (b: Bookmark) => void;
  /** Removes a bookmark by id; persists. */
  removeBookmark: (id: string) => void;
  /** Shallow-merges fields into an existing bookmark; persists. */
  updateBookmark: (id: string, patch: Partial<Bookmark>) => void;
  /** Appends an annotation. */
  addAnnotation: (a: Annotation) => void;
  /** Removes one annotation by id. */
  removeAnnotation: (id: string) => void;
  /** Clears all annotations (does not touch bookmarks). */
  clearAnnotations: () => void;
}

/**
 * Zustand store: bookmarks (persisted) and annotations (in-memory).
 */
export const useAnnotationStore = create<AnnotationState>((set) => ({
  bookmarks: loadBookmarksFromStorage(),
  annotations: [],
  addBookmark: (b) =>
    set((s) => {
      const next = [...s.bookmarks.filter((x) => x.id !== b.id), b];
      saveBookmarksToStorage(next);
      return { bookmarks: next };
    }),
  removeBookmark: (id) =>
    set((s) => {
      const next = s.bookmarks.filter((x) => x.id !== id);
      saveBookmarksToStorage(next);
      return { bookmarks: next };
    }),
  updateBookmark: (id, patch) =>
    set((s) => {
      const next = s.bookmarks.map((x) => (x.id === id ? { ...x, ...patch } : x));
      saveBookmarksToStorage(next);
      return { bookmarks: next };
    }),
  addAnnotation: (a) => set((s) => ({ annotations: [...s.annotations, a] })),
  removeAnnotation: (id) =>
    set((s) => ({ annotations: s.annotations.filter((x) => x.id !== id) })),
  clearAnnotations: () => set({ annotations: [] }),
}));
