import { execFile } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { promisify } from 'util';

const run = promisify(execFile);

export interface GitResult {
  ok: boolean;
  output: string;
}

/** Repo-relative paths with uncommitted changes right now. */
export async function dirtyPaths(root: string): Promise<Set<string>> {
  const { stdout } = await run('git', ['status', '--porcelain', '-z'], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  const paths = new Set<string>();
  // -z output: "XY <path>\0", and renames add a second \0-terminated path we
  // don't care about here.
  for (const record of stdout.split('\0')) {
    if (record.length > 3) paths.add(record.slice(3));
  }
  return paths;
}

export async function currentBranch(root: string): Promise<string> {
  const { stdout } = await run('git', ['branch', '--show-current'], { cwd: root });
  return stdout.trim();
}

/**
 * Line counts for what the *agent* changed, diffed against the pre-agent
 * snapshot rather than HEAD.
 *
 * `git diff --stat` would measure HEAD → now, which in this repo is dominated
 * by whatever was already uncommitted — a one-line agent edit to a file with
 * 500 lines of work in progress would report 500 insertions and read like the
 * agent had rewritten the file.
 */
export async function agentDiffStat(root: string, beforeDir: string, paths: string[]): Promise<string> {
  const lines: string[] = [];
  let added = 0;
  let removed = 0;

  for (const rel of paths) {
    const before = path.join(beforeDir, 'before', rel);
    const after = path.join(root, rel);
    const stat = await numstat(
      existsSync(before) ? before : '/dev/null',
      existsSync(after) ? after : '/dev/null'
    );
    if (!stat) continue;
    added += stat.added;
    removed += stat.removed;
    lines.push(`${rel} | +${stat.added} -${stat.removed}`);
  }

  if (lines.length === 0) return '';
  return `${lines.join('\n')}\n${paths.length} file(s), +${added} -${removed}`;
}

/** `git diff --no-index` exits 1 when the files differ, which isn't an error. */
async function numstat(a: string, b: string): Promise<{ added: number; removed: number } | null> {
  const out = await run('git', ['diff', '--no-index', '--numstat', '--', a, b], {
    maxBuffer: 8 * 1024 * 1024,
  })
    .then((r) => r.stdout)
    .catch((err: { stdout?: string }) => err.stdout ?? '');

  const [first] = out.trim().split('\n');
  if (!first) return { added: 0, removed: 0 };
  const [add, del] = first.split('\t');
  if (add === '-' || del === '-') return null; // binary
  return { added: Number(add) || 0, removed: Number(del) || 0 };
}

/**
 * Stage and commit only the listed paths. Never `git add -A` across the repo —
 * the tree is full of unrelated work in progress that isn't ours to commit.
 */
export async function commitPaths(root: string, paths: string[], message: string): Promise<GitResult> {
  if (paths.length === 0) return { ok: false, output: 'nothing to commit' };
  try {
    // -A over an explicit pathspec picks up deletions as well as edits.
    await run('git', ['add', '-A', '--', ...paths], { cwd: root });
    await run('git', ['commit', '-m', message], { cwd: root });
    const { stdout } = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: root });
    return { ok: true, output: stdout.trim() };
  } catch (err) {
    return { ok: false, output: errText(err) };
  }
}

export async function push(root: string, branch: string): Promise<GitResult> {
  try {
    const { stdout, stderr } = await run('git', ['push', 'origin', branch], { cwd: root });
    return { ok: true, output: `${stdout}${stderr}`.trim() };
  } catch (err) {
    return { ok: false, output: errText(err) };
  }
}

function errText(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string };
  return (e.stderr || e.stdout || e.message || String(err)).trim();
}
