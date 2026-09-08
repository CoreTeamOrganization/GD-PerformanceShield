/**
 * Step 1 - the on-disk workspace layout, exactly as specified:
 *
 *   analysis/
 *     <game_id>/
 *       <analysis_id>/
 *         metadata/  source/  static/  apk/  devices/
 *         telemetry/ logs/    events/  reports/  artifacts/
 *
 * Every stage receives a Workspace instead of raw paths, so nothing in the
 * pipeline has to know where the root lives or invent its own folder names.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const WORKSPACE_DIRS = [
  'metadata',
  'source',
  'static',
  'apk',
  'devices',
  'telemetry',
  'logs',
  'events',
  'reports',
  'artifacts',
] as const;

export type WorkspaceDir = (typeof WORKSPACE_DIRS)[number];

export class Workspace {
  readonly root: string;

  constructor(
    readonly workspaceRoot: string,
    readonly gameId: string,
    readonly analysisId: string,
  ) {
    this.root = join(workspaceRoot, gameId, analysisId);
  }

  /** Create the full directory skeleton. Idempotent. */
  ensure(): this {
    for (const dir of WORKSPACE_DIRS) {
      mkdirSync(join(this.root, dir), { recursive: true });
    }
    return this;
  }

  dir(name: WorkspaceDir): string {
    return join(this.root, name);
  }

  /** Path to a file inside one of the standard directories. */
  file(name: WorkspaceDir, ...parts: string[]): string {
    return join(this.root, name, ...parts);
  }

  exists(name: WorkspaceDir, ...parts: string[]): boolean {
    return existsSync(this.file(name, ...parts));
  }

  /** Atomic JSON write — a killed run must never leave a half-written report. */
  writeJson(name: WorkspaceDir, file: string, value: unknown): string {
    const target = this.file(name, file);
    writeJsonAtomic(target, value);
    return target;
  }

  readJson<T>(name: WorkspaceDir, file: string): T | null {
    const target = this.file(name, file);
    if (!existsSync(target)) return null;
    return JSON.parse(readFileSync(target, 'utf8')) as T;
  }

  writeText(name: WorkspaceDir, file: string, content: string): string {
    const target = this.file(name, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
    return target;
  }
}

export function writeJsonAtomic(target: string, value: unknown): void {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, target);
}
