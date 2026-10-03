import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ActivityCallback } from '@tokentop/plugin-sdk';
import { discoverVariants, listSessionFiles } from './paths.ts';
import type { PiSessionEntry, PiVariant } from './types.ts';
import { usageOfEntry } from './utils.ts';

/** Interval for full reconciliation sweeps. */
export const RECONCILIATION_INTERVAL_MS = 10 * 60 * 1000;

export const sessionWatcher = {
  dirtyPaths: new Set<string>(),
  watchers: new Map<string, fs.FSWatcher>(),
  started: false,
  reconciliationTimer: null as ReturnType<typeof setInterval> | null,
};

const activityWatcher = {
  /**
   * Bytes already consumed per file. Session files are append-only, so the
   * next read starts here instead of re-parsing the whole file — real sessions
   * reach tens of thousands of entries.
   */
  offsets: new Map<string, number>(),
  sessionIds: new Map<string, string>(),
  watchers: new Map<string, fs.FSWatcher>(),
  callback: null as ActivityCallback | null,
  started: false,
};

let forceFullReconciliation = false;

/** Consumes and resets the force-full-reconciliation flag. */
export function consumeForceFullReconciliation(): boolean {
  const value = forceFullReconciliation;
  forceFullReconciliation = false;
  return value;
}

/**
 * Watches a variant's session root for `.jsonl` changes.
 *
 * Recursive watching covers both session layouts with one watcher — Pi's
 * per-project subdirectories and Prime's flat root — and picks up new project
 * directories without a rescan. Platforms that reject recursive watching fall
 * back to the root only, where the periodic reconciliation sweep still catches
 * changes.
 */
function watchRoot(root: string): void {
  if (sessionWatcher.watchers.has(root)) return;

  const onChange = (_event: fs.WatchEventType, filename: string | Buffer | null): void => {
    if (typeof filename !== 'string' || !filename.endsWith('.jsonl')) return;
    sessionWatcher.dirtyPaths.add(path.join(root, filename));
  };

  // Unreferenced on purpose: this watcher only exists to make polling cheaper,
  // so it must not keep a host process alive on its own. The activity watcher
  // below is started and stopped explicitly by the caller and stays referenced.
  const track = (watcher: fs.FSWatcher): void => {
    watcher.on('error', () => sessionWatcher.watchers.delete(root));
    watcher.unref?.();
    sessionWatcher.watchers.set(root, watcher);
  };

  try {
    track(fs.watch(root, { recursive: true }, onChange));
    return;
  } catch {
    // Recursive watching unsupported here — fall through
  }

  try {
    track(fs.watch(root, onChange));
  } catch {
    forceFullReconciliation = true;
  }
}

/** Starts watching every discovered variant, and the reconciliation timer. */
export function startSessionWatcher(variants: PiVariant[]): void {
  for (const variant of variants) {
    watchRoot(variant.sessionsRoot);
  }

  if (sessionWatcher.started) return;
  sessionWatcher.started = true;

  sessionWatcher.reconciliationTimer = setInterval(() => {
    forceFullReconciliation = true;
  }, RECONCILIATION_INTERVAL_MS);

  sessionWatcher.reconciliationTimer?.unref?.();
}

function readSessionIdFromHead(filePath: string): string | undefined {
  try {
    const handle = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(4096);
      const bytes = fs.readSync(handle, buffer, 0, buffer.length, 0);
      const firstLine = buffer.subarray(0, bytes).toString('utf-8').split('\n')[0];
      if (!firstLine) return undefined;
      const entry = JSON.parse(firstLine) as PiSessionEntry;
      return entry.type === 'session' ? entry.id : undefined;
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return undefined;
  }
}

/**
 * Reads only the bytes appended since the last check and emits an update for
 * each newly written usage-bearing entry.
 *
 * A shrinking file means it was rewritten in place — Pi does this on session
 * format migration and on branch extraction — so the offset resets rather than
 * reading from a stale position.
 */
function handleActivityFileChange(filePath: string): void {
  const callback = activityWatcher.callback;
  if (!callback) return;

  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    activityWatcher.offsets.delete(filePath);
    activityWatcher.sessionIds.delete(filePath);
    return;
  }

  const previous = activityWatcher.offsets.get(filePath) ?? 0;
  if (size < previous) {
    activityWatcher.offsets.set(filePath, 0);
    return;
  }
  if (size === previous) return;

  let chunk: string;
  try {
    const handle = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(size - previous);
      const bytes = fs.readSync(handle, buffer, 0, buffer.length, previous);
      chunk = buffer.subarray(0, bytes).toString('utf-8');
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return;
  }

  const lastNewline = chunk.lastIndexOf('\n');
  if (lastNewline === -1) return;

  activityWatcher.offsets.set(filePath, previous + Buffer.byteLength(chunk.slice(0, lastNewline + 1)));

  let sessionId = activityWatcher.sessionIds.get(filePath);
  if (!sessionId) {
    sessionId = readSessionIdFromHead(filePath);
    if (sessionId) activityWatcher.sessionIds.set(filePath, sessionId);
  }
  if (!sessionId) return;

  for (const line of chunk.slice(0, lastNewline).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: PiSessionEntry;
    try {
      entry = JSON.parse(trimmed) as PiSessionEntry;
    } catch {
      continue;
    }

    const usage = usageOfEntry(entry);
    if (!usage) continue;

    const tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number } = {
      input: usage.input ?? 0,
      output: usage.output ?? 0,
    };
    // `reasoning` is omitted on purpose: tokentop adds it to output when
    // totalling activity, while Pi reports it as a subset of output already.
    if (usage.cacheRead > 0) tokens.cacheRead = usage.cacheRead;
    if (usage.cacheWrite > 0) tokens.cacheWrite = usage.cacheWrite;

    callback({
      sessionId,
      messageId: entry.id ?? '',
      tokens,
      timestamp: entry.message?.timestamp ?? Date.parse(entry.timestamp ?? '') ?? Date.now(),
    });
  }
}

/**
 * Primes byte offsets to current file sizes so that existing history is not
 * replayed as live activity on startup.
 */
async function primeOffsets(variants: PiVariant[]): Promise<void> {
  for (const variant of variants) {
    for (const filePath of await listSessionFiles(variant.sessionsRoot)) {
      try {
        activityWatcher.offsets.set(filePath, fs.statSync(filePath).size);
      } catch {
        // Unreadable file — it will be primed on first change instead
      }
    }
  }
}

export function startActivityWatch(callback: ActivityCallback): void {
  if (activityWatcher.started) return;
  activityWatcher.started = true;
  activityWatcher.callback = callback;

  discoverVariants()
    .then(async (variants) => {
      await primeOffsets(variants);

      for (const variant of variants) {
        const root = variant.sessionsRoot;
        if (activityWatcher.watchers.has(root)) continue;

        const onChange = (_event: fs.WatchEventType, filename: string | Buffer | null): void => {
          if (typeof filename !== 'string' || !filename.endsWith('.jsonl')) return;
          handleActivityFileChange(path.join(root, filename));
        };

        try {
          const watcher = fs.watch(root, { recursive: true }, onChange);
          watcher.on('error', () => activityWatcher.watchers.delete(root));
          activityWatcher.watchers.set(root, watcher);
        } catch {
          try {
            const watcher = fs.watch(root, onChange);
            watcher.on('error', () => activityWatcher.watchers.delete(root));
            activityWatcher.watchers.set(root, watcher);
          } catch {
            // Variant not watchable — polling via parseSessions still reports it
          }
        }
      }
    })
    .catch(() => {
      // Priming failed; activity reporting stays off rather than replaying history
    });
}

export function stopActivityWatch(): void {
  for (const watcher of activityWatcher.watchers.values()) {
    watcher.close();
  }
  activityWatcher.watchers.clear();
  activityWatcher.offsets.clear();
  activityWatcher.sessionIds.clear();
  activityWatcher.callback = null;
  activityWatcher.started = false;
}

/** Stops all watchers and timers. */
export function stopAllWatchers(): void {
  for (const watcher of sessionWatcher.watchers.values()) {
    watcher.close();
  }
  sessionWatcher.watchers.clear();
  sessionWatcher.dirtyPaths.clear();
  sessionWatcher.started = false;

  if (sessionWatcher.reconciliationTimer) {
    clearInterval(sessionWatcher.reconciliationTimer);
    sessionWatcher.reconciliationTimer = null;
  }

  stopActivityWatch();
}
