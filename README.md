# @tokentop/agent-pi

Session and token tracking for the [Pi coding agent](https://github.com/earendil-works/pi), and for agents built on it.

Built-in plugin for [tokentop](https://github.com/tokentopapp/tokentop).

## Install

Shipped with tokentop — nothing to install. To pin it yourself:

```bash
bun add @tokentop/agent-pi
```

## Pi-based agents

Pi can be rebranded downstream through `package.json#piConfig`, which changes its config directory and environment variables but not its session format:

```js
export const CONFIG_DIR_NAME = pkg.piConfig?.configDir || '.pi';
export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;
```

So this plugin discovers variants rather than hardcoding `~/.pi`. Any agent following Pi's conventions is tracked with no change here:

| Agent | Config dir | Discovered via |
|---|---|---|
| Pi | `~/.pi/agent` | default |
| Prime | `~/.prime/agent` | directory layout |
| any Pi-based agent | `~/.<name>/agent` | directory layout or `<NAME>_CODING_AGENT_DIR` |

Session directories resolve the way Pi resolves them:

```
<NAME>_CODING_AGENT_SESSION_DIR  >  settings.json#sessionDir  >  <agentDir>/sessions
```

Both on-disk layouts are read: Pi's per-project nesting (`<root>/<encoded-cwd>/<timestamp>_<uuid>.jsonl`) and the flat form (`<root>/<uuid>.jsonl`). Each usage row is tagged with `metadata.variant`.

## What gets counted

Pi attaches usage to more than just assistant messages, and all of it is billed:

| Entry type | Usage |
|---|---|
| `message` | assistant turns |
| `usage` | standalone notices, e.g. cache warming |
| `compaction` | the summarisation call itself |
| `branch_summary` | the branch summarisation call |
| `child_usage_attributed` | spawned subagent turns |

`child_usage_attributed` matters most. Measured against 74 real session files, of which 57 carry any usage: all 2,347 `childUsage` figures appeared nowhere in the message stream, and accounted for 7.3% of total spend — counting only `message` entries silently loses it. Its sibling `aggregateUsage` field is a running total scoped to the child task, so it is deliberately ignored; summing it double-counts.

Two usage fields are documented subsets and are never added on top of their parents:

- `reasoning` is already included in `output`
- `cacheWrite1h` is already included in `cacheWrite`

Costs are deliberately **not** taken from Pi. Pi writes a `usage.cost.total` for every call, but it can only price routes it has a rate table for — across 74 real session files, 93% of calls went through gateway providers (`meridian-local`, `anthropic-litellm`, `litellm`, `meridian`) and were recorded as `0`, understating the list-rate value of those tokens by roughly 27x. Every request still lands at a real provider, so tokentop prices the tokens itself at models.dev rates including the cache read/write tiers, exactly as it does for every other agent.

## Forked sessions

`/fork`, `/clone` and branch extraction copy a session's history into a new file verbatim — same entry ids, same token counts. Both files then describe the same spend.

Rows are de-duplicated by entry id plus token counts, with sessions processed oldest-header-first, so the original session keeps the shared history and only the fork's own turns are added to it. Header creation time is used rather than mtime: appending to a parent later must not hand ownership of its own past spend to the fork.

## Providers

Pi-based agents often route through a proxy and report its name as the provider — real sessions carry `meridian-local`, `anthropic-litellm`, `litellm` and `openai-codex`. None of these exist in a pricing table.

Resolution order:

1. Pi's provider id, when models.dev knows it. Aggregators such as `openrouter` stop here, since they legitimately key models as `vendor/model`.
2. The vendor prefix of a `vendor/model` id, with the prefix stripped — how proxies pass the real vendor through.
3. The model id prefix (`claude-` → `anthropic`, `gpt-` → `openai`, and so on).
4. Pi's raw provider id, unchanged.

Step 4 is deliberate: an unrecognised provider surfaces as a *missing* price rather than a confidently wrong one.

## Performance

tokentop polls `parseSessions` on a timer, so the plugin avoids re-reading unchanged files:

- 2s TTL cache over the full parse result
- per-file parse cache keyed by path, invalidated by mtime, LRU-capped
- recursive `fs.watch` dirty-path tracking, with a 10-minute reconciliation sweep as a backstop
- append-only offset tracking for real-time activity, so only newly written bytes are parsed

Measured on 74 session files / 57 sessions with usage / 5,630 usage rows: 144ms cold, 1.4ms warm.

## API

```ts
import piAgentPlugin, { discoverVariants, parseSessionFile } from '@tokentop/agent-pi';

const variants = await discoverVariants();
// [{ name: 'prime', agentDir: '~/.prime/agent', sessionsRoot: '~/.prime/agent/sessions' }]
```

## Credits

The Pi plugin was first contributed by [@i3wangyi](https://github.com/i3wangyi) in [tokentopapp/tokentop#109](https://github.com/tokentopapp/tokentop/pull/109), which prompted making Pi support official. The session discovery and provider-inference approach here started from that work.

## License

MIT
