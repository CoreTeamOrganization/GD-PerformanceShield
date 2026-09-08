/**
 * Shared vocabulary for the whole pipeline.
 *
 * Everything the analyzer produces is expressed with these types so that the
 * report generator (Step 14) can treat structured JSON as the single source of
 * truth, exactly as the specification requires.
 */

/** Severity of a finding, independent of how confident we are that it is real. */
export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

/** How sure we are that a finding is genuine (0..1). */
export type Confidence = number;

export const SEVERITY_WEIGHT: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 3,
  high: 7,
  critical: 12,
};

/** Where a finding came from. Correlation (Step 12) fuses static + live. */
export type FindingSource = 'static' | 'live' | 'correlated';

/** A single piece of supporting evidence attached to a finding. */
export interface Evidence {
  kind:
    | 'file'
    | 'code'
    | 'asset'
    | 'setting'
    | 'metric'
    | 'event'
    | 'timeline'
    | 'artifact'
    | 'note';
  /** Human readable one-liner shown in the report. */
  summary: string;
  /** Repo-relative path, when the evidence points at a file. */
  path?: string;
  /** 1-indexed line number when the evidence points at source code. */
  line?: number;
  /** Verbatim excerpt (already truncated to a safe length). */
  excerpt?: string;
  /** Free-form numeric/structured payload (bytes, deltas, counts...). */
  data?: Record<string, unknown>;
}

/** Output contract every static rule and live detector must satisfy (Step 8). */
export interface Finding {
  /** Stable identifier, e.g. `UNITY.TEXTURE.OVERSIZED`. */
  ruleId: string;
  /** Unique per-occurrence id within an analysis. */
  id: string;
  source: FindingSource;
  title: string;
  /** What the problem is, in studio-facing language. */
  description: string;
  severity: Severity;
  confidence: Confidence;
  /** Concrete, actionable fix. */
  recommendation: string;
  evidence: Evidence[];
  /** Estimated memory impact in bytes, when the rule can estimate one. */
  estimatedBytes?: number;
  /** Free-form grouping key used by the correlation engine. */
  subject?: string;
  tags: string[];
}

/** Lifecycle of an analysis job (Step 1). */
export type JobStatus =
  | 'created'
  | 'intake'
  | 'static_analysis'
  | 'device_setup'
  | 'awaiting_gameplay'
  | 'live_capture'
  | 'analyzing'
  | 'reporting'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Terminal states — a job in one of these will never progress further. */
export const TERMINAL_STATUSES: readonly JobStatus[] = ['completed', 'failed', 'cancelled'];

export interface JobStage {
  name: string;
  status: 'pending' | 'running' | 'ok' | 'skipped' | 'failed';
  startedAt?: string;
  finishedAt?: string;
  message?: string;
  error?: string;
}

export interface StudioIntakeInput {
  /** Display name for the game, used in reports. */
  gameName: string;
  /** Studio / owner name. */
  studio?: string;
  /**
   * Package name of an app already installed on the device.
   *
   * The usual way to start a live analysis: the build under test is normally
   * already on the device, and the package name plus its launch component is
   * everything the profiling phase needs. Supplying this skips both APK
   * acquisition and installation.
   */
  packageName?: string;
  /** Local path to a Unity project already on disk. Wins over `repoUrl`. */
  projectPath?: string;
  /** GitHub (or any git) repository URL. */
  repoUrl?: string;
  /** Branch to analyze. Defaults to the remote HEAD. */
  branch?: string;
  /** Local path to an APK already on disk. */
  apkPath?: string;
  /** URL the APK can be downloaded from. */
  apkUrl?: string;
  /** Optional: restrict device usage to these adb serials. */
  deviceSerials?: string[];
  notes?: string;
}

export interface JobMetadata {
  analysisId: string;
  gameId: string;
  createdAt: string;
  updatedAt: string;
  status: JobStatus;
  input: StudioIntakeInput;
  stages: JobStage[];
  toolVersion: string;
  error?: string;
}

/** Byte helpers used across analyzers and the report. */
export const KB = 1024;
export const MB = 1024 * 1024;
export const GB = 1024 * 1024 * 1024;
