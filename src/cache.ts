import type { SessionUsageData } from '@tokentop/plugin-sdk';
import type { SessionFileCacheEntry } from './types.ts';

/**
 * Short-lived cache of the last full parse result.
 *
 * tokentop polls `parseSessions` on a timer; without this the plugin would
 * re-walk and re-parse every session file on every tick.
 */
export const sessionCache: {
  lastCheck: number;
  lastResult: SessionUsageData[];
  lastLimit: number;
  lastSince: number | undefined;
} = {
  lastCheck: 0,
  lastResult: [],
  lastLimit: 0,
  lastSince: undefined,
};

/** How long a full parse result stays valid. */
export const CACHE_TTL_MS = 2000;

/** Upper bound on cached session files before LRU eviction kicks in. */
export const SESSION_FILE_CACHE_MAX = 10_000;

/**
 * Parsed rows per session file, keyed by absolute path and invalidated by
 * mtime.
 *
 * Keyed by path rather than session id so a cache hit needs no file access at
 * all: the session id lives inside the cached entry, which would otherwise
 * have to be read back out of the file's header first.
 */
export const sessionFileCache = new Map<string, SessionFileCacheEntry>();

/** Evicts least-recently-accessed files once over the cap. */
export function evictSessionFileCache(): void {
  if (sessionFileCache.size <= SESSION_FILE_CACHE_MAX) return;

  const entries = Array.from(sessionFileCache.entries());
  entries.sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);

  const toEvict = entries.length - SESSION_FILE_CACHE_MAX;
  for (let i = 0; i < toEvict; i++) {
    const entry = entries[i];
    if (entry) sessionFileCache.delete(entry[0]);
  }
}

/** Clears all caches. Exported for tests and forced refreshes. */
export function clearCaches(): void {
  sessionCache.lastCheck = 0;
  sessionCache.lastResult = [];
  sessionCache.lastLimit = 0;
  sessionCache.lastSince = undefined;
  sessionFileCache.clear();
}
