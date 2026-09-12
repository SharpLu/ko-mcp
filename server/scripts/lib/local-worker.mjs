/**
 * Boot the Worker built from THIS working tree, on loopback, and hand back a
 * base URL. Nothing here can reach a deployed version.
 *
 * `wrangler dev` bundles src/index.ts with the same esbuild pipeline
 * `wrangler versions upload` uses and runs it in workerd -- the real runtime,
 * not a Node emulation of it. It needs no Cloudflare credentials, which is why
 * this gate can run before the deploy step rather than after it.
 *
 * The port is ephemeral and the process is killed when the gate finishes, so
 * there is no long-lived endpoint for a later run to accidentally grade.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

/** Ask the OS for a free port so parallel jobs cannot collide. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Start `wrangler dev` and wait for /health.
 *
 * Returns { base, stop, log }. `stop` is idempotent.
 */
export async function startLocalWorker({ cwd = process.cwd(), readyTimeoutMs = 120000 } = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const log = [];

  const child = spawn(
    'npx',
    ['wrangler', 'dev', '--ip', '127.0.0.1', '--port', String(port)],
    {
      cwd,
      env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  };
  child.on('exit', (code) => {
    if (!stopped) log.push(`\nwrangler dev exited early with code ${code}\n`);
  });

  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    if (Date.now() > deadline) {
      stop();
      throw new Error(`wrangler dev did not answer /health within ${readyTimeoutMs}ms:\n${log.join('')}`);
    }
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const body = await res.json();
        if (body && body.status === 'ok') break;
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }

  return { base, stop, log };
}
