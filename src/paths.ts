import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PiSettings, PiVariant } from './types.ts';
import { expandTilde, homeDir, readJsonFile } from './utils.ts';

/**
 * Pi can be rebranded by downstream agents through `package.json#piConfig`:
 *
 * ```js
 * const piConfigName = pkg.piConfig?.name;              // -> APP_NAME
 * export const CONFIG_DIR_NAME = pkg.piConfig?.configDir || '.pi';
 * export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;
 * ```
 *
 * So a derived agent such as Prime stores sessions in `~/.prime/agent/sessions`
 * and reads `PRIME_CODING_AGENT_DIR`, while writing byte-identical session
 * files. Everything here is therefore variant-aware rather than hardcoded to
 * `~/.pi`, so Pi-based agents are tracked without a code change per agent.
 */

/** Canonical upstream variant, used for the static plugin descriptor. */
export const PI_VARIANT_NAME = 'pi';

/** Default agent config directory for upstream Pi. */
export const DEFAULT_PI_HOME = path.join(os.homedir(), '.pi', 'agent');

/** Default sessions directory for upstream Pi. */
export const DEFAULT_PI_SESSIONS_PATH = path.join(DEFAULT_PI_HOME, 'sessions');

/** `<NAME>_CODING_AGENT_DIR` — matches `ENV_AGENT_DIR` for any variant. */
const ENV_AGENT_DIR_RE = /^([A-Z0-9]+)_CODING_AGENT_DIR$/;

/** `<NAME>_CODING_AGENT_SESSION_DIR` — matches `ENV_SESSION_DIR` for any variant. */
const ENV_SESSION_DIR_RE = /^([A-Z0-9]+)_CODING_AGENT_SESSION_DIR$/;

/** Env var Pi itself reads for its agent dir. */
export const ENV_AGENT_DIR = 'PI_CODING_AGENT_DIR';

/** Env var Pi itself reads for an explicit session dir. */
export const ENV_SESSION_DIR = 'PI_CODING_AGENT_SESSION_DIR';

async function isDirectory(target: string): Promise<boolean> {
  try {
    const stat = await fs.stat(target);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolves a variant's sessions root, following Pi's own precedence:
 *
 *   `<NAME>_CODING_AGENT_SESSION_DIR` > `settings.json#sessionDir` > `<agentDir>/sessions`
 *
 * All three matter — a user who relocated their session directory would
 * otherwise appear to have no usage at all.
 */
async function resolveSessionsRoot(name: string, agentDir: string): Promise<string> {
  const envSessionDir = process.env[`${name.toUpperCase()}_CODING_AGENT_SESSION_DIR`];
  if (envSessionDir) return expandTilde(envSessionDir);

  const settings = await readJsonFile<PiSettings>(path.join(agentDir, 'settings.json'));
  const configured = settings?.sessionDir?.trim();
  if (configured) return expandTilde(configured);

  return path.join(agentDir, 'sessions');
}

/** Agent config dir for a variant: `<NAME>_CODING_AGENT_DIR` or `~/.<name>/agent`. */
export function getAgentDir(name: string = PI_VARIANT_NAME): string {
  const env = process.env[`${name.toUpperCase()}_CODING_AGENT_DIR`];
  if (env) return expandTilde(env);
  return path.join(homeDir(), `.${name}`, 'agent');
}

/**
 * Collects candidate variant names from the environment.
 *
 * Scanning by pattern rather than by a known list means a brand-new Pi-based
 * agent is picked up with no change here, as long as it follows Pi's env
 * convention.
 */
function variantNamesFromEnv(): Set<string> {
  const names = new Set<string>();
  for (const key of Object.keys(process.env)) {
    const agentMatch = ENV_AGENT_DIR_RE.exec(key);
    if (agentMatch?.[1]) names.add(agentMatch[1].toLowerCase());
    const sessionMatch = ENV_SESSION_DIR_RE.exec(key);
    if (sessionMatch?.[1]) names.add(sessionMatch[1].toLowerCase());
  }
  return names;
}

/**
 * Collects candidate variant names by looking for the Pi directory layout
 * (`~/.<name>/agent/sessions`) in the user's home directory.
 */
async function variantNamesFromHome(): Promise<Set<string>> {
  const names = new Set<string>();
  let entries;
  try {
    entries = await fs.readdir(homeDir(), { withFileTypes: true });
  } catch {
    return names;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('.')) continue;
    const name = entry.name.slice(1);
    if (!name || name.includes('.')) continue;
    if (await isDirectory(path.join(homeDir(), entry.name, 'agent', 'sessions'))) {
      names.add(name.toLowerCase());
    }
  }
  return names;
}

/**
 * Discovers every installed Pi or Pi-derived agent that has a sessions
 * directory on disk.
 *
 * Variants are de-duplicated by resolved sessions root, so an env override
 * pointing at an already-discovered directory does not yield two entries.
 */
export async function discoverVariants(): Promise<PiVariant[]> {
  const candidates = new Set<string>([PI_VARIANT_NAME]);
  for (const name of variantNamesFromEnv()) candidates.add(name);
  for (const name of await variantNamesFromHome()) candidates.add(name);

  const byRoot = new Map<string, PiVariant>();

  for (const name of candidates) {
    const agentDir = getAgentDir(name);
    const sessionsRoot = await resolveSessionsRoot(name, agentDir);
    if (byRoot.has(sessionsRoot)) continue;
    if (!(await isDirectory(sessionsRoot))) continue;
    byRoot.set(sessionsRoot, { name, agentDir, sessionsRoot });
  }

  return Array.from(byRoot.values());
}

/**
 * Lists session `.jsonl` files for a variant.
 *
 * Two layouts are in the wild and both are supported:
 *   - nested, as upstream Pi writes:  `<root>/<encoded-cwd>/<timestamp>_<uuid>.jsonl`
 *   - flat, as Prime writes:          `<root>/<uuid>.jsonl`
 */
export async function listSessionFiles(sessionsRoot: string): Promise<string[]> {
  const files: string[] = [];

  let entries;
  try {
    entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(path.join(sessionsRoot, entry.name));
      continue;
    }
    if (!entry.isDirectory()) continue;

    const projectDir = path.join(sessionsRoot, entry.name);
    let nested;
    try {
      nested = await fs.readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of nested) {
      if (child.isFile() && child.name.endsWith('.jsonl')) {
        files.push(path.join(projectDir, child.name));
      }
    }
  }

  return files;
}

/** Directories to watch for a variant: the root plus its project subdirectories. */
export async function listWatchDirs(sessionsRoot: string): Promise<string[]> {
  const dirs = [sessionsRoot];
  try {
    const entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.push(path.join(sessionsRoot, entry.name));
    }
  } catch {
    // Root unreadable — watching just the root is the best we can do
  }
  return dirs;
}
