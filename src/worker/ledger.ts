import fs from 'fs/promises';
import path from 'path';

/**
 * Where a request has got to. The queue only knows pending/claimed, and a job
 * leaves it the moment we post the approval prompt — everything after that
 * lives here, which is what lets a restart pick up work that was built but
 * never landed.
 */
export type JobStatus =
  | 'in-progress'
  | 'awaiting-decision'
  | 'landed'
  | 'parked'
  | 'discarded'
  | 'failed';

/** Terminal states — seeing one of these means don't do the work again. */
const RESOLVED: ReadonlySet<JobStatus> = new Set<JobStatus>(['landed', 'parked', 'discarded']);

export interface LedgerEntry {
  /** The Discord message that asked for the change. Primary key. */
  messageId: string;
  jobId: string;
  channelId: string;
  status: JobStatus;
  updatedAt: string;
  /**
   * Enough of the original request to write a commit message and a park
   * manifest after a restart, without the queue job still being around.
   */
  request: { text: string; authorId: string; authorName: string; url: string };
  /** Our approval prompt. Reactions on it decide the outcome. */
  promptMessageId?: string;
  /** Repo-relative paths the agent touched. */
  files?: string[];
  /** Holds the pre-agent contents of `files`, so a discard can undo the work. */
  inflightDir?: string;
  /** Directory under .queue/parked holding a parked change. */
  parkedAt?: string;
  summary?: string;
  error?: string;
}

/**
 * A JSON document keyed by Discord message id. Small enough to rewrite whole
 * on every change, which keeps it honest — no partial updates to reason about.
 */
export class Ledger {
  private entries = new Map<string, LedgerEntry>();

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    const raw = await fs.readFile(this.file, 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (!raw) return;
    const parsed = JSON.parse(raw) as { entries: LedgerEntry[] };
    this.entries = new Map(parsed.entries.map((entry) => [entry.messageId, entry]));
  }

  get(messageId: string): LedgerEntry | undefined {
    return this.entries.get(messageId);
  }

  /** True once a request has reached a terminal state — don't redo it. */
  isResolved(messageId: string): boolean {
    const status = this.entries.get(messageId)?.status;
    return status !== undefined && RESOLVED.has(status);
  }

  byStatus(status: JobStatus): LedgerEntry[] {
    return [...this.entries.values()].filter((entry) => entry.status === status);
  }

  byPromptMessage(promptMessageId: string): LedgerEntry[] {
    return [...this.entries.values()].filter((entry) => entry.promptMessageId === promptMessageId);
  }

  async put(entry: Omit<LedgerEntry, 'updatedAt'>): Promise<LedgerEntry> {
    const merged: LedgerEntry = {
      ...this.entries.get(entry.messageId),
      ...entry,
      updatedAt: new Date().toISOString(),
    };
    this.entries.set(merged.messageId, merged);
    await this.flush();
    return merged;
  }

  async setStatus(messageId: string, status: JobStatus, extra: Partial<LedgerEntry> = {}): Promise<void> {
    const existing = this.entries.get(messageId);
    if (!existing) throw new Error(`No ledger entry for message ${messageId}`);
    this.entries.set(messageId, { ...existing, ...extra, status, updatedAt: new Date().toISOString() });
    await this.flush();
  }

  private async flush(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const body = JSON.stringify({ entries: [...this.entries.values()] }, null, 2);
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, body, 'utf8');
    await fs.rename(tmp, this.file);
  }
}
