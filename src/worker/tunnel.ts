import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export interface TunnelOptions {
  repoRoot: string;
  port: number;
  /** How long to wait for cloudflared to hand us a URL. */
  timeoutMs?: number;
}

/**
 * Runs the cloudflared quick tunnel and remembers the URL it hands back.
 *
 * Deliberately a sibling of GameServer, not a child: the tunnel points at a
 * port, so it must outlive every server restart. Bouncing this is the one
 * thing that would change the public address.
 */
export class Tunnel {
  private child: ChildProcess | null = null;
  private publicUrl: string | null = null;

  constructor(private readonly opts: TunnelOptions) {}

  get url(): string | null {
    return this.publicUrl;
  }

  /** Resolves with the public URL, or null if there's no cloudflared to run. */
  async start(): Promise<string | null> {
    const bin = path.join(this.opts.repoRoot, 'bin', 'cloudflared');
    if (!fs.existsSync(bin)) {
      console.log('[tunnel] bin/cloudflared not found — skipping');
      return null;
    }

    this.child = spawn(bin, ['tunnel', '--url', `http://localhost:${this.opts.port}`], {
      cwd: this.opts.repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group, so stop() takes the whole tree
    });

    this.child.on('exit', (code) => {
      if (this.child) console.error(`[tunnel] cloudflared exited (code=${code})`);
      this.publicUrl = null;
    });

    this.publicUrl = await this.awaitUrl(this.opts.timeoutMs ?? 60_000);
    return this.publicUrl;
  }

  stop(): void {
    const child = this.child;
    if (!child?.pid) return;
    this.child = null;
    this.publicUrl = null;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }

  /** cloudflared announces the quick-tunnel URL on stderr, inside a banner. */
  private awaitUrl(timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (url: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(url);
      };

      const timer = setTimeout(() => {
        console.error('[tunnel] timed out waiting for a URL');
        finish(null);
      }, timeoutMs);

      const scan = (chunk: Buffer) => {
        const match = QUICK_TUNNEL_URL.exec(chunk.toString());
        if (match) finish(match[0]);
      };

      this.child?.stderr?.on('data', scan);
      this.child?.stdout?.on('data', scan);
      this.child?.once('exit', () => finish(null));
    });
  }
}
