// "Restart server" (Settings → Advanced → Server): the running server hands over to a fresh one.
//
// A process cannot restart itself, so it spawns a small detached shell that waits for this
// server's port to free up and then runs scripts/launch.sh (which rebuilds when the source is
// newer than dist/ and starts the production server), and then exits. Only offered when the
// server was started by the launcher / `npm start` (NODE_ENV=production): `npm run dev` has no
// supervisor and no build to refresh, so a restart there would just kill it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface RestartPlan { ok: true; script: string; args: string[] }
export interface RestartRefusal { ok: false; status: number; error: string }

/** What a restart would run, or why it can't. Pure apart from the file check, so it is unit-tested. */
export function planRestart(opts: { nodeEnv: string | undefined; port: number; cwd: string; exists?: (p: string) => boolean }): RestartPlan | RestartRefusal {
  if (opts.nodeEnv !== 'production') {
    return { ok: false, status: 409, error: 'Restart is only available when the server was started with the CTT.AY app (npm run dev has to be restarted in the terminal).' };
  }
  const launcher = path.join(opts.cwd, 'scripts', 'launch.sh');
  if (!(opts.exists ?? fs.existsSync)(launcher)) {
    return { ok: false, status: 501, error: 'scripts/launch.sh was not found next to the server.' };
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    return { ok: false, status: 500, error: 'Could not determine the server port.' };
  }
  // Port and path are passed as positional parameters, never spliced into the script text.
  const script = 'while /usr/bin/nc -z 127.0.0.1 "$1" >/dev/null 2>&1; do sleep 0.2; done; NO_OPEN=1 exec "$2"';
  return { ok: true, script, args: ['-c', script, 'ctt-restart', String(opts.port), launcher] };
}

/** Spawns the detached hand-over; the caller answers the request and then exits the process. */
export function startRestart(plan: RestartPlan, cwd: string): void {
  const child = spawn('/bin/bash', plan.args, { cwd, detached: true, stdio: 'ignore', env: process.env });
  child.unref();
}
