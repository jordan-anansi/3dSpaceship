import { ChildProcess, spawn } from 'child_process';
import net from 'net';
import path from 'path';

export interface GameServerOptions {
  repoRoot: string;
  port: number;
}

/**
 * Supervises the Colyseus server so a landed change can be restarted into.
 *
 * The cloudflared quick tunnel points at localhost:<port> and has no idea what
 * is listening there, so bouncing the server keeps the same *.trycloudflare.com
 * address — there's a short 502 window and nothing else. Don't restart
 * cloudflared and the URL holds.
 *
 * Only ever touches a process it spawned. If something is already on the port
 * when we start, that's Jordan's own `npm start` and it stays his: we mark
 * ourselves unmanaged and tell him to restart it by hand.
 */
export class GameServer {
  private child: ChildProcess | null = null;
  private managed = false;

  constructor(private readonly opts: GameServerOptions) {}

  get isManaged(): boolean {
    return this.managed;
  }

  /** Take ownership of the port if it's free. Safe to call when it isn't. */
  async start(): Promise<{ managed: boolean; reason?: string }> {
    if (!(await isPortFree(this.opts.port))) {
      this.managed = false;
      return {
        managed: false,
        reason: `port ${this.opts.port} is already in use — leaving that server alone`,
      };
    }
    this.spawnChild();
    this.managed = true;
    await this.waitForPort(true, 30_000);
    return { managed: true };
  }

  /** Bounce our child. Returns false if the server isn't ours to restart. */
  async restart(): Promise<boolean> {
    if (!this.managed) return false;
    await this.stop();
    await this.waitForPort(false, 10_000);
    this.spawnChild();
    await this.waitForPort(true, 30_000);
    return true;
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child?.pid) return;
    this.child = null;

    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    // Negative pid = the whole process group. tsx runs the server in a child of
    // its own, so signalling just the group leader can orphan it.
    kill(-child.pid, 'SIGTERM');
    const forced = setTimeout(() => kill(-child.pid!, 'SIGKILL'), 5_000);
    await exited;
    clearTimeout(forced);
  }

  private spawnChild(): void {
    const tsx = path.join(this.opts.repoRoot, 'node_modules', '.bin', 'tsx');
    this.child = spawn(tsx, ['src/index.ts'], {
      cwd: this.opts.repoRoot,
      env: { ...process.env, PORT: String(this.opts.port) },
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: true, // own process group, so stop() can take the whole tree
    });
    this.child.on('exit', (code, signal) => {
      if (this.child) console.error(`[server] exited unexpectedly (code=${code} signal=${signal})`);
    });
  }

  private async waitForPort(occupied: boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await isPortFree(this.opts.port)) !== occupied) return;
      await sleep(250);
    }
    console.error(`[server] timed out waiting for port ${this.opts.port} to be ${occupied ? 'up' : 'free'}`);
  }
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net
      .createServer()
      .once('error', () => resolve(false))
      .once('listening', () => probe.close(() => resolve(true)))
      .listen(port, '0.0.0.0');
  });
}

function kill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone. Nothing to do.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
