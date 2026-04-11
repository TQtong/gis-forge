// ============================================================
// terrain-drape-tile-cache.ts — LRU 双向链表缓存
// ============================================================

import {
  CACHE_MAX_ENTRIES,
  CACHE_MAX_BYTES,
  type TerrainDrapeTileEntry,
} from './types.ts';

export class TerrainDrapeTileCache {
  private _map = new Map<string, TerrainDrapeTileEntry>();
  private _head: TerrainDrapeTileEntry | null = null;
  private _tail: TerrainDrapeTileEntry | null = null;
  private _bytes = 0;
  private _onEvict: (e: TerrainDrapeTileEntry) => void;

  constructor(onEvict: (e: TerrainDrapeTileEntry) => void) {
    this._onEvict = onEvict;
  }

  get size(): number { return this._map.size; }
  get bytes(): number { return this._bytes; }

  has(key: string): boolean { return this._map.has(key); }

  get(key: string): TerrainDrapeTileEntry | undefined {
    const e = this._map.get(key);
    if (e !== undefined) { this._moveToTail(e); }
    return e;
  }

  peek(key: string): TerrainDrapeTileEntry | undefined {
    return this._map.get(key);
  }

  set(key: string, entry: TerrainDrapeTileEntry): void {
    const old = this._map.get(key);
    if (old !== undefined) {
      this._bytes -= old.byteSize;
      this._detach(old);
    }
    this._map.set(key, entry);
    this._bytes += entry.byteSize;
    this._appendToTail(entry);
    this._evict();
  }

  updateBytes(key: string, newSize: number): void {
    const e = this._map.get(key);
    if (e === undefined) { return; }
    this._bytes += newSize - e.byteSize;
    e.byteSize = newSize;
    this._evict();
  }

  clear(): void {
    for (const e of this._map.values()) { this._onEvict(e); }
    this._map.clear();
    this._head = null;
    this._tail = null;
    this._bytes = 0;
  }

  values(): IterableIterator<TerrainDrapeTileEntry> { return this._map.values(); }

  private _evict(): void {
    while (
      (this._map.size > CACHE_MAX_ENTRIES || this._bytes > CACHE_MAX_BYTES)
      && this._head !== null
    ) {
      const v = this._head;
      this._bytes -= v.byteSize;
      this._detach(v);
      this._map.delete(v.key);
      this._onEvict(v);
    }
  }

  private _moveToTail(e: TerrainDrapeTileEntry): void {
    if (e === this._tail) { return; }
    this._detach(e);
    this._appendToTail(e);
  }

  private _appendToTail(e: TerrainDrapeTileEntry): void {
    e.prev = this._tail;
    e.next = null;
    if (this._tail !== null) { this._tail.next = e; } else { this._head = e; }
    this._tail = e;
  }

  private _detach(e: TerrainDrapeTileEntry): void {
    if (e.prev !== null) { e.prev.next = e.next; }
    else if (this._head === e) { this._head = e.next; }
    if (e.next !== null) { e.next.prev = e.prev; }
    else if (this._tail === e) { this._tail = e.prev; }
    e.prev = null;
    e.next = null;
  }
}
