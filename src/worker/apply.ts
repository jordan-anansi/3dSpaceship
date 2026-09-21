import fs from 'fs/promises';
import path from 'path';
import { applyParked, readParked } from './park';

/**
 * `npm run queue:apply <jobId>` — copy a parked change back over the working
 * tree. With no id, lists what's parked.
 */
async function main(): Promise<void> {
  const repoRoot = process.env.REPO_ROOT ?? process.cwd();
  const parkRoot = path.join(process.env.QUEUE_DIR ?? path.join(repoRoot, '.queue'), 'parked');
  const jobId = process.argv[2];

  if (!jobId) {
    const ids = await fs.readdir(parkRoot).catch(() => [] as string[]);
    if (ids.length === 0) {
      console.log('Nothing parked.');
      return;
    }
    console.log('Parked changes:\n');
    for (const id of ids) {
      const meta = await readParked(path.join(parkRoot, id)).catch(() => null);
      if (!meta) continue;
      console.log(`  ${id}  ${meta.parkedAt}  ${meta.files.length} file(s)`);
      for (const req of meta.requests) console.log(`      ${req.author.username}: ${req.text}`);
    }
    console.log('\nApply one with: npm run queue:apply <id>');
    return;
  }

  const dir = path.join(parkRoot, jobId);
  const applied = await applyParked(repoRoot, dir);
  console.log(`Applied ${applied.length} file(s):`);
  for (const rel of applied) console.log(`  ${rel}`);
  console.log('\nNothing is committed — review with `git diff`, then commit yourself.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
