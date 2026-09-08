/**
 * Step 2 (part 1) - repository intake.
 *
 * Uses the `git` CLI rather than a JS git implementation: studios use LFS,
 * submodules and huge histories, and only the real client handles those well.
 * We shallow-clone by default because static analysis never needs history.
 */
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';

import { IntakeError } from '../core/errors.js';
import { run, runOrThrow } from '../core/exec.js';
import type { Logger } from '../core/logger.js';

export interface CloneOptions {
  repoUrl: string;
  branch?: string;
  targetDir: string;
  /** Token injected into an https remote for private repositories. */
  githubToken?: string;
  depth?: number;
  /** Fetch LFS objects. Off by default — LFS payloads are usually art, and the
   *  pointer files still tell us the asset paths and sizes we need. */
  lfs?: boolean;
  logger?: Logger;
  timeoutMs?: number;
}

export interface CloneResult {
  path: string;
  repoUrl: string;
  branch: string;
  commit: string;
  commitDate: string;
  commitSubject: string;
  shallow: boolean;
  lfsFetched: boolean;
}

/** Never let a token reach a log line or the report. */
export function redactUrl(url: string): string {
  return url.replace(/\/\/[^@/]+@/, '//***@');
}

function authenticate(repoUrl: string, token?: string): string {
  if (!token) return repoUrl;
  if (!repoUrl.startsWith('https://')) return repoUrl;
  if (/\/\/[^@/]+@/.test(repoUrl)) return repoUrl; // already carries credentials
  return repoUrl.replace('https://', `https://x-access-token:${token}@`);
}

export async function cloneRepository(opts: CloneOptions): Promise<CloneResult> {
  const {
    repoUrl,
    branch,
    targetDir,
    githubToken,
    depth = 1,
    lfs = false,
    logger,
    timeoutMs = 20 * 60_000,
  } = opts;

  if (existsSync(targetDir)) {
    logger?.debug('Clearing previous source checkout', { targetDir });
    await rm(targetDir, { recursive: true, force: true });
  }

  const url = authenticate(repoUrl, githubToken);
  const args = ['clone', '--depth', String(depth), '--single-branch'];
  if (branch) args.push('--branch', branch);
  args.push(url, targetDir);

  logger?.info('Cloning repository', { repo: redactUrl(repoUrl), branch: branch ?? '<default>' });

  const env: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: '0', // fail fast instead of blocking on a credential prompt
    GIT_LFS_SKIP_SMUDGE: lfs ? '0' : '1',
  };

  const result = await run('git', args, { timeoutMs, env });
  if (result.code !== 0) {
    const stderr = redactUrl(result.stderr.trim());
    throw new IntakeError(`git clone failed: ${stderr.slice(0, 600)}`, {
      hint: branch
        ? `Verify the branch "${branch}" exists and the token has read access.`
        : 'Verify the repository URL and that GDPS_GITHUB_TOKEN grants read access.',
    });
  }

  let lfsFetched = false;
  if (lfs) {
    const lfsResult = await run('git', ['lfs', 'pull'], { cwd: targetDir, timeoutMs });
    lfsFetched = lfsResult.code === 0;
    if (!lfsFetched) logger?.warn('git lfs pull failed; continuing with pointer files');
  }

  const head = await runOrThrow(
    'git',
    ['log', '-1', '--pretty=format:%H%x1f%cI%x1f%s'],
    { cwd: targetDir, timeoutMs: 30_000 },
  );
  const [commit = '', commitDate = '', commitSubject = ''] = head.stdout.split('\x1f');

  const branchResult = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: targetDir,
    timeoutMs: 30_000,
  });

  return {
    path: targetDir,
    repoUrl: redactUrl(repoUrl),
    branch: branch ?? (branchResult.stdout.trim() || "HEAD"),
    commit,
    commitDate,
    commitSubject,
    shallow: depth > 0,
    lfsFetched,
  };
}
