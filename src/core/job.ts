/**
 * Step 1 - Analysis Job System.
 *
 * A job owns: a unique analysis id, a workspace, a status machine, a stage
 * ledger and its artifacts. Status is persisted after every transition so an
 * interrupted run can be inspected (and later resumed) from disk alone.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig, type AppConfig } from './config.js';
import { createAnalysisId, slugify } from './ids.js';
import { createLogger, type Logger } from './logger.js';
import {
  TERMINAL_STATUSES,
  type JobMetadata,
  type JobStage,
  type JobStatus,
  type StudioIntakeInput,
} from './types.js';
import { Workspace } from './workspace.js';

export const TOOL_VERSION = '0.1.0';
const METADATA_FILE = 'job.json';

/** The canonical stage list. Stages appear in the operator UI in this order. */
export const PIPELINE_STAGES = [
  'intake.repository',
  'intake.apk',
  'apk.inspect',
  'static.analysis',
  'device.detect',
  'device.install',
  'device.freshStart',
  'device.launch',
  'device.profiler',
  'live.capture',
  'analysis.anomaly',
  'analysis.flow',
  'analysis.correlation',
  'analysis.scoring',
  'report.generate',
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export class AnalysisJob {
  readonly workspace: Workspace;
  readonly log: Logger;
  private metadata: JobMetadata;
  private listeners = new Set<(meta: JobMetadata) => void>();

  private constructor(metadata: JobMetadata, config: AppConfig) {
    this.metadata = metadata;
    this.workspace = new Workspace(
      config.workspaceRoot,
      metadata.gameId,
      metadata.analysisId,
    ).ensure();
    this.log = createLogger(metadata.analysisId);
    this.log.tee(this.workspace.file('logs', 'job.jsonl'));
  }

  static create(input: StudioIntakeInput, config = loadConfig()): AnalysisJob {
    const gameId = slugify(input.gameName);
    const analysisId = createAnalysisId(gameId);
    const now = new Date().toISOString();
    const metadata: JobMetadata = {
      analysisId,
      gameId,
      createdAt: now,
      updatedAt: now,
      status: 'created',
      input,
      stages: PIPELINE_STAGES.map((name) => ({ name, status: 'pending' })),
      toolVersion: TOOL_VERSION,
    };
    const job = new AnalysisJob(metadata, config);
    job.persist();
    job.log.info('Analysis job created', { gameId, analysisId, game: input.gameName });
    return job;
  }

  /** Reopen an existing job from its workspace. */
  static load(gameId: string, analysisId: string, config = loadConfig()): AnalysisJob {
    const ws = new Workspace(config.workspaceRoot, gameId, analysisId);
    const metadata = ws.readJson<JobMetadata>('metadata', METADATA_FILE);
    if (!metadata) {
      throw new Error(`No job metadata found at ${ws.file('metadata', METADATA_FILE)}`);
    }
    return new AnalysisJob(metadata, config);
  }

  get id(): string {
    return this.metadata.analysisId;
  }

  get gameId(): string {
    return this.metadata.gameId;
  }

  get status(): JobStatus {
    return this.metadata.status;
  }

  get input(): StudioIntakeInput {
    return this.metadata.input;
  }

  get meta(): Readonly<JobMetadata> {
    return this.metadata;
  }

  get isTerminal(): boolean {
    return TERMINAL_STATUSES.includes(this.metadata.status);
  }

  onChange(fn: (meta: JobMetadata) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setStatus(status: JobStatus, error?: string): void {
    this.metadata.status = status;
    if (error) this.metadata.error = error;
    this.touch();
    this.log.info(`Status -> ${status}`, error ? { error } : undefined);
  }

  /** Record the outcome of one pipeline stage. */
  updateStage(name: PipelineStage, patch: Partial<Omit<JobStage, 'name'>>): void {
    const existing = this.metadata.stages.find((s) => s.name === name);
    if (existing) Object.assign(existing, patch);
    else this.metadata.stages.push({ name, status: 'pending', ...patch });
    this.touch();
  }

  stage(name: PipelineStage): JobStage | undefined {
    return this.metadata.stages.find((s) => s.name === name);
  }

  /**
   * Run one stage with automatic bookkeeping. A stage that throws is recorded
   * as failed and the error is rethrown unless `optional` is set, which lets
   * the pipeline continue with degraded output (e.g. no repo access).
   */
  async runStage<T>(
    name: PipelineStage,
    fn: () => Promise<T>,
    opts: { optional?: boolean } = {},
  ): Promise<T | null> {
    this.updateStage(name, { status: 'running', startedAt: new Date().toISOString() });
    this.log.info(`Stage started: ${name}`);
    try {
      const result = await fn();
      this.updateStage(name, { status: 'ok', finishedAt: new Date().toISOString() });
      this.log.info(`Stage ok: ${name}`);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.updateStage(name, {
        status: opts.optional ? 'skipped' : 'failed',
        finishedAt: new Date().toISOString(),
        error: message,
      });
      if (opts.optional) {
        this.log.warn(`Stage skipped: ${name}`, { error: message });
        return null;
      }
      this.log.error(`Stage failed: ${name}`, { error: message });
      throw err;
    }
  }

  /** Store an arbitrary structured artifact and remember it in the ledger. */
  saveArtifact(dir: Parameters<Workspace['writeJson']>[0], file: string, value: unknown): string {
    return this.workspace.writeJson(dir, file, value);
  }

  private touch(): void {
    this.metadata.updatedAt = new Date().toISOString();
    this.persist();
    for (const fn of this.listeners) {
      try {
        fn(this.metadata);
      } catch {
        /* a bad subscriber must not break the run */
      }
    }
  }

  private persist(): void {
    this.workspace.writeJson('metadata', METADATA_FILE, this.metadata);
  }
}

/** Enumerate jobs on disk, newest first. Powers `gdshield list` and the UI. */
export function listJobs(config = loadConfig(), limit = 50): JobMetadata[] {
  const root = config.workspaceRoot;
  if (!existsSync(root)) return [];
  const out: JobMetadata[] = [];
  for (const gameId of safeReaddir(root)) {
    const gameDir = join(root, gameId);
    if (!isDir(gameDir)) continue;
    for (const analysisId of safeReaddir(gameDir)) {
      const metaPath = join(gameDir, analysisId, 'metadata', METADATA_FILE);
      if (!existsSync(metaPath)) continue;
      try {
        const ws = new Workspace(root, gameId, analysisId);
        const meta = ws.readJson<JobMetadata>('metadata', METADATA_FILE);
        if (meta) out.push(meta);
      } catch {
        /* skip unreadable job */
      }
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

/** Resolve a job by analysis id alone (the UI and CLI only carry that). */
export function findJob(analysisId: string, config = loadConfig()): AnalysisJob | null {
  const match = listJobs(config, 1000).find((m) => m.analysisId === analysisId);
  if (!match) return null;
  return AnalysisJob.load(match.gameId, match.analysisId, config);
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
