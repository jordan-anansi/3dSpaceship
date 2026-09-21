import fs from 'fs/promises';
import path from 'path';
import { PatchRequest } from '../bot/types';

export interface ParkedMeta {
  jobId: string;
  parkedAt: string;
  summary: string;
  files: string[];
  requests: Array<Pick<PatchRequest, 'text' | 'author' | 'origin'>>;
}

/**
 * Sets a finished change aside instead of committing it.
 *
 * Stores the agent's version of each touched file verbatim rather than a patch.
 * A patch would have to be diffed against a working tree that's permanently
 * dirty and keeps moving; whole files always apply.
 */
export async function park(
  root: string,
  parkRoot: string,
  jobId: string,
  files: string[],
  summary: string,
  requests: PatchRequest[]
): Promise<string> {
  const dir = path.join(parkRoot, jobId);
  await fs.rm(dir, { recursive: true, force: true });

  for (const rel of files) {
    const content = await fs.readFile(path.join(root, rel)).catch(() => null);
    if (!content) continue; // agent deleted it; the manifest still records the path
    const dest = path.join(dir, 'files', rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, content);
  }

  const meta: ParkedMeta = {
    jobId,
    parkedAt: new Date().toISOString(),
    summary,
    files,
    requests: requests.map(({ text, author, origin }) => ({ text, author, origin })),
  };
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  return dir;
}

export async function readParked(dir: string): Promise<ParkedMeta> {
  return JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8')) as ParkedMeta;
}

/** Copy a parked change back over the working tree. */
export async function applyParked(root: string, dir: string): Promise<string[]> {
  const meta = await readParked(dir);
  const applied: string[] = [];
  for (const rel of meta.files) {
    const src = path.join(dir, 'files', rel);
    const content = await fs.readFile(src).catch(() => null);
    const dest = path.join(root, rel);
    if (content) {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, content);
    } else {
      await fs.rm(dest, { force: true }); // the agent had deleted this one
    }
    applied.push(rel);
  }
  return applied;
}
