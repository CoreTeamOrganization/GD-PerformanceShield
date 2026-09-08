/**
 * Unity engine allocation totals.
 *
 * The OS can say "134 MB appeared in the native allocator". It cannot say
 * "95 MB of that is textures", because Android accounts memory by mapping and
 * Unity's allocator is one anonymous mapping. Only the engine knows how its own
 * bytes are divided, so these numbers have to come from inside the process.
 *
 * They arrive as logcat lines emitted by the reporter component in
 * `scripts/unity/PerformanceShieldReporter.cs`, which reads Unity's own
 * `ProfilerRecorder` counters. That is a documented, engine-authoritative API,
 * and it is the reason these figures can be trusted enough to put in a report -
 * unlike anything reverse-engineered out of the PlayerConnection stream, which
 * carries an internal frame format that changes with the engine version.
 *
 * Line format, one per emit:
 *   I Unity   : OOMI/MEM {"ms":12034,"textures":99614720,"meshes":12582912,...}
 */
import type { Logger } from '../core/logger.js';

/** One reading of the engine's own allocation totals, in bytes. */
export interface EngineMemory {
  /** Milliseconds since the game started, as the engine measured it. */
  engineMs?: number;
  textures?: number;
  meshes?: number;
  audio?: number;
  shaders?: number;
  animation?: number;
  /** Unity's managed (C#) heap - in use and reserved. */
  managedUsed?: number;
  managedReserved?: number;
  /** Everything Unity has reserved from the OS, its own accounting. */
  totalReserved?: number;
  totalUsed?: number;
  /** Graphics driver memory as the engine sees it. */
  gfxUsed?: number;
  /** Counters the running engine version did not expose. */
  unavailable?: string[];
}

/**
 * The logcat tag the reporter emits. A wire format shared with every game
 * project that has the component committed, so it kept its original spelling
 * when the tool was renamed - see scripts/unity/PerformanceShieldReporter.cs.
 */
export const ENGINE_MEMORY_TAG = 'OOMI/MEM';

/**
 * Keys the reporter emits, mapped to our field names.
 *
 * The reporter sends short keys so a logcat line stays under the ~4 KB per-line
 * limit even on a chatty device.
 */
const FIELDS: Array<[string, keyof EngineMemory]> = [
  ['ms', 'engineMs'],
  ['tex', 'textures'],
  ['textures', 'textures'],
  ['mesh', 'meshes'],
  ['meshes', 'meshes'],
  ['audio', 'audio'],
  ['shader', 'shaders'],
  ['shaders', 'shaders'],
  ['anim', 'animation'],
  ['animation', 'animation'],
  ['gcUsed', 'managedUsed'],
  ['gcReserved', 'managedReserved'],
  ['totalUsed', 'totalUsed'],
  ['totalReserved', 'totalReserved'],
  ['gfx', 'gfxUsed'],
];

/**
 * Parse one reporter line.
 *
 * Returns null for anything that is not a reporter line, so this can be handed
 * every logcat line without filtering first. A malformed payload also returns
 * null rather than a partly-filled reading: half a memory breakdown displayed as
 * though it were whole is exactly the failure this tool exists to avoid.
 */
export function parseEngineMemoryLine(line: string): EngineMemory | null {
  const at = line.indexOf(ENGINE_MEMORY_TAG);
  if (at === -1) return null;

  const payload = line.slice(at + ENGINE_MEMORY_TAG.length).trim();
  if (!payload.startsWith('{')) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }

  const reading: EngineMemory = {};
  for (const [key, field] of FIELDS) {
    const value = parsed[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      (reading[field] as number) = value;
    }
  }

  const missing = parsed['na'];
  if (Array.isArray(missing)) {
    reading.unavailable = missing.filter((m): m is string => typeof m === 'string');
  }

  // A reading with no counter in it says nothing; treat it as noise.
  const hasCounter = Object.keys(reading).some((k) => k !== 'engineMs' && k !== 'unavailable');
  return hasCounter ? reading : null;
}

/**
 * Which engine bucket best explains a jump in OS-reported memory.
 *
 * Deliberately conservative. Unity's texture counter includes GPU-side memory
 * that Android reports under Graphics, not under the native allocator, so the
 * two accountings overlap and neither is a subset of the other. This returns the
 * largest mover rather than claiming to decompose the OS figure exactly.
 */
export function largestEngineMover(
  before: EngineMemory | null,
  after: EngineMemory | null,
): { field: keyof EngineMemory; delta: number } | null {
  if (!before || !after) return null;

  const buckets: Array<keyof EngineMemory> = [
    'textures',
    'meshes',
    'audio',
    'shaders',
    'animation',
    'managedUsed',
  ];

  let best: { field: keyof EngineMemory; delta: number } | null = null;
  for (const field of buckets) {
    const a = before[field];
    const b = after[field];
    if (typeof a !== 'number' || typeof b !== 'number') continue;
    const delta = b - a;
    if (!best || Math.abs(delta) > Math.abs(best.delta)) best = { field, delta };
  }

  return best && Math.abs(best.delta) > 0 ? best : null;
}

/**
 * Watches logcat for reporter lines and keeps the most recent reading.
 *
 * Held separately from the memory samplers because the cadence is the
 * reporter's, not ours: the engine emits when it emits, and a sample takes
 * whatever the latest reading was rather than blocking on one.
 */
export class EngineMemoryTracker {
  private latest: EngineMemory | null = null;
  private lineCount = 0;

  constructor(private readonly logger?: Logger) {}

  /** Feed one logcat line. Returns the reading if the line was one. */
  ingest(line: string): EngineMemory | null {
    const reading = parseEngineMemoryLine(line);
    if (!reading) return null;

    if (this.lineCount === 0) {
      this.logger?.info('Unity engine memory reporter detected', {
        counters: Object.keys(reading).filter((k) => k !== 'engineMs' && k !== 'unavailable'),
        unavailable: reading.unavailable ?? [],
      });
    }
    this.lineCount++;
    this.latest = reading;
    return reading;
  }

  /** The most recent reading, or null if the reporter is not present. */
  current(): EngineMemory | null {
    return this.latest;
  }

  get seen(): number {
    return this.lineCount;
  }
}
