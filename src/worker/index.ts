import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { PatchRequest } from '../bot/types';
import { JobQueue, QueuedJob } from '../queue';
import { runAgent } from './agent';
import { Decision, DECISION_HELP } from './decisions';
import { DiscordSurface } from './discord-surface';
import { GameServer } from './game-server';
import { agentDiffStat, commitPaths, currentBranch, dirtyPaths, push } from './git';
import { Ledger, LedgerEntry } from './ledger';
import { park } from './park';
import { restorePersisted, TreeSnapshot } from './snapshot';

const run = promisify(execFile);

export interface WorkerConfig {
  repoRoot: string;
  /** `.queue` by default; inflight/ and parked/ live under it. */
  stateRoot: string;
  batchLimit: number;
  leaseMs: number;
  agentTimeoutMs: number;
  intervalMs: number;
  pushOnLand: boolean;
}

export interface WorkerDeps {
  queue: JobQueue<PatchRequest>;
  ledger: Ledger;
  gameServer: GameServer;
  surface: DiscordSurface;
  config: WorkerConfig;
  /** Read at send time, not construction — the tunnel comes up asynchronously. */
  tunnelUrl: () => string | null;
}

/**
 * Claims batches of Discord requests, hands them to an agent, and waits for a
 * human to react before anything is committed.
 *
 * Strictly one batch at a time. The agent edits the real working tree, so a
 * second batch starting before the first is resolved would interleave two sets
 * of changes with no way to tell them apart.
 */
export class Worker {
  private busy = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: WorkerDeps) {}

  /** Re-attach to work that was in flight when we last shut down, then start the loop. */
  async start(): Promise<void> {
    await this.recover();
    await this.runPass();
    this.timer = setInterval(() => void this.runPass(), this.deps.config.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Startup reconciliation.
   *
   * `in-progress` means we died mid-agent: the tree may hold half-finished
   * edits we can't attribute, so the honest move is to say so rather than
   * guess. `awaiting-decision` means the work is done and sound — go and see
   * whether someone reacted while we were gone.
   */
  private async recover(): Promise<void> {
    for (const entry of this.deps.ledger.byStatus('in-progress')) {
      await this.deps.ledger.setStatus(entry.messageId, 'failed', {
        error: 'worker exited while the agent was running',
      });
      await this.deps.surface.say(
        entry.channelId,
        `Restarted while working on "${clip(entry.request.text, 120)}" — that run was abandoned. ` +
          `Check \`git status\` for stray edits, then ask again.`
      );
    }

    const groups = groupByPrompt(this.deps.ledger.byStatus('awaiting-decision'));
    for (const [promptMessageId, entries] of groups) {
      const decision = await this.deps.surface.existingDecision(entries[0].channelId, promptMessageId);
      if (decision) {
        console.log(`[worker] resuming ${promptMessageId} with decision "${decision}"`);
        await this.applyDecision(promptMessageId, decision);
      } else {
        await this.deps.surface.say(
          entries[0].channelId,
          `Back up — still holding ${entries.length} finished change${entries.length === 1 ? '' : 's'} ` +
            `waiting on a reaction.\n${DECISION_HELP}`
        );
      }
    }
  }

  /** One claim-and-build cycle. No-op if busy or if a decision is outstanding. */
  async runPass(): Promise<void> {
    if (this.busy) return;
    if (this.deps.ledger.byStatus('awaiting-decision').length > 0) return;

    this.busy = true;
    try {
      await this.buildBatch();
    } catch (err) {
      console.error('[worker] pass failed', err);
    } finally {
      this.busy = false;
    }
  }

  private async buildBatch(): Promise<void> {
    const { queue, ledger, surface, config } = this.deps;
    const claimed = await queue.claim(config.batchLimit, config.leaseMs);
    if (claimed.length === 0) return;

    // Anything already resolved is a duplicate delivery — drop it.
    const done = claimed.filter((job) => ledger.isResolved(job.payload.origin.messageId));
    if (done.length) await queue.ack(done.map((job) => job.id));

    // One channel per batch, so the approval prompt has an unambiguous home.
    const rest = claimed.filter((job) => !ledger.isResolved(job.payload.origin.messageId));
    if (rest.length === 0) return;
    const channelId = rest[0].payload.origin.channelId;
    const batch = rest.filter((job) => job.payload.origin.channelId === channelId);
    const deferred = rest.filter((job) => job.payload.origin.channelId !== channelId);
    if (deferred.length) await queue.release(deferred.map((job) => job.id));

    for (const job of batch) await this.record(job, 'in-progress');
    await surface.say(
      channelId,
      `Working on ${batch.length} request${batch.length === 1 ? '' : 's'}…`
    );

    // Captured before the agent runs so the prompt can warn when it edits a
    // file that already held unrelated uncommitted work.
    const dirtyBefore = await dirtyPaths(config.repoRoot);
    const snapshot = await TreeSnapshot.capture(config.repoRoot);
    const outcome = await runAgent(
      batch.map((job) => job.payload),
      { repoRoot: config.repoRoot, timeoutMs: config.agentTimeoutMs }
    );
    const touched = await snapshot.changedPaths();

    if (touched.length === 0) {
      for (const job of batch) {
        await ledger.setStatus(job.payload.origin.messageId, 'failed', { error: 'agent changed nothing' });
      }
      await queue.ack(batch.map((job) => job.id));
      await surface.say(channelId, `No files changed.\n\`\`\`\n${clip(outcome.output, 1200)}\n\`\`\``);
      return;
    }

    const inflightDir = path.join(config.stateRoot, 'inflight', batch[0].id);
    await snapshot.persistBefore(inflightDir, touched);

    const promptMessageId = await surface.postPrompt(
      channelId,
      await this.describe(batch, touched, outcome.output, dirtyBefore, inflightDir)
    );
    if (!promptMessageId) {
      // Nowhere to ask, so don't leave the tree modified behind our back.
      await restorePersisted(config.repoRoot, inflightDir);
      for (const job of batch) {
        await ledger.setStatus(job.payload.origin.messageId, 'failed', { error: 'could not post approval prompt' });
      }
      await queue.ack(batch.map((job) => job.id));
      return;
    }

    for (const job of batch) {
      await ledger.setStatus(job.payload.origin.messageId, 'awaiting-decision', {
        promptMessageId,
        files: touched,
        inflightDir,
        summary: outcome.output,
      });
    }
    // The ledger owns this work now; the queue's part is over.
    await queue.ack(batch.map((job) => job.id));
  }

  /** Called by the bot when someone reacts, and by recover() on startup. */
  async applyDecision(promptMessageId: string, decision: Decision): Promise<void> {
    const { ledger, surface, config } = this.deps;
    const entries = ledger.byPromptMessage(promptMessageId);
    if (entries.length === 0) return;
    if (entries[0].status !== 'awaiting-decision') return; // already settled

    const { channelId, files = [], inflightDir, summary = '' } = entries[0];

    try {
      switch (decision) {
        case 'land':
          await this.land(entries, files, summary, channelId);
          break;
        case 'park': {
          const dir = await park(
            config.repoRoot,
            path.join(config.stateRoot, 'parked'),
            entries[0].jobId,
            files,
            summary,
            entries.map(toRequest)
          );
          if (inflightDir) await restorePersisted(config.repoRoot, inflightDir);
          for (const entry of entries) await ledger.setStatus(entry.messageId, 'parked', { parkedAt: dir });
          await surface.say(
            channelId,
            `📦 Parked — working tree is back to how it was.\n` +
              `Apply it later with \`npm run queue:apply ${entries[0].jobId}\`.`
          );
          break;
        }
        case 'discard':
          if (inflightDir) await restorePersisted(config.repoRoot, inflightDir);
          for (const entry of entries) await ledger.setStatus(entry.messageId, 'discarded');
          await surface.say(channelId, '🗑️ Binned — working tree is back to how it was.');
          break;
      }
    } catch (err) {
      console.error('[worker] decision failed', err);
      await surface.say(channelId, `Something went wrong applying that: ${String(err)}`);
      return;
    }

    if (inflightDir) await fs.rm(inflightDir, { recursive: true, force: true });
    void this.runPass(); // anything that queued up while we were waiting
  }

  private async land(
    entries: LedgerEntry[],
    files: string[],
    summary: string,
    channelId: string
  ): Promise<void> {
    const { ledger, surface, gameServer, config } = this.deps;

    const commit = await commitPaths(config.repoRoot, files, commitMessage(entries, summary));
    if (!commit.ok) {
      await surface.say(channelId, `Commit failed, nothing landed:\n\`\`\`\n${clip(commit.output, 1200)}\n\`\`\``);
      return;
    }

    const lines = [`🚀 Committed \`${commit.output}\` (${files.length} file${files.length === 1 ? '' : 's'}).`];

    if (config.pushOnLand) {
      const branch = await currentBranch(config.repoRoot);
      const pushed = await push(config.repoRoot, branch);
      lines.push(pushed.ok ? `Pushed to \`origin/${branch}\`.` : `Push failed: ${clip(pushed.output, 300)}`);
    }

    // public/ is served off disk, so only server-side changes need a bounce.
    if (files.some((file) => !file.startsWith('public/'))) {
      const restarted = await gameServer.restart();
      lines.push(
        restarted
          ? 'Server restarted.'
          : "Server changed, but it isn't mine to restart. Bounce it yourself to pick this up."
      );
    } else {
      lines.push('Client-only change — just refresh, no restart needed.');
    }

    const url = this.deps.tunnelUrl();
    if (url) lines.push(`Same as ever: ${url}`);

    for (const entry of entries) await ledger.setStatus(entry.messageId, 'landed');
    await surface.say(channelId, lines.join('\n'));
  }

  private async record(job: QueuedJob<PatchRequest>, status: 'in-progress'): Promise<void> {
    await this.deps.ledger.put({
      messageId: job.payload.origin.messageId,
      jobId: job.id,
      channelId: job.payload.origin.channelId,
      status,
      request: {
        text: job.payload.text,
        authorId: job.payload.author.id,
        authorName: job.payload.author.username,
        url: job.payload.origin.url,
      },
    });
  }

  /** The approval prompt. Typecheck result is in here because it's the cheap signal. */
  private async describe(
    batch: QueuedJob<PatchRequest>[],
    files: string[],
    agentOutput: string,
    dirtyBefore: Set<string>,
    inflightDir: string
  ): Promise<string> {
    const stat = await agentDiffStat(this.deps.config.repoRoot, inflightDir, files);
    const check = await typecheck(this.deps.config.repoRoot);

    // Landing commits whole files. Where the agent edited something that
    // already had uncommitted work in it, that work rides along — the two sets
    // of edits are in the same file and can't be separated.
    const overlap = files.filter((file) => dirtyBefore.has(file));

    return [
      `**Done — ${batch.length} request${batch.length === 1 ? '' : 's'}, ${files.length} file${files.length === 1 ? '' : 's'} changed.**`,
      '',
      clip(agentOutput, 700),
      '',
      check.ok ? '✅ `tsc --noEmit` passes' : `⚠️ typecheck failed:\n\`\`\`\n${clip(check.output, 400)}\n\`\`\``,
      overlap.length
        ? `⚠️ already had uncommitted work, so landing commits that too: ${overlap.map((f) => `\`${f}\``).join(', ')}`
        : '',
      stat ? `\`\`\`\n${clip(stat, 400)}\n\`\`\`` : '',
      DECISION_HELP,
    ]
      .filter(Boolean)
      .join('\n');
  }
}

async function typecheck(repoRoot: string): Promise<{ ok: boolean; output: string }> {
  try {
    await run('npx', ['tsc', '--noEmit'], { cwd: repoRoot, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, output: '' };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: (e.stdout || e.stderr || e.message || '').trim() };
  }
}

function commitMessage(entries: LedgerEntry[], summary: string): string {
  const subject =
    entries.length === 1
      ? `bot: ${clip(entries[0].request.text, 60)}`
      : `bot: apply ${entries.length} requests from Discord`;

  const body = entries.map((e) => `- ${e.request.text} (${e.request.authorName}, ${e.request.url})`).join('\n');

  return [subject, '', body, '', clip(summary, 1000), '', 'Co-Authored-By: Claude <noreply@anthropic.com>'].join('\n');
}

function groupByPrompt(entries: LedgerEntry[]): Map<string, LedgerEntry[]> {
  const groups = new Map<string, LedgerEntry[]>();
  for (const entry of entries) {
    if (!entry.promptMessageId) continue;
    const bucket = groups.get(entry.promptMessageId) ?? [];
    bucket.push(entry);
    groups.set(entry.promptMessageId, bucket);
  }
  return groups;
}

function toRequest(entry: LedgerEntry): PatchRequest {
  return {
    source: 'discord',
    text: entry.request.text,
    author: { id: entry.request.authorId, username: entry.request.authorName },
    origin: { guildId: null, channelId: entry.channelId, messageId: entry.messageId, url: entry.request.url },
    createdAt: entry.updatedAt,
  };
}

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}
