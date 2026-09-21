import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

const run = promisify(execFile);

/**
 * A copy of every file git cares about, taken before the agent runs.
 *
 * Reverting has to restore *this*, not HEAD. The working tree is normally full
 * of Jordan's uncommitted work, so `git checkout -- <file>` on a file the agent
 * happened to also edit would throw that work away. Restoring from the snapshot
 * puts the tree back exactly as the agent found it.
 */
export class TreeSnapshot {
  private constructor(
    private readonly root: string,
    private readonly files: Map<string, Buffer>
  ) {}

  static async capture(root: string): Promise<TreeSnapshot> {
    const paths = await trackedAndUntracked(root);
    const files = new Map<string, Buffer>();
    for (const rel of paths) {
      const content = await fs.readFile(path.join(root, rel)).catch(() => null);
      if (content) files.set(rel, content);
    }
    return new TreeSnapshot(root, files);
  }

  /** Repo-relative paths that differ from the snapshot: edited, added or deleted. */
  async changedPaths(): Promise<string[]> {
    const now = await trackedAndUntracked(this.root);
    const touched = new Set<string>();

    for (const rel of now) {
      const before = this.files.get(rel);
      const after = await fs.readFile(path.join(this.root, rel)).catch(() => null);
      if (!after) {
        // --cached lists the index, so a file the agent deleted from the
        // working tree is still named here. Unreadable + previously present
        // means deleted, not absent.
        if (before) touched.add(rel);
        continue;
      }
      if (!before || !before.equals(after)) touched.add(rel);
    }
    // Untracked files the agent removed drop out of the listing entirely.
    for (const rel of this.files.keys()) {
      if (!now.includes(rel)) touched.add(rel);
    }
    return [...touched].sort();
  }

  /** Put the given paths back the way they were before the agent ran. */
  async restore(paths: string[]): Promise<void> {
    for (const rel of paths) {
      const full = path.join(this.root, rel);
      const before = this.files.get(rel);
      if (before) {
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, before);
      } else {
        // The agent created it; it didn't exist before, so it shouldn't now.
        await fs.rm(full, { force: true });
      }
    }
  }

  /**
   * Write the pre-agent contents of `paths` to disk.
   *
   * The snapshot lives in memory, so a crash between "agent finished" and
   * "human reacted" would otherwise strand the working tree with changes we no
   * longer know how to undo. Persisting just the touched files is enough to
   * make discard and park survive a restart.
   */
  async persistBefore(dir: string, paths: string[]): Promise<void> {
    const existed: string[] = [];
    const absent: string[] = [];
    await fs.rm(dir, { recursive: true, force: true });

    for (const rel of paths) {
      const before = this.files.get(rel);
      if (!before) {
        absent.push(rel);
        continue;
      }
      const dest = path.join(dir, 'before', rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, before);
      existed.push(rel);
    }

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ existed, absent }, null, 2), 'utf8');
  }
}

/** Undo an agent's work using the contents persisted by `persistBefore`. */
export async function restorePersisted(root: string, dir: string): Promise<void> {
  const raw = await fs.readFile(path.join(dir, 'manifest.json'), 'utf8');
  const { existed, absent } = JSON.parse(raw) as { existed: string[]; absent: string[] };

  for (const rel of existed) {
    const content = await fs.readFile(path.join(dir, 'before', rel));
    const dest = path.join(root, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, content);
  }
  for (const rel of absent) {
    await fs.rm(path.join(root, rel), { force: true });
  }
}

/**
 * Tracked files plus untracked ones git would let you add. Uses git's own
 * ignore rules, so node_modules, .env, .queue and the big binary assets stay
 * out without a second exclude list to keep in sync.
 */
async function trackedAndUntracked(root: string): Promise<string[]> {
  const { stdout } = await run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.split('\0').filter(Boolean);
}
