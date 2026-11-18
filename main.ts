// main.ts — the forge's process entrypoint.
//
// app.ts builds the HTTP server; this file owns everything around it:
// binding the port, telling the contest environment where we are, and
// staying alive until the environment says the trial is over.
//
// The trial lifecycle, in order:
//   1. listen on port 0 so the kernel assigns a free port (never 8080 —
//      that is the environment's own port),
//   2. POST {"port": <the bound port>} to $MAKEFUN_ENV_URL/register,
//   3. poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true},
//   4. close the server and exit 0.
//
// The environment answers every /done poll at once, so polling here is a
// plain request/response loop with a growing pause between attempts;
// nothing ever holds a connection open waiting for news.

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createApp } from './app.ts';

/** How long one call to the environment may take before we abandon it. */
const ENV_CALL_TIMEOUT_MS = 5_000;

/** First pause between two environment calls; it grows from here. */
const FIRST_RETRY_DELAY_MS = 100;

/** The pause between environment calls never grows past this. */
const MAX_RETRY_DELAY_MS = 2_000;

/** server.close() gets this long to drain before we exit anyway. */
const SHUTDOWN_GRACE_MS = 1_000;

function note(message: string): void {
  process.stderr.write(`[forge] ${message}\n`);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The pauses between retries: 100ms, 200ms, 400ms, … capped. */
class Backoff {
  private delay = FIRST_RETRY_DELAY_MS;

  async wait(): Promise<void> {
    await pause(this.delay);
    this.delay = Math.min(this.delay * 2, MAX_RETRY_DELAY_MS);
  }
}

/** The environment's origin with any trailing slash removed, or null. */
function environmentOrigin(): string | null {
  const raw = process.env.MAKEFUN_ENV_URL;
  if (raw === undefined || raw.trim() === '') {
    return null;
  }
  return raw.replace(/\/+$/, '');
}

/** Bind the server to an ephemeral port; resolve with the chosen port. */
function bindEphemeral(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(0, () => {
      server.removeListener('error', onError);
      const address = server.address() as AddressInfo | null;
      if (address === null) {
        reject(new Error('the server is listening but reports no address'));
        return;
      }
      resolve(address.port);
    });
  });
}

/**
 * Tell the environment which port we bound, retrying with backoff.
 *
 * The first registration wins: a second one is answered 409 and moves
 * nothing. So a 409 here means an earlier attempt of ours did land (its
 * reply was lost on the wire) — that is success, not failure.
 */
async function registerWithRetries(origin: string, port: number): Promise<void> {
  const backoff = new Backoff();
  for (;;) {
    try {
      const reply = await fetch(`${origin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(ENV_CALL_TIMEOUT_MS),
      });
      if (reply.ok || reply.status === 409) {
        return;
      }
      note(`register answered ${reply.status}; will retry`);
    } catch (error) {
      note(`register failed (${describe(error)}); will retry`);
    }
    await backoff.wait();
  }
}

/** One /done poll: true only when the environment says it is finished. */
async function pollDoneOnce(origin: string): Promise<boolean> {
  const reply = await fetch(`${origin}/done`, {
    signal: AbortSignal.timeout(ENV_CALL_TIMEOUT_MS),
  });
  if (!reply.ok) {
    throw new Error(`/done answered ${reply.status}`);
  }
  const body: unknown = await reply.json();
  if (typeof body !== 'object' || body === null) {
    throw new Error('/done answered a non-object body');
  }
  return (body as { done?: unknown }).done === true;
}

/** Poll /done with backoff until the environment reports the trial over. */
async function waitUntilDone(origin: string): Promise<void> {
  const backoff = new Backoff();
  for (;;) {
    try {
      if (await pollDoneOnce(origin)) {
        return;
      }
    } catch (error) {
      note(`done poll failed (${describe(error)}); will retry`);
    }
    await backoff.wait();
  }
}

/** Close the server, but never let a lingering socket delay the exit. */
function shutdown(server: Server): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Run the lifecycle. Resolves with the exit code for a trial run, or
 * with null when there is no environment and the server should simply
 * keep serving (a developer started the process by hand; the local
 * conformance runner drives a server started exactly that way).
 */
async function run(): Promise<number | null> {
  const server = createApp();
  const port = await bindEphemeral(server);
  note(`listening on port ${port}`);

  const origin = environmentOrigin();
  if (origin === null) {
    note('MAKEFUN_ENV_URL is not set; serving standalone');
    return null;
  }

  await registerWithRetries(origin, port);
  note('registered with the environment; waiting for the trial to end');
  await waitUntilDone(origin);

  note('the environment reports done; shutting down');
  await shutdown(server);
  return 0;
}

try {
  const exitCode = await run();
  if (exitCode !== null) {
    process.exit(exitCode);
  }
} catch (error) {
  note(`fatal: ${describe(error)}`);
  process.exit(1);
}
