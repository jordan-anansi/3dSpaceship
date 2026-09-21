import path from 'path';
import type { WorkerConfig } from '../worker';

export interface BotConfig {
  token: string;
  /** Only messages in these channels are considered. */
  channelIds: Set<string>;
  /** Who may queue work and approve results. Empty means anyone in the channel. */
  allowedUserIds: Set<string>;
  /** Whether to supervise the game server so landed changes can restart it. */
  manageGameServer: boolean;
  /** Whether to run the cloudflared quick tunnel and announce its URL. */
  manageTunnel: boolean;
  gamePort: number;
  worker: WorkerConfig;
}

export function loadBotConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const token = env.DISCORD_TOKEN?.trim();
  if (!token) throw new Error('DISCORD_TOKEN is not set — see .env.example');

  const channelIds = idSet(env.DISCORD_CHANNEL_IDS);
  if (channelIds.size === 0) {
    throw new Error('DISCORD_CHANNEL_IDS must list at least one channel id — see .env.example');
  }

  const repoRoot = env.REPO_ROOT ?? process.cwd();

  return {
    token,
    channelIds,
    allowedUserIds: idSet(env.DISCORD_ALLOWED_USER_IDS),
    manageGameServer: env.MANAGE_GAME_SERVER !== 'false',
    manageTunnel: env.MANAGE_TUNNEL !== 'false',
    gamePort: num(env.PORT, 2567),
    worker: {
      repoRoot,
      stateRoot: env.QUEUE_DIR ?? path.join(repoRoot, '.queue'),
      batchLimit: num(env.BATCH_LIMIT, 10),
      leaseMs: num(env.LEASE_MS, 20 * 60_000),
      agentTimeoutMs: num(env.AGENT_TIMEOUT_MS, 15 * 60_000),
      intervalMs: num(env.WORKER_INTERVAL_MS, 5 * 60_000),
      pushOnLand: env.PUSH_ON_LAND !== 'false',
    },
  };
}

function num(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function idSet(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  );
}
