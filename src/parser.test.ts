import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createTestAgentFetchContext } from '@tokentop/plugin-sdk/testing';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { clearCaches } from './cache.ts';
import {
  dedupKey,
  inferProviderFromModel,
  parseAllSessions,
  parseSessionFile,
  resolveModelIdentity,
  resolveProviderId,
} from './parser.ts';
import type { PiUsage, PiVariant } from './types.ts';
import { stopAllWatchers } from './watcher.ts';

const VARIANT: PiVariant = {
  name: 'pi',
  agentDir: '/tmp/agent',
  sessionsRoot: '/tmp/agent/sessions',
};

const META = { mtimeMs: 2_000, createdAt: 1_000, sessionId: 'session-a' };

function usage(partial: Partial<PiUsage> = {}): PiUsage {
  const base: PiUsage = {
    input: 100,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 120,
  };
  return { ...base, ...partial };
}

function header(id = 'session-a', cwd = '/work/proj', timestamp = '2026-01-01T00:00:00.000Z') {
  return JSON.stringify({ type: 'session', version: 3, id, timestamp, cwd });
}

function assistant(id: string, over: Record<string, unknown> = {}, u: PiUsage = usage()) {
  return JSON.stringify({
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-01-01T00:01:00.000Z',
    message: {
      role: 'assistant',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      usage: u,
      timestamp: 1_700_000_000_000,
      ...over,
    },
  });
}

function jsonl(...lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

describe('resolveProviderId', () => {
  test('passes through a provider models.dev already knows', () => {
    expect(resolveProviderId('anthropic', 'claude-sonnet-4-5')).toBe('anthropic');
    expect(resolveProviderId('google', 'gemini-2.5-pro')).toBe('google');
  });

  test('maps a Pi provider id that differs from the pricing id', () => {
    expect(resolveProviderId('bedrock', 'claude-sonnet-4-5')).toBe('amazon-bedrock');
  });

  test('infers the vendor when a Pi-based agent reports a proxy provider', () => {
    expect(resolveProviderId('meridian-local', 'claude-opus-4-6')).toBe('anthropic');
    expect(resolveProviderId('anthropic-litellm', 'claude-fable-5')).toBe('anthropic');
    expect(resolveProviderId('litellm', 'claude-opus-4-6')).toBe('anthropic');
    expect(resolveProviderId('openai-codex', 'gpt-5.6-sol')).toBe('openai');
  });

  test('keeps the raw provider when nothing can be inferred, rather than guessing', () => {
    expect(resolveProviderId('some-proxy', 'house-model-v1')).toBe('some-proxy');
    expect(resolveProviderId(undefined, 'house-model-v1')).toBe('unknown');
  });
});

describe('resolveModelIdentity', () => {
  test('recovers the vendor a proxy moved into the model id, and strips the prefix', () => {
    expect(resolveModelIdentity('litellm', 'anthropic/claude-opus-5')).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-opus-5',
    });
  });

  test('leaves aggregator model ids alone, since they are keyed as vendor/model', () => {
    expect(resolveModelIdentity('openrouter', 'anthropic/claude-opus-5')).toEqual({
      providerId: 'openrouter',
      modelId: 'anthropic/claude-opus-5',
    });
  });

  test('falls back to prefix inference when the vendor segment is unknown', () => {
    expect(resolveModelIdentity('some-proxy', 'internal-tier/claude-opus-5')).toEqual({
      providerId: 'anthropic',
      modelId: 'internal-tier/claude-opus-5',
    });
  });

  test('leaves an unprefixed model id untouched', () => {
    expect(resolveModelIdentity('meridian-local', 'claude-opus-4-6')).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-opus-4-6',
    });
  });

  test('infers vendors from model prefixes', () => {
    expect(inferProviderFromModel('grok-4')).toBe('xai');
    expect(inferProviderFromModel('qwen3-coder')).toBe('alibaba');
    expect(inferProviderFromModel('kimi-k2')).toBe('moonshotai');
    expect(inferProviderFromModel('llama-4-maverick')).toBe('meta');
    expect(inferProviderFromModel('glm-4.6')).toBe('zai');
    expect(inferProviderFromModel('o3-mini')).toBe('openai');
    expect(inferProviderFromModel('house-model-v1')).toBeUndefined();
  });
});

describe('parseSessionFile', () => {
  test('reads session id from the header and project path from cwd', () => {
    const rows = parseSessionFile(
      jsonl(header('header-id', '/work/myproj'), assistant('a1')),
      { ...META, sessionId: 'header-id' },
      VARIANT,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionId).toBe('header-id');
    expect(rows[0]?.projectPath).toBe('/work/myproj');
  });

  test('never adds reasoning on top of output', () => {
    const rows = parseSessionFile(
      jsonl(header(), assistant('a1', {}, usage({ output: 500, reasoning: 400 }))),
      META,
      VARIANT,
    );

    expect(rows[0]?.tokens.output).toBe(500);
  });

  test('never adds cacheWrite1h on top of cacheWrite', () => {
    const rows = parseSessionFile(
      jsonl(header(), assistant('a1', {}, usage({ cacheWrite: 300, cacheWrite1h: 200 }))),
      META,
      VARIANT,
    );

    expect(rows[0]?.tokens.cacheWrite).toBe(300);
  });

  test('prefers responseModel over the requested model', () => {
    const rows = parseSessionFile(
      jsonl(header(), assistant('a1', { model: 'claude-sonnet-4-5', responseModel: 'claude-opus-4-6' })),
      META,
      VARIANT,
    );

    expect(rows[0]?.modelId).toBe('claude-opus-4-6');
  });

  test('ignores user messages and entry types that carry no usage', () => {
    const rows = parseSessionFile(
      jsonl(
        header(),
        JSON.stringify({ type: 'message', id: 'u1', message: { role: 'user', content: 'hi' } }),
        JSON.stringify({ type: 'agent_status', id: 's1', timestamp: '2026-01-01T00:02:00.000Z' }),
        JSON.stringify({ type: 'thinking_level_change', id: 't1', thinkingLevel: 'high' }),
        assistant('a1'),
      ),
      META,
      VARIANT,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata?.entryId).toBe('a1');
  });

  test('counts every entry type that carries usage, not just messages', () => {
    const rows = parseSessionFile(
      jsonl(
        header(),
        assistant('a1', {}, usage({ input: 100, output: 10 })),
        JSON.stringify({
          type: 'usage',
          id: 'u1',
          timestamp: '2026-01-01T00:02:00.000Z',
          kind: 'cache_warm',
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
          usage: usage({ input: 7, output: 0 }),
        }),
        JSON.stringify({
          type: 'compaction',
          id: 'c1',
          timestamp: '2026-01-01T00:03:00.000Z',
          summary: 's',
          firstKeptEntryId: 'a1',
          tokensBefore: 9000,
          usage: usage({ input: 5000, output: 300 }),
        }),
        JSON.stringify({
          type: 'branch_summary',
          id: 'b1',
          timestamp: '2026-01-01T00:04:00.000Z',
          fromId: 'a1',
          summary: 's',
          usage: usage({ input: 40, output: 4 }),
        }),
      ),
      META,
      VARIANT,
    );

    expect(rows.map((r) => r.metadata?.entryId)).toEqual(['a1', 'u1', 'c1', 'b1']);
    expect(rows.reduce((sum, r) => sum + r.tokens.input, 0)).toBe(5147);
  });

  test('counts spawned subagent usage from childUsage, ignoring the cumulative aggregateUsage', () => {
    const rows = parseSessionFile(
      jsonl(
        header(),
        assistant('a1', {}, usage({ input: 100, output: 10 })),
        JSON.stringify({
          type: 'child_usage_attributed',
          id: 'ch1',
          timestamp: '2026-01-01T00:02:00.000Z',
          targetId: 'a1',
          origin: 'spawn_task',
          childUsage: usage({ input: 3, output: 120 }),
          aggregateUsage: usage({ input: 999_999, output: 999_999 }),
        }),
      ),
      META,
      VARIANT,
    );

    expect(rows).toHaveLength(2);
    const child = rows.find((r) => r.metadata?.entryId === 'ch1');
    expect(child?.tokens.input).toBe(3);
    expect(child?.tokens.output).toBe(120);
  });

  test('attributes child usage to the provider and model of its target message', () => {
    const rows = parseSessionFile(
      jsonl(
        header(),
        assistant('a1', { provider: 'meridian-local', model: 'claude-opus-4-6' }),
        JSON.stringify({
          type: 'child_usage_attributed',
          id: 'ch1',
          timestamp: '2026-01-01T00:02:00.000Z',
          targetId: 'a1',
          childUsage: usage(),
        }),
      ),
      META,
      VARIANT,
    );

    const child = rows.find((r) => r.metadata?.entryId === 'ch1');
    expect(child?.providerId).toBe('anthropic');
    expect(child?.modelId).toBe('claude-opus-4-6');
  });

  test('attributes compaction usage to the model in effect at that point', () => {
    const rows = parseSessionFile(
      jsonl(
        header(),
        JSON.stringify({ type: 'model_change', id: 'm1', provider: 'openai', modelId: 'gpt-5' }),
        JSON.stringify({
          type: 'compaction',
          id: 'c1',
          timestamp: '2026-01-01T00:03:00.000Z',
          summary: 's',
          firstKeptEntryId: 'x',
          tokensBefore: 10,
          usage: usage(),
        }),
      ),
      META,
      VARIANT,
    );

    expect(rows[0]?.providerId).toBe('openai');
    expect(rows[0]?.modelId).toBe('gpt-5');
  });

  test('takes the session name from the last session_info entry', () => {
    const rows = parseSessionFile(
      jsonl(
        header(),
        JSON.stringify({ type: 'session_info', id: 'i1', name: 'first name' }),
        JSON.stringify({ type: 'session_info', id: 'i2', name: 'second name' }),
        assistant('a1'),
      ),
      META,
      VARIANT,
    );

    expect(rows[0]?.sessionName).toBe('second name');
  });

  test('treats an empty session_info name as clearing the name', () => {
    const rows = parseSessionFile(
      jsonl(
        header(),
        JSON.stringify({ type: 'session_info', id: 'i1', name: 'a name' }),
        JSON.stringify({ type: 'session_info', id: 'i2', name: '   ' }),
        assistant('a1'),
      ),
      META,
      VARIANT,
    );

    expect(rows[0]?.sessionName).toBeUndefined();
  });

  test('ignores a cost present in the file — pricing belongs to the core', () => {
    const withCost = JSON.stringify({
      type: 'message',
      id: 'a1',
      timestamp: '2026-01-01T00:01:00.000Z',
      message: {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        timestamp: 1_700_000_000_000,
        usage: {
          ...usage(),
          cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
        },
      },
    });

    const rows = parseSessionFile(jsonl(header(), withCost), META, VARIANT);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokens.input).toBe(100);
    expect(rows[0]?.cost).toBeUndefined();
  });

  test('tags rows with the variant that produced them', () => {
    const rows = parseSessionFile(jsonl(header(), assistant('a1')), META, {
      ...VARIANT,
      name: 'prime',
    });

    expect(rows[0]?.metadata?.variant).toBe('prime');
  });

  test('survives a partially written trailing line', () => {
    const content = `${jsonl(header(), assistant('a1'))}{"type":"message","id":"a2","mess`;
    const rows = parseSessionFile(content, META, VARIANT);

    expect(rows).toHaveLength(1);
  });

  test('falls back to header creation time when an entry has no timestamp', () => {
    const rows = parseSessionFile(
      jsonl(
        header(),
        JSON.stringify({
          type: 'compaction',
          id: 'c1',
          summary: 's',
          firstKeptEntryId: 'x',
          tokensBefore: 1,
          usage: usage(),
        }),
      ),
      META,
      VARIANT,
    );

    expect(rows[0]?.timestamp).toBe(META.createdAt);
  });
});

describe('dedupKey', () => {
  test('matches identical entries and separates different ones', () => {
    const [row] = parseSessionFile(jsonl(header(), assistant('a1')), META, VARIANT);
    const [same] = parseSessionFile(jsonl(header('other'), assistant('a1')), META, VARIANT);
    const [different] = parseSessionFile(
      jsonl(header(), assistant('a1', {}, usage({ input: 999 }))),
      META,
      VARIANT,
    );

    expect(row && same && dedupKey(row) === dedupKey(same)).toBe(true);
    expect(row && different && dedupKey(row) === dedupKey(different)).toBe(false);
  });
});

describe('parseAllSessions', () => {
  let home: string;
  let originalHome: string | undefined;
  let clearedEnv: string[];

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-pi-test-'));

    originalHome = process.env.HOME;
    process.env.HOME = home;

    // Discovery is rooted at the home directory, so a real `~/.pi` or `~/.prime`
    // would otherwise be picked up and mixed into these assertions.
    clearedEnv = Object.keys(process.env).filter((key) => key.includes('_CODING_AGENT_'));
    for (const key of clearedEnv) delete process.env[key];

    clearCaches();
  });

  afterEach(async () => {
    stopAllWatchers();
    clearCaches();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await fs.rm(home, { recursive: true, force: true });
  });

  async function writeSession(
    variant: string,
    relativePath: string,
    content: string,
  ): Promise<string> {
    const full = path.join(home, `.${variant}`, 'agent', 'sessions', relativePath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf-8');
    return full;
  }

  test('finds sessions in the flat layout', async () => {
    await writeSession('pi', 'abc.jsonl', jsonl(header('abc'), assistant('a1')));

    const rows = await parseAllSessions({}, createTestAgentFetchContext());

    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionId).toBe('abc');
  });

  test('finds sessions in the per-project nested layout', async () => {
    await writeSession(
      'pi',
      '--work-proj--/2026-01-01T00-00-00-000Z_abc.jsonl',
      jsonl(header('abc'), assistant('a1')),
    );

    const rows = await parseAllSessions({}, createTestAgentFetchContext());

    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionId).toBe('abc');
  });

  test('discovers Pi-based agents alongside Pi and tags each row with its variant', async () => {
    await writeSession('pi', 'from-pi.jsonl', jsonl(header('pi-session'), assistant('a1')));
    await writeSession('prime', 'from-prime.jsonl', jsonl(header('prime-session'), assistant('a2')));

    const rows = await parseAllSessions({}, createTestAgentFetchContext());

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.metadata?.variant))).toEqual(new Set(['pi', 'prime']));
  });

  test('honours a variant-specific session directory override', async () => {
    const relocated = path.join(home, 'elsewhere');
    await fs.mkdir(relocated, { recursive: true });
    await fs.writeFile(
      path.join(relocated, 'moved.jsonl'),
      jsonl(header('moved'), assistant('a1')),
      'utf-8',
    );
    process.env.PRIME_CODING_AGENT_SESSION_DIR = relocated;

    const rows = await parseAllSessions({}, createTestAgentFetchContext());

    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionId).toBe('moved');
    expect(rows[0]?.metadata?.variant).toBe('prime');
  });

  test('honours a sessionDir configured in settings.json', async () => {
    const relocated = path.join(home, 'configured');
    await fs.mkdir(relocated, { recursive: true });
    await fs.writeFile(
      path.join(relocated, 'cfg.jsonl'),
      jsonl(header('cfg'), assistant('a1')),
      'utf-8',
    );
    const agentDir = path.join(home, '.pi', 'agent');
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      path.join(agentDir, 'settings.json'),
      JSON.stringify({ sessionDir: relocated }),
      'utf-8',
    );

    const rows = await parseAllSessions({}, createTestAgentFetchContext());

    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionId).toBe('cfg');
  });

  test('counts a forked session only once, leaving the spend with the parent', async () => {
    const shared = assistant('shared1', {}, usage({ input: 500, output: 50 }));

    const parentPath = await writeSession(
      'pi',
      'parent.jsonl',
      jsonl(header('parent-id', '/work/proj', '2026-01-01T00:00:00.000Z'), shared),
    );
    await writeSession(
      'pi',
      'fork.jsonl',
      jsonl(
        JSON.stringify({
          type: 'session',
          version: 3,
          id: 'fork-id',
          timestamp: '2026-01-02T00:00:00.000Z',
          cwd: '/work/proj',
          parentSession: parentPath,
        }),
        shared,
        assistant('forkonly', {}, usage({ input: 10, output: 1 })),
      ),
    );

    const rows = await parseAllSessions({}, createTestAgentFetchContext());

    expect(rows.filter((r) => r.metadata?.entryId === 'shared1')).toHaveLength(1);
    expect(rows.find((r) => r.metadata?.entryId === 'shared1')?.sessionId).toBe('parent-id');
    expect(rows.reduce((sum, r) => sum + r.tokens.input, 0)).toBe(510);
  });

  test('filters by sessionId when asked', async () => {
    await writeSession('pi', 'one.jsonl', jsonl(header('one'), assistant('a1')));
    await writeSession('pi', 'two.jsonl', jsonl(header('two'), assistant('a2')));

    const rows = await parseAllSessions({ sessionId: 'two' }, createTestAgentFetchContext());

    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionId).toBe('two');
  });

  test('skips files untouched since the requested cutoff', async () => {
    await writeSession('pi', 'old.jsonl', jsonl(header('old'), assistant('a1')));

    const rows = await parseAllSessions(
      { since: Date.now() + 60_000 },
      createTestAgentFetchContext(),
    );

    expect(rows).toHaveLength(0);
  });

  test('returns nothing when no variant has a session directory', async () => {
    const rows = await parseAllSessions({}, createTestAgentFetchContext());

    expect(rows).toEqual([]);
  });
});
