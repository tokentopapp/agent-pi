import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PiSessionEntry, PiUsage } from './types.ts';

/** Reads and parses a JSON file, returning null on any read or parse failure. */
export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

/**
 * The user's home directory.
 *
 * Reads `$HOME`/`%USERPROFILE%` directly, which is what `os.homedir()` itself
 * consults, but does so on every call: Bun resolves `os.homedir()` once at
 * startup, which would make the directory scan untestable.
 */
export function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

/** Expands a leading `~` to the user's home directory, matching Pi's own path handling. */
export function expandTilde(input: string): string {
  if (input === '~') return homeDir();
  if (input.startsWith('~/')) return path.join(homeDir(), input.slice(2));
  return input;
}

/**
 * Converts an ISO timestamp string to epoch milliseconds, falling back when
 * the value is missing or unparseable.
 */
export function toTimestamp(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * The single mapping of session entry type to the usage it carries.
 *
 * Both the parser and the activity watcher go through here so neither can drift
 * into counting a different set of entry types from the other.
 */
export function usageOfEntry(entry: PiSessionEntry): PiUsage | null {
  switch (entry.type) {
    case 'message':
      return entry.message?.role === 'assistant' ? (entry.message.usage ?? null) : null;
    case 'usage':
    case 'compaction':
    case 'branch_summary':
      return entry.usage ?? null;
    case 'child_usage_attributed':
      return entry.childUsage ?? null;
    default:
      return null;
  }
}
