import * as fs from 'node:fs/promises';
import type { AgentFetchContext, SessionParseOptions, SessionUsageData } from '@tokentop/plugin-sdk';
import { CACHE_TTL_MS, evictSessionFileCache, sessionCache, sessionFileCache } from './cache.ts';
import { discoverVariants, listSessionFiles } from './paths.ts';
import type { PiMessage, PiSessionEntry, PiUsage, PiVariant } from './types.ts';
import { toTimestamp, usageOfEntry } from './utils.ts';
import { consumeForceFullReconciliation, sessionWatcher, startSessionWatcher } from './watcher.ts';

/** Pi provider ids that differ from the models.dev id used for pricing. */
const PROVIDER_ALIASES: Record<string, string> = {
  bedrock: 'amazon-bedrock',
};

/** Provider ids that models.dev knows, so they can be reported unchanged. */
const PRICEABLE_PROVIDERS = new Set([
  'amazon-bedrock',
  'anthropic',
  'alibaba',
  'baseten',
  'cerebras',
  'deepseek',
  'google',
  'groq',
  'meta',
  'mistral',
  'moonshotai',
  'openai',
  'openrouter',
  'xai',
  'zai',
  'zhipuai',
]);

/** Model id prefix to models.dev provider, longest-prefix-first within each vendor. */
const MODEL_PREFIX_PROVIDERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^claude/, 'anthropic'],
  [/^(gpt|codex|o[1-9])/, 'openai'],
  [/^gemini/, 'google'],
  [/^grok/, 'xai'],
  [/^deepseek/, 'deepseek'],
  [/^(mistral|magistral|devstral|codestral|pixtral)/, 'mistral'],
  [/^llama/, 'meta'],
  [/^qwen/, 'alibaba'],
  [/^glm/, 'zai'],
  [/^kimi/, 'moonshotai'],
];

/**
 * Infers the upstream vendor from a model id.
 *
 * Pi-derived agents routinely report proxy provider ids that no pricing table
 * knows — real sessions here carry `meridian-local`, `anthropic-litellm`,
 * `litellm` and `openai-codex` — while the model id still names the vendor.
 * The segment after the last `/` is tried as well, so a model routed as
 * `anthropic/claude-opus-5` is still recognised.
 */
export function inferProviderFromModel(modelId: string): string | undefined {
  const normalized = modelId.toLowerCase();
  const candidates = [normalized];

  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash >= 0 && lastSlash < normalized.length - 1) {
    candidates.push(normalized.slice(lastSlash + 1));
  }

  for (const candidate of candidates) {
    for (const [pattern, provider] of MODEL_PREFIX_PROVIDERS) {
      if (pattern.test(candidate)) return provider;
    }
  }
  return undefined;
}

/**
 * Splits a `vendor/model` id when the vendor names a provider models.dev knows.
 *
 * Proxies such as LiteLLM report their own name as the provider and move the
 * real vendor into the model id. models.dev keys native providers' models
 * without that prefix, so it has to come off for the price to resolve.
 */
function splitVendorPrefixedModel(modelId: string): ModelIdentity | undefined {
  const slash = modelId.indexOf('/');
  if (slash <= 0 || slash === modelId.length - 1) return undefined;

  const vendor = modelId.slice(0, slash).toLowerCase();
  const resolved = PROVIDER_ALIASES[vendor] ?? vendor;
  if (!PRICEABLE_PROVIDERS.has(resolved)) return undefined;

  return { providerId: resolved, modelId: modelId.slice(slash + 1) };
}

export interface ModelIdentity {
  providerId: string;
  modelId: string;
}

/**
 * Resolves the provider and model to report for a usage row.
 *
 * A provider models.dev knows is taken as-is, before any `vendor/model`
 * splitting — aggregators like `openrouter` key their models that way, so
 * splitting them would break the price lookup it is meant to fix. An
 * unrecognised provider is preserved rather than guessed at, surfacing as a
 * *missing* price rather than a confidently wrong one.
 */
export function resolveModelIdentity(
  piProvider: string | undefined,
  modelId: string,
): ModelIdentity {
  const aliased = piProvider ? (PROVIDER_ALIASES[piProvider] ?? piProvider) : undefined;
  if (aliased && PRICEABLE_PROVIDERS.has(aliased)) {
    return { providerId: aliased, modelId };
  }

  const vendorPrefixed = splitVendorPrefixedModel(modelId);
  if (vendorPrefixed) return vendorPrefixed;

  const inferred = inferProviderFromModel(modelId);
  if (inferred) return { providerId: inferred, modelId };

  return { providerId: aliased ?? 'unknown', modelId };
}

export function resolveProviderId(piProvider: string | undefined, modelId: string): string {
  return resolveModelIdentity(piProvider, modelId).providerId;
}

/** Coerces a value from an untrusted session file into a finite number. */
function num(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Maps Pi usage onto tokentop token counts.
 *
 * `reasoning` and `cacheWrite1h` are deliberately dropped: Pi documents them as
 * subsets of `output` and `cacheWrite` respectively, so adding them would
 * inflate every total that includes a thinking model or Anthropic 1h caching.
 */
function toTokens(usage: PiUsage): SessionUsageData['tokens'] {
  const tokens: SessionUsageData['tokens'] = {
    input: num(usage.input),
    output: num(usage.output),
  };

  const cacheRead = num(usage.cacheRead);
  if (cacheRead > 0) tokens.cacheRead = cacheRead;

  const cacheWrite = num(usage.cacheWrite);
  if (cacheWrite > 0) tokens.cacheWrite = cacheWrite;

  return tokens;
}

interface UsageSource {
  usage: PiUsage;
  provider: string | undefined;
  modelId: string;
}

/**
 * Identity of a usage row, stable across session files.
 *
 * Forking a Pi session copies its history verbatim — entry ids and token counts
 * included — into the new file, so the same spend appears in both. Combining the
 * entry id with the counts collapses those copies without risking a collision
 * between genuinely distinct 8-hex-character ids from unrelated sessions.
 */
export function dedupKey(row: SessionUsageData): string {
  const entryId = (row.metadata?.entryId as string | undefined) ?? '';
  const { input, output, cacheRead, cacheWrite } = row.tokens;
  return `${entryId}:${row.timestamp}:${input}:${output}:${cacheRead ?? 0}:${cacheWrite ?? 0}`;
}

/**
 * Parses one session file into usage rows.
 *
 * Every entry type Pi can attach usage to is counted:
 *   - `message`                  assistant turns
 *   - `usage`                    standalone notices, e.g. cache warming
 *   - `compaction`               the summarisation call itself
 *   - `branch_summary`           the branch summarisation call
 *   - `child_usage_attributed`   spawned subagent turns, which appear nowhere
 *                                in the message stream
 *
 * Counting only `message` undercounts: in 74 real Prime sessions the
 * `child_usage_attributed` entries alone accounted for 7% of total spend.
 */
export function parseSessionFile(
  content: string,
  meta: { mtimeMs: number; createdAt: number; sessionId: string },
  variant: PiVariant,
): SessionUsageData[] {
  const entries: PiSessionEntry[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as PiSessionEntry);
    } catch {
      // A partially flushed trailing line is normal while a session is live
    }
  }

  let projectPath: string | undefined;
  let sessionName: string | undefined;
  const messagesById = new Map<string, PiMessage>();

  for (const entry of entries) {
    if (entry.type === 'session') {
      if (entry.cwd) projectPath = entry.cwd;
    } else if (entry.type === 'session_info') {
      sessionName = entry.name?.trim() || undefined;
    } else if (entry.type === 'message' && entry.id && entry.message) {
      messagesById.set(entry.id, entry.message);
    }
  }

  const rows: SessionUsageData[] = [];
  const seen = new Set<string>();
  const fallbackTimestamp = meta.createdAt || meta.mtimeMs;

  let lastProvider: string | undefined;
  let lastModelId = 'unknown';

  for (const entry of entries) {
    if (entry.type === 'model_change') {
      if (entry.provider) lastProvider = entry.provider;
      if (entry.modelId) lastModelId = entry.modelId;
      continue;
    }

    const usage = usageOfEntry(entry);
    if (!usage) continue;

    let source: UsageSource;
    switch (entry.type) {
      case 'message':
        source = {
          usage,
          provider: entry.message?.provider,
          modelId: entry.message?.responseModel ?? entry.message?.model ?? 'unknown',
        };
        break;
      case 'usage':
        source = { usage, provider: entry.provider, modelId: entry.model ?? lastModelId };
        break;
      case 'child_usage_attributed': {
        const target = entry.targetId ? messagesById.get(entry.targetId) : undefined;
        source = {
          usage,
          provider: target?.provider ?? lastProvider,
          modelId: target?.responseModel ?? target?.model ?? lastModelId,
        };
        break;
      }
      default:
        source = { usage, provider: lastProvider, modelId: lastModelId };
        break;
    }

    if (entry.type === 'message') {
      lastProvider = source.provider ?? lastProvider;
      lastModelId = source.modelId;
    }

    const timestamp =
      entry.type === 'message'
        ? num(entry.message?.timestamp) || toTimestamp(entry.timestamp, fallbackTimestamp)
        : toTimestamp(entry.timestamp, fallbackTimestamp);

    const identity = resolveModelIdentity(source.provider, source.modelId);

    const row: SessionUsageData = {
      sessionId: meta.sessionId,
      providerId: identity.providerId,
      modelId: identity.modelId,
      tokens: toTokens(source.usage),
      timestamp,
      sessionUpdatedAt: meta.mtimeMs,
      metadata: { variant: variant.name, entryId: entry.id ?? '' },
    };

    if (sessionName) row.sessionName = sessionName;
    if (projectPath) row.projectPath = projectPath;

    const key = dedupKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }

  return rows;
}

/** Reads the `session` header to identify a file without parsing all of it. */
function readHeader(content: string): { sessionId: string; createdAt: number } | null {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: PiSessionEntry;
    try {
      entry = JSON.parse(trimmed) as PiSessionEntry;
    } catch {
      return null;
    }
    if (entry.type !== 'session' || !entry.id) return null;
    return { sessionId: entry.id, createdAt: toTimestamp(entry.timestamp, 0) };
  }
  return null;
}

interface DiscoveredFile {
  filePath: string;
  variant: PiVariant;
  mtimeMs: number;
}

/**
 * Parses sessions across every installed Pi variant.
 *
 * `options.limit` participates in the cache key but does not truncate the
 * result, matching the other tokentop agent plugins — silently dropping
 * sessions would hide usage from the dashboard rather than merely delay it.
 */
export async function parseAllSessions(
  options: SessionParseOptions,
  ctx: AgentFetchContext,
): Promise<SessionUsageData[]> {
  const limit = options.limit ?? 100;
  const since = options.since;

  const variants = await discoverVariants();
  if (variants.length === 0) {
    ctx.logger.debug('Pi: no session directories found');
    return [];
  }

  startSessionWatcher(variants);

  const now = Date.now();
  if (
    !options.sessionId &&
    limit === sessionCache.lastLimit &&
    now - sessionCache.lastCheck < CACHE_TTL_MS &&
    sessionCache.lastResult.length > 0 &&
    sessionCache.lastSince === since
  ) {
    ctx.logger.debug('Pi: using cached sessions (within TTL)', {
      count: sessionCache.lastResult.length,
    });
    return sessionCache.lastResult;
  }

  const dirtyPaths = new Set(sessionWatcher.dirtyPaths);
  sessionWatcher.dirtyPaths.clear();
  const needsFullStat = consumeForceFullReconciliation();

  const discovered: DiscoveredFile[] = [];
  const seenFilePaths = new Set<string>();
  let statCount = 0;
  let statSkipCount = 0;

  for (const variant of variants) {
    for (const filePath of await listSessionFiles(variant.sessionsRoot)) {
      seenFilePaths.add(filePath);

      const cached = sessionFileCache.get(filePath);
      const isDirty = dirtyPaths.has(filePath);

      if (!isDirty && !needsFullStat && cached) {
        statSkipCount++;
        discovered.push({ filePath, variant, mtimeMs: cached.mtimeMs });
        continue;
      }

      statCount++;
      try {
        const stat = await fs.stat(filePath);
        discovered.push({ filePath, variant, mtimeMs: stat.mtimeMs });
      } catch {
        sessionFileCache.delete(filePath);
      }
    }
  }

  for (const cachedPath of sessionFileCache.keys()) {
    if (!seenFilePaths.has(cachedPath)) sessionFileCache.delete(cachedPath);
  }

  let cacheHits = 0;
  let cacheMisses = 0;
  const parsed: Array<{ createdAt: number; rows: SessionUsageData[] }> = [];

  for (const file of discovered) {
    const cached = sessionFileCache.get(file.filePath);

    if (cached && cached.mtimeMs === file.mtimeMs) {
      cached.lastAccessed = now;
      cacheHits++;
      if (options.sessionId && cached.sessionId !== options.sessionId) continue;
      if (since && cached.mtimeMs < since) continue;
      parsed.push({ createdAt: cached.createdAt, rows: cached.usageRows });
      continue;
    }

    cacheMisses++;

    let content: string;
    try {
      content = await fs.readFile(file.filePath, 'utf-8');
    } catch {
      sessionFileCache.delete(file.filePath);
      continue;
    }

    const header = readHeader(content);
    if (!header) {
      sessionFileCache.delete(file.filePath);
      continue;
    }

    const meta = {
      mtimeMs: file.mtimeMs,
      createdAt: header.createdAt,
      sessionId: header.sessionId,
    };
    const rows = parseSessionFile(content, meta, file.variant);

    sessionFileCache.set(file.filePath, { ...meta, usageRows: rows, lastAccessed: now });

    if (options.sessionId && header.sessionId !== options.sessionId) continue;
    if (since && file.mtimeMs < since) continue;
    parsed.push({ createdAt: header.createdAt, rows });
  }

  evictSessionFileCache();

  // Oldest session first, so that when a fork has copied its parent's history
  // the parent keeps those entries. Header creation time is used rather than
  // mtime because appending to the parent later must not hand ownership of its
  // own past spend over to the fork.
  parsed.sort((a, b) => a.createdAt - b.createdAt);

  const sessions: SessionUsageData[] = [];
  const seenEntries = new Set<string>();
  let duplicatesDropped = 0;

  for (const entry of parsed) {
    for (const row of entry.rows) {
      const key = dedupKey(row);
      if (seenEntries.has(key)) {
        duplicatesDropped++;
        continue;
      }
      seenEntries.add(key);
      sessions.push(row);
    }
  }

  if (!options.sessionId) {
    sessionCache.lastCheck = Date.now();
    sessionCache.lastResult = sessions;
    sessionCache.lastLimit = limit;
    sessionCache.lastSince = since;
  }

  ctx.logger.debug('Pi: parsed sessions', {
    variants: variants.map((v) => v.name),
    rows: sessions.length,
    files: discovered.length,
    statChecks: statCount,
    statSkips: statSkipCount,
    cacheHits,
    cacheMisses,
    duplicatesDropped,
    fileCacheSize: sessionFileCache.size,
  });

  return sessions;
}
