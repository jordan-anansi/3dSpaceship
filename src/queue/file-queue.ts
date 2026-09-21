import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { JobQueue, QueuedJob } from './types';

const PENDING = 'pending';
const CLAIMED = 'claimed';

/**
 * Filesystem-backed queue: one JSON file per job, claimed by renaming it into a
 * sibling directory. Rename is atomic on POSIX, so two workers racing for the
 * same job produce one winner and one ENOENT.
 *
 * Fine for local dev and for a worker sharing a box with the bot. A genuinely
 * remote worker needs a networked backend — see createQueue().
 */
export class FileQueue<T> implements JobQueue<T> {
  constructor(private readonly root: string) {}

  async enqueue(payload: T): Promise<QueuedJob<T>> {
    await this.ensureDirs();
    const job: QueuedJob<T> = {
      id: crypto.randomUUID(),
      payload,
      enqueuedAt: new Date().toISOString(),
      attempts: 0,
    };
    await this.write(PENDING, job);
    return job;
  }

  async claim(limit: number, leaseMs: number): Promise<QueuedJob<T>[]> {
    await this.ensureDirs();
    await this.reap(leaseMs);

    const claimed: QueuedJob<T>[] = [];
    for (const name of await this.list(PENDING)) {
      if (claimed.length >= limit) break;
      try {
        await fs.rename(this.file(PENDING, name), this.file(CLAIMED, name));
      } catch (err) {
        if (isEnoent(err)) continue; // another worker got there first
        throw err;
      }
      const job = await this.read(CLAIMED, name);
      if (job) claimed.push(job);
    }
    return claimed;
  }

  async peek(limit: number): Promise<QueuedJob<T>[]> {
    const jobs: QueuedJob<T>[] = [];
    for (const name of (await this.list(PENDING)).slice(0, limit)) {
      const job = await this.read(PENDING, name);
      if (job) jobs.push(job);
    }
    return jobs;
  }

  async ack(ids: string[]): Promise<void> {
    for (const name of await this.locate(CLAIMED, ids)) {
      await fs.rm(this.file(CLAIMED, name), { force: true });
    }
  }

  async release(ids: string[]): Promise<void> {
    for (const name of await this.locate(CLAIMED, ids)) {
      // Same filename in both buckets, so the job keeps its FIFO position.
      await fs.rename(this.file(CLAIMED, name), this.file(PENDING, name)).catch(rethrowUnlessEnoent);
    }
  }

  async depth(): Promise<{ pending: number; claimed: number }> {
    return {
      pending: (await this.list(PENDING)).length,
      claimed: (await this.list(CLAIMED)).length,
    };
  }

  /** Return jobs whose lease has lapsed to the pending bucket. */
  private async reap(leaseMs: number): Promise<void> {
    const cutoff = Date.now() - leaseMs;
    for (const name of await this.list(CLAIMED)) {
      const stat = await fs.stat(this.file(CLAIMED, name)).catch(() => null);
      if (!stat || stat.mtimeMs > cutoff) continue;
      const job = await this.read(CLAIMED, name);
      if (!job) continue;
      job.attempts += 1;
      await this.write(PENDING, job);
      await fs.rm(this.file(CLAIMED, name), { force: true });
    }
  }

  private file(bucket: string, name: string): string {
    return path.join(this.root, bucket, name);
  }

  private async ensureDirs(): Promise<void> {
    await fs.mkdir(path.join(this.root, PENDING), { recursive: true });
    await fs.mkdir(path.join(this.root, CLAIMED), { recursive: true });
  }

  /** Job files in a bucket, oldest first. Ignores in-flight `.tmp` writes. */
  private async list(bucket: string): Promise<string[]> {
    const names = await fs.readdir(path.join(this.root, bucket)).catch((err: unknown) => {
      if (isEnoent(err)) return [] as string[];
      throw err;
    });
    return names.filter((name) => idOf(name) !== null).sort();
  }

  private async locate(bucket: string, ids: string[]): Promise<string[]> {
    const wanted = new Set(ids);
    const names = await this.list(bucket);
    return names.filter((name) => wanted.has(idOf(name)!));
  }

  private async read(bucket: string, name: string): Promise<QueuedJob<T> | null> {
    const raw = await fs.readFile(this.file(bucket, name), 'utf8').catch((err: unknown) => {
      if (isEnoent(err)) return null; // reaped or claimed out from under us
      throw err;
    });
    return raw === null ? null : (JSON.parse(raw) as QueuedJob<T>);
  }

  /** Write via a temp file + rename so a reader never sees a half-written job. */
  private async write(bucket: string, job: QueuedJob<T>): Promise<void> {
    const dest = this.file(bucket, nameFor(job));
    const tmp = `${dest}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(job, null, 2), 'utf8');
    await fs.rename(tmp, dest);
  }
}

/** Zero-padded so a lexicographic filename sort is also a chronological one. */
function nameFor(job: QueuedJob<unknown>): string {
  return `${String(Date.parse(job.enqueuedAt)).padStart(15, '0')}-${job.id}.json`;
}

function idOf(name: string): string | null {
  const match = /^\d{15}-(.+)\.json$/.exec(name);
  return match ? match[1] : null;
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function rethrowUnlessEnoent(err: unknown): void {
  if (!isEnoent(err)) throw err;
}
