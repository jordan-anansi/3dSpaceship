import path from 'path';
import { Client, Events, GatewayIntentBits, Message, Partials } from 'discord.js';
import { createQueue } from '../queue';
import { Worker } from '../worker';
import { decisionFor } from '../worker/decisions';
import { DiscordSurface } from '../worker/discord-surface';
import { GameServer } from '../worker/game-server';
import { Ledger } from '../worker/ledger';
import { Tunnel } from '../worker/tunnel';
import { loadBotConfig } from './config';
import { interpret } from './handler';
import { PatchRequest } from './types';

/**
 * One process: listens for change requests in Discord, queues them, batches
 * them into an agent run, and lands the result when someone reacts.
 *
 * It owns the game server as a child process so a landed change can be
 * restarted into. The cloudflared tunnel points at the port rather than the
 * process, so the public URL survives that restart untouched.
 */
async function main(): Promise<void> {
  const config = loadBotConfig();
  const queue = createQueue<PatchRequest>();

  const ledger = new Ledger(path.join(config.worker.stateRoot, 'ledger.json'));
  await ledger.load();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      // Privileged — without it message.content arrives empty.
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
    // Reactions on messages from before startup arrive uncached; without these
    // the events are dropped instead of being fetched on demand.
    partials: [Partials.Message, Partials.Reaction, Partials.Channel],
  });

  const surface = new DiscordSurface(client, config.allowedUserIds);
  const gameServer = new GameServer({ repoRoot: config.worker.repoRoot, port: config.gamePort });
  const tunnel = new Tunnel({ repoRoot: config.worker.repoRoot, port: config.gamePort });
  const worker = new Worker({
    queue,
    ledger,
    gameServer,
    surface,
    config: config.worker,
    tunnelUrl: () => tunnel.url,
  });

  client.once(Events.ClientReady, async (ready) => {
    console.log(`[bot] ${ready.user.tag} watching channels ${[...config.channelIds].join(', ')}`);

    const notes: string[] = [];

    if (config.manageGameServer) {
      const { managed, reason } = await gameServer.start();
      console.log(managed ? `[server] running on :${config.gamePort}` : `[server] unmanaged — ${reason}`);
      notes.push(
        managed
          ? `Server up on :${config.gamePort}.`
          : `Server on :${config.gamePort} isn't mine — I can't restart it for you (${reason}).`
      );
    }

    // After the server, so the tunnel has something to reach on its first probe.
    if (config.manageTunnel) {
      const url = await tunnel.start();
      console.log(url ? `[tunnel] ${url}` : '[tunnel] no URL');
      notes.push(url ? `Play here: ${url}` : 'No tunnel — local only.');
    }

    for (const channelId of config.channelIds) {
      await surface.say(channelId, `**Online.** ${notes.join(' ')}`);
    }

    await worker.start();
    console.log(`[worker] polling every ${config.worker.intervalMs / 1000}s`);
  });

  client.on(Events.MessageCreate, async (message) => {
    const verdict = interpret(message, client.user!.id, config);
    if (verdict.kind === 'ignore') return;
    if (verdict.kind === 'reject') {
      await reply(message, verdict.reason);
      return;
    }

    try {
      const job = await queue.enqueue(verdict.request);
      const { pending } = await queue.depth();
      console.log(`[bot] queued ${job.id} from ${verdict.request.author.username}`);
      await reply(message, `Queued \`${job.id.slice(0, 8)}\` — ${pending} waiting.`);
      void worker.runPass(); // no-op if a batch is already running or awaiting a decision
    } catch (err) {
      console.error('[bot] enqueue failed', err);
      await reply(message, "Couldn't queue that — the queue isn't accepting writes.");
    }
  });

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    const decision = decisionFor(reaction.emoji.name ?? '');
    if (!decision || !surface.mayDecide(user.id, user.bot)) return;

    // Partials arrive hollow; fetch before reading ids off them.
    if (reaction.partial) {
      const full = await reaction.fetch().catch(() => null);
      if (!full) return;
    }
    await worker.applyDecision(reaction.message.id, decision);
  });

  client.on(Events.Error, (err) => console.error('[bot] gateway error', err));

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      console.log(`[bot] ${signal} — shutting down`);
      worker.stop();
      tunnel.stop();
      void Promise.allSettled([gameServer.stop(), client.destroy()]).finally(() => process.exit(0));
    });
  }

  await client.login(config.token);
}

/**
 * Replying needs Send Messages and Read Message History in the channel; a
 * missing permission shouldn't take the listener down with it.
 */
async function reply(message: Message, content: string): Promise<void> {
  try {
    await message.reply({ content, allowedMentions: { repliedUser: false } });
  } catch (err) {
    console.error('[bot] reply failed', err);
  }
}

main().catch((err) => {
  console.error('[bot] fatal', err);
  process.exit(1);
});
