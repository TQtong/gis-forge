// ============================================================
// terrain-lru-cache.ts — 瓦片 LRU：双向链表 + 字节/条目双约束
// ============================================================

import { CACHE_MAX_BYTES, CACHE_MAX_ENTRIES, type TerrainCacheEntry } from './types.ts';

export class TerrainLRUCache {
  private _map = new Map<string, TerrainCacheEntry>();
  private _head: TerrainCacheEntry | null = null; // 最旧
  private _tail: TerrainCacheEntry | null = null; // 最新
  private _bytes = 0;
  private _maxBytes: number;
  private _maxEntries: number;
  private _onEvict: (e: TerrainCacheEntry) => void;

  constructor(
    onEvict: (e: TerrainCacheEntry) => void,
    maxEntries: number = CACHE_MAX_ENTRIES,
    maxBytes: number = CACHE_MAX_BYTES,
  ) {
    this._maxEntries = maxEntries;
    this._maxBytes = maxBytes;
    this._onEvict = onEvict;
  }

  get size(): number { return this._map.size; }
  get bytes(): number { return this._bytes; }

  has(key: string): boolean { return this._map.has(key); }
  get(key: string): TerrainCacheEntry | undefined {
    const e = this._map.get(key);
    if (e !== undefined) {
      this._moveToTail(e);
    }
    return e;
  }
  /** 读取但不触发 LRU 位置更新（用于 encode 时扫描祖先）。 */
  peek(key: string): TerrainCacheEntry | undefined {
    return this._map.get(key);
  }

  set(key: string, entry: TerrainCacheEntry): void {
    const existing = this._map.get(key);
    if (existing !== undefined) {
      this._bytes -= existing.byteSize;
      this._detach(existing);
    }
    this._map.set(key, entry);
    this._bytes += entry.byteSize;
    this._appendToTail(entry);
    this._evictUntilFits();
  }

  delete(key: string): boolean {
    const e = this._map.get(key);
    if (e === undefined) { return false; }
    this._bytes -= e.byteSize;
    this._detach(e);
    this._map.delete(key);
    return true;
  }

  updateBytes(key: string, newByteSize: number): void {
    const e = this._map.get(key);
    if (e === undefined) { return; }
    this._bytes += newByteSize - e.byteSize;
    e.byteSize = newByteSize;
    this._evictUntilFits();
  }

  clear(): void {
    for (const e of this._map.values()) {
      this._onEvict(e);
    }
    this._map.clear();
    this._head = null;
    this._tail = null;
    this._bytes = 0;
  }

  values(): IterableIterator<TerrainCacheEntry> { return this._map.values(); }

  /** 标记 pinned 的瓦片键集合（永不驱逐） */
  private _pinned = new Set<string>();

  /** 标记该键对应的瓦片为不可驱逐（如 z=0/1 根兜底） */
  pin(key: string): void {
    this._pinned.add(key);
  }

  private _evictUntilFits(): void {
    // 找 head 起第一个非 pinned 的受害者；若所有节点都 pinned 则停止
    while (
      (this._map.size > this._maxEntries || this._bytes > this._maxBytes)
    ) {
      let victim = this._head;
      while (victim !== null && this._pinned.has(victim.key)) {
        victim = victim.next;
      }
      if (victim === null) { break; }
      this._bytes -= victim.byteSize;
      this._detach(victim);
      this._map.delete(victim.key);
      this._onEvict(victim);
    }
  }

  private _moveToTail(e: TerrainCacheEntry): void {
    if (e === this._tail) { return; }
    this._detach(e);
    this._appendToTail(e);
  }

  private _appendToTail(e: TerrainCacheEntry): void {
    e.prev = this._tail;
    e.next = null;
    if (this._tail !== null) {
      this._tail.next = e;
    } else {
      this._head = e;
    }
    this._tail = e;
  }

  private _detach(e: TerrainCacheEntry): void {
    if (e.prev !== null) { e.prev.next = e.next; }
    else if (this._head === e) { this._head = e.next; }
    if (e.next !== null) { e.next.prev = e.prev; }
    else if (this._tail === e) { this._tail = e.prev; }
    e.prev = null;
    e.next = null;
  }
}
