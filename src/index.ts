import {
  type AgentFetchContext,
  type PluginContext,
  type SessionParseOptions,
  type SessionUsageData,
  createAgentPlugin,
} from '@tokentop/plugin-sdk';
import { CACHE_TTL_MS, SESSION_FILE_CACHE_MAX, clearCaches, sessionCache, sessionFileCache } from './cache.ts';
import {
  inferProviderFromModel,
  parseAllSessions,
  parseSessionFile,
  resolveModelIdentity,
  resolveProviderId,
} from './parser.ts';
import {
  DEFAULT_PI_HOME,
  DEFAULT_PI_SESSIONS_PATH,
  ENV_AGENT_DIR,
  ENV_SESSION_DIR,
  PI_VARIANT_NAME,
  discoverVariants,
  getAgentDir,
  listSessionFiles,
} from './paths.ts';
import { RECONCILIATION_INTERVAL_MS, startActivityWatch, stopActivityWatch, stopAllWatchers } from './watcher.ts';

const piAgentPlugin = createAgentPlugin({
  id: 'pi',
  type: 'agent',
  name: 'Pi',
  version: '0.1.0',

  meta: {
    description:
      'Pi session tracking — supports the Pi coding agent and agents built on it, such as Prime',
    homepage: 'https://github.com/tokentopapp/agent-pi',
  },

  permissions: {
    filesystem: {
      read: true,
      paths: ['~/.pi', '~/.prime'],
    },
  },

  agent: {
    name: 'Pi',
    command: 'pi',
    configPath: DEFAULT_PI_HOME,
    sessionPath: DEFAULT_PI_SESSIONS_PATH,
  },

  capabilities: {
    sessionParsing: true,
    authReading: false,
    realTimeTracking: true,
    multiProvider: true,
  },

  async isInstalled(_ctx: PluginContext): Promise<boolean> {
    const variants = await discoverVariants();
    return variants.length > 0;
  },

  async parseSessions(
    options: SessionParseOptions,
    ctx: AgentFetchContext,
  ): Promise<SessionUsageData[]> {
    return parseAllSessions(options, ctx);
  },

  startActivityWatch(_ctx: PluginContext, callback): void {
    startActivityWatch(callback);
  },

  stopActivityWatch(_ctx: PluginContext): void {
    stopActivityWatch();
  },
});

export {
  CACHE_TTL_MS,
  DEFAULT_PI_HOME,
  DEFAULT_PI_SESSIONS_PATH,
  ENV_AGENT_DIR,
  ENV_SESSION_DIR,
  PI_VARIANT_NAME,
  RECONCILIATION_INTERVAL_MS,
  SESSION_FILE_CACHE_MAX,
  clearCaches,
  discoverVariants,
  getAgentDir,
  inferProviderFromModel,
  listSessionFiles,
  parseAllSessions,
  parseSessionFile,
  resolveModelIdentity,
  resolveProviderId,
  sessionCache,
  sessionFileCache,
  stopAllWatchers,
};

export default piAgentPlugin;
