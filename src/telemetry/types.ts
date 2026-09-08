/**
 * Telemetry record shapes.
 *
 * These are written to JSONL verbatim and are the raw input to every analysis
 * stage, so they are versioned: `schema` lets a later build read older runs.
 */

export const TELEMETRY_SCHEMA_VERSION = 1;

/** Which probe produced a sample. Cheap samples are frequent but coarse. */
export type SampleTier = 'fast' | 'deep';

/** Per-category PSS breakdown, in bytes. Keys mirror `dumpsys meminfo` rows. */
export interface MemoryBreakdown {
  nativeHeap?: number;
  dalvikHeap?: number;
  dalvikOther?: number;
  stack?: number;
  ashmem?: number;
  gfxDev?: number;
  otherDev?: number;
  soMmap?: number;
  jarMmap?: number;
  apkMmap?: number;
  ttfMmap?: number;
  dexMmap?: number;
  oatMmap?: number;
  artMmap?: number;
  otherMmap?: number;
  eglMtrack?: number;
  glMtrack?: number;
  unknown?: number;
}

import type { EngineMemory } from './engineMetrics.js';
import type { EngineAudio, EngineRender } from './engineProfile.js';
import type { BatteryReading, ThermalReading } from './deviceHealth.js';
import type { FpsReading } from './fps.js';
import type { GpuReading } from './gpu.js';
import type { CpuReading } from './cpuThreads.js';
import type { DiskIoReading } from './diskIo.js';
import type { AudioReading } from './audio.js';

/** What a mapping is, in terms a Unity developer recognises. */
export type MappingKind =
  | 'unity-engine'
  | 'game-code'
  | 'unity-content'
  | 'native-library'
  | 'app-package'
  | 'android-runtime'
  | 'graphics'
  | 'java-heap'
  | 'native-alloc'
  | 'stack'
  | 'shared'
  | 'other';

/** One named mapping out of /proc/<pid>/smaps, summed across its regions. */
export interface MappingUsage {
  /** Normalised so the same thing groups across samples: `libil2cpp.so`. */
  name: string;
  kind: MappingKind;
  pssBytes: number;
  /** Private dirty + clean: the part that dies with the process. */
  privateBytes: number;
  /** How many VMAs were folded into this row. */
  regions: number;
}

/** `App Summary` section of dumpsys meminfo, in bytes. */
export interface AppSummary {
  javaHeap?: number;
  nativeHeap?: number;
  code?: number;
  stack?: number;
  graphics?: number;
  privateOther?: number;
  system?: number;
  totalPss?: number;
  totalRss?: number;
  totalSwapPss?: number;
}

/** One point on the memory timeline for one device. */
export interface MemorySample {
  schema: number;
  /** Epoch milliseconds - the join key for events and analysis. */
  t: number;
  /** Milliseconds since the capture session started. */
  elapsedMs: number;
  serial: string;
  role: string;
  pid: number;
  tier: SampleTier;
  /** Proportional set size in bytes - the primary OOM metric. */
  pssBytes: number | null;
  rssBytes: number | null;
  swapPssBytes: number | null;
  breakdown?: MemoryBreakdown;
  /**
   * The same rows as `breakdown`, but private (dirty + clean) rather than PSS.
   * App Summary categories are sums of *private* memory, so this is what a
   * per-category breakdown has to be built from if it is to add up.
   */
  breakdownPrivate?: MemoryBreakdown;
  summary?: AppSummary;
  /** Per-mapping detail, when /proc/<pid>/smaps was readable. */
  mappings?: MappingUsage[];
  /** Presented frame rate over the window ending at this sample. */
  fps?: FpsReading;
  /** Thermal state, which decides whether the device was throttling. */
  thermal?: ThermalReading;
  /** Battery state. Drain is only meaningful while not charging. */
  battery?: BatteryReading;
  /**
   * The engine's own allocation totals at this instant, when the reporter
   * component is present in the build. This is the only source that can divide
   * Unity's native allocator into textures, meshes, audio and shaders - the OS
   * sees one anonymous mapping and cannot.
   */
  engine?: EngineMemory;
  /**
   * The subsystems beyond memory, all on the deep cadence.
   *
   * Attached to the same sample rather than written to separate files so that a
   * frame drop, a memory jump and a disk read taken at the same instant can be
   * lined up again afterwards. Splitting them would put the symptom and its
   * cause on different timelines, which is the one thing the diagnostic engine
   * cannot recover from.
   *
   * Every one of them is optional, and absent means "not measurable on this
   * device or this build" rather than zero. A zero here would read as "the GPU
   * was idle" or "nothing was loaded", which is the opposite of not knowing.
   */
  gpu?: GpuReading;
  cpu?: CpuReading;
  io?: DiskIoReading;
  /** Platform audio mixer: tracks and buffer underruns. */
  audio?: AudioReading;
  /** Engine render counters: draw calls, geometry, per-thread frame time. */
  render?: EngineRender;
  /** Engine audio counters: voices and audio-thread CPU. */
  engineAudio?: EngineAudio;
  /** Device-wide memory at sample time. */
  deviceAvailableBytes?: number | null;
  deviceFreeBytes?: number | null;
  deviceCachedBytes?: number | null;
  /** Process oom_score_adj - rises as the app becomes a kill candidate. */
  oomScoreAdj?: number | null;
  /** How long the probe itself took, so sampling overhead is auditable. */
  probeDurationMs: number;
}

/** Operator-pressed marker (Step 7) or a system-generated lifecycle event. */
export interface TimelineEvent {
  schema: number;
  t: number;
  elapsedMs: number;
  /** Stable machine name, e.g. `gameplay_start`. */
  type: string;
  /** Display label shown in the report. */
  label: string;
  source: 'operator' | 'system' | 'template';
  serial?: string;
  /** Free-form details: cycle index, screen name, custom text. */
  data?: Record<string, unknown>;
}

/** A notable line lifted out of logcat during the session. */
export interface LogEvent {
  schema: number;
  t: number;
  elapsedMs: number;
  serial: string;
  level: string;
  tag: string;
  message: string;
  /** Classification assigned by the log matcher. */
  category: 'oom_kill' | 'low_memory' | 'gc' | 'unity' | 'crash' | 'anr' | 'other';
  /**
   * Whether the line is about the game under test rather than some other
   * process. System-wide signals (kill notices, low-memory warnings) are kept
   * regardless of owner, so analysis needs this to tell "our app was killed"
   * from "the OS killed something else while we watched".
   * Absent on sessions captured before this field existed.
   */
  appRelated?: boolean;
}

/** Header written once per capture session. */
export interface SessionManifest {
  schema: number;
  sessionId: string;
  analysisId: string;
  packageName: string;
  startedAt: string;
  startedAtEpochMs: number;
  finishedAt?: string;
  devices: Array<{
    serial: string;
    role: string;
    model: string;
    totalRamBytes: number;
    initialPid: number;
  }>;
  fastIntervalMs: number;
  deepIntervalMs: number;
  /** Probes that were actually usable on each device. */
  activeProbes: Record<string, string[]>;
  notes?: string;
}
