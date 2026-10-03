import type { SessionUsageData } from '@tokentop/plugin-sdk';

/**
 * Token usage as reported by `@earendil-works/pi-ai`.
 *
 * Two fields are *subsets* of other fields and must never be added on top of
 * them, or totals inflate:
 *   - `reasoning` is already included in `output`
 *   - `cacheWrite1h` is already included in `cacheWrite`
 */
export interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Subset of `cacheWrite` written with 1h retention. Anthropic only. */
  cacheWrite1h?: number;
  /** Subset of `output`. Only set by providers exposing a reasoning breakdown. */
  reasoning?: number;
  totalTokens: number;
}

/** The assistant/user message carried by a `message` entry. */
export interface PiMessage {
  role?: string;
  /** Pi provider id, e.g. `anthropic`, `openai`, `google`. */
  provider?: string;
  /** Model the request asked for. */
  model?: string;
  /** Model that actually answered — preferred over `model` when present. */
  responseModel?: string;
  usage?: PiUsage;
  /** Epoch milliseconds. */
  timestamp?: number;
}

/**
 * A single line of a Pi session `.jsonl` file.
 *
 * Deliberately one permissive shape rather than a discriminated union: these
 * objects come from untrusted files that may be written by any Pi version, so
 * every field is optional and narrowed at the point of use. Field groups below
 * are keyed by the `type` that carries them.
 *
 * @see https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md
 */
export interface PiSessionEntry {
  type?: string;
  /** 8-char hex entry id. Absent on the `session` header. */
  id?: string;
  parentId?: string | null;
  /** ISO timestamp. */
  timestamp?: string;

  // type: "session" (header, first line)
  /** Session format version. Absent on legacy sessions written before versioning. */
  version?: number;
  /** Working directory the session ran in. */
  cwd?: string;
  /** Set when this session was produced by `/fork`, `/clone` or a branch extract. */
  parentSession?: string;

  // type: "message"
  message?: PiMessage;

  // type: "model_change" | "usage"
  provider?: string;
  modelId?: string;
  model?: string;
  /** Usage category on a `usage` entry, e.g. `cache_warm`. */
  kind?: string;

  // type: "usage" | "compaction" | "branch_summary"
  usage?: PiUsage;

  // type: "child_usage_attributed" — spawned subagent usage, absent from the message stream
  /** The `message` entry this child usage is attributed to. */
  targetId?: string;
  /** Usage of one spawned child turn. The additive figure — sum this. */
  childUsage?: PiUsage;
  /**
   * Running total scoped to the child task, not to the session. Summing this
   * across entries double-counts; sum `childUsage` instead.
   */
  aggregateUsage?: PiUsage;
  origin?: string;

  // type: "session_info"
  name?: string;
}

/** An installed Pi or Pi-derived agent (Pi, Prime, ...), located on disk. */
export interface PiVariant {
  /** Lowercase app name (`pi`, `prime`), surfaced to core as `metadata.variant`. */
  name: string;
  agentDir: string;
  sessionsRoot: string;
}

/** Pi `settings.json`, read only for its session directory override. */
export interface PiSettings {
  sessionDir?: string;
}

/** A discovered session file, with the metadata needed to order and cache it. */
export interface PiSessionFile {
  sessionId: string;
  filePath: string;
  mtimeMs: number;
  /**
   * Session creation time from the header, in epoch ms.
   *
   * Used to decide which session owns an entry that appears in more than one
   * file: a fork is always created after its parent, and unlike mtime this
   * does not change when a session is appended to later.
   */
  createdAt: number;
}

export interface SessionFileCacheEntry {
  mtimeMs: number;
  createdAt: number;
  sessionId: string;
  usageRows: SessionUsageData[];
  lastAccessed: number;
}
