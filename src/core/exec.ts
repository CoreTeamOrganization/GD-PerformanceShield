/**
 * Process execution helpers.
 *
 * Everything that shells out (git, adb, aapt2) goes through here so timeouts,
 * output caps and error shapes are uniform — an `adb shell` that hangs must not
 * be able to wedge a profiling session.
 */
import { spawn, type SpawnOptions } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Cap captured output to avoid a runaway command eating memory. */
  maxBuffer?: number;
  input?: string;
  signal?: AbortSignal;
}

export async function run(
  command: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const { cwd, env, timeoutMs = 60_000, maxBuffer = 16 * 1024 * 1024, input, signal } = opts;
  const started = Date.now();

  return new Promise<RunResult>((resolve, reject) => {
    const spawnOpts: SpawnOptions = {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      windowsHide: true,
      // Never use a shell: arguments may contain paths with spaces and we do not
      // want any shell interpolation of studio-supplied strings.
      shell: false,
    };
    const child = spawn(command, args, spawnOpts);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, timeoutMs)
        : null;

    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < maxBuffer) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < maxBuffer) stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        code: code ?? -1,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
      });
    });

    if (input !== undefined) {
      child.stdin?.write(input);
      child.stdin?.end();
    }
  });
}

/** Like `run`, but throws when the command fails. */
export async function runOrThrow(
  command: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const result = await run(command, args, opts);
  if (result.code !== 0) {
    const reason = result.timedOut ? 'timed out' : `exited with code ${result.code}`;
    throw new Error(
      `${command} ${args.join(' ')} ${reason}: ${(result.stderr || result.stdout).trim().slice(0, 800)}`,
    );
  }
  return result;
}

export async function commandExists(command: string): Promise<boolean> {
  try {
    const res = await run(command, ['--version'], { timeoutMs: 8000 });
    return res.code === 0 || res.stdout.length > 0 || res.stderr.length > 0;
  } catch {
    return false;
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `check` until it returns a truthy value or the deadline elapses. */
export async function waitFor<T>(
  check: () => Promise<T | null | undefined>,
  opts: { timeoutMs: number; intervalMs?: number; description?: string },
): Promise<T> {
  const { timeoutMs, intervalMs = 500, description = 'condition' } = opts;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value !== null && value !== undefined && value !== false) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${description}` +
      (lastError instanceof Error ? `: ${lastError.message}` : ''),
  );
}
