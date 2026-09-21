import { spawn } from 'child_process';
import { PatchRequest } from '../bot/types';

export interface AgentOutcome {
  ok: boolean;
  /** Whatever the agent printed. Trimmed for Discord's 2000-char limit later. */
  output: string;
}

export interface AgentOptions {
  repoRoot: string;
  timeoutMs: number;
}

/**
 * Hands a batch of requests to `claude -p` as a single prompt.
 *
 * acceptEdits lets it read and write files without a prompt, but stops short of
 * bypassing everything — it can't run arbitrary shell commands, so it can't
 * start servers, commit, or push. Landing the change is this worker's job, and
 * only after a human reacts.
 */
export async function runAgent(requests: PatchRequest[], opts: AgentOptions): Promise<AgentOutcome> {
  const args = [
    '-p',
    buildPrompt(requests),
    '--permission-mode',
    'acceptEdits',
    '--output-format',
    'text',
  ];

  return new Promise<AgentOutcome>((resolve) => {
    const child = spawn('claude', args, { cwd: opts.repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: string[] = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, opts.timeoutMs);

    child.stdout.on('data', (d: Buffer) => chunks.push(d.toString()));
    child.stderr.on('data', (d: Buffer) => chunks.push(d.toString()));

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `Could not start the claude CLI: ${err.message}` });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const output = chunks.join('').trim();
      if (timedOut) {
        resolve({ ok: false, output: `Agent timed out after ${opts.timeoutMs / 1000}s.\n\n${output}` });
        return;
      }
      resolve({ ok: code === 0, output: output || '(no output)' });
    });
  });
}

/**
 * One prompt, N requests. Batching is the point — several small tuning tweaks
 * are cheaper and more coherent to apply together than one at a time.
 */
function buildPrompt(requests: PatchRequest[]): string {
  const items = requests
    .map((req, i) => `${i + 1}. (from ${req.author.username}) ${req.text}`)
    .join('\n');

  return [
    'These change requests came in from Discord for this game. Apply all of them.',
    '',
    items,
    '',
    'Constraints:',
    '- Edit files only. Do not commit, do not push, do not create branches.',
    '- Do not start, stop or restart any server. One may already be running on port 2567.',
    '- public/ is served off disk and is live; src/ needs a server restart to take effect.',
    '- The working tree has unrelated uncommitted work in it. Leave anything you were not asked about alone.',
    '',
    'Finish with a 1-2 sentence summary per request describing what you changed and where.',
  ].join('\n');
}
