/**
 * Memory spikes, and the curve as a report can carry it.
 *
 * The console already finds these interactively; this is the same detection run
 * once at report time, so a document that leaves the machine says the same thing
 * the operator saw on screen. It is deliberately a separate implementation from
 * the browser's: that one is a drawing concern and runs on live samples, this one
 * summarises a finished session and has to be serialisable.
 *
 * Category rows are built from the App Summary, and the named detail from smaps
 * and the Unity reporter where those were available. Nothing is inferred: a
 * spike with no detail says so by carrying empty arrays.
 */
import { MB } from '../core/types.js';
import type { MemorySample, TimelineEvent } from '../telemetry/types.js';

/** App Summary categories, in the order the console stacks them. */
const CATEGORIES: Array<{ key: keyof NonNullable<MemorySample['summary']>; label: string }> = [
  { key: 'graphics', label: 'Graphics' },
  { key: 'privateOther', label: 'Private Other' },
  { key: 'code', label: 'Code' },
  { key: 'javaHeap', label: 'Java Heap' },
  { key: 'nativeHeap', label: 'Native Heap' },
  { key: 'system', label: 'System' },
  { key: 'stack', label: 'Stack' },
];

/** Unity's own buckets, when the reporter component was in the build. */
const ENGINE_BUCKETS: Array<{ key: keyof NonNullable<MemorySample['engine']>; label: string }> = [
  { key: 'textures', label: 'Textures' },
  { key: 'meshes', label: 'Meshes' },
  { key: 'audio', label: 'Audio' },
  { key: 'shaders', label: 'Shaders and materials' },
  { key: 'animation', label: 'Animation' },
  { key: 'managedUsed', label: 'C# managed heap' },
];

export interface MemorySpike {
  role: string;
  /**
   * A, B, C... assigned by size so A is always the largest jump in the session.
   * The same letter marks the point on the timeline chart, which is what lets a
   * reader be pointed at one: "look at B" means the same thing on the graph and
   * in the table.
   */
  letter: string;
  fromMs: number;
  toMs: number;
  deltaBytes: number;
  totalBytes: number;
  kind: string;
  nearestMarker: string | null;
  categories: Array<{ label: string; deltaBytes: number }>;
  mappings: Array<{ name: string; deltaBytes: number }>;
  engine: Array<{ label: string; deltaBytes: number }>;
}

export interface TimelineSeries {
  role: string;
  points: Array<{ elapsedMs: number; totalBytes: number; categories: Record<string, number> }>;
}

/**
 * What kind of work a step implies, from which category carried it.
 *
 * Identical rules to the console, because a report that classified the same
 * jump differently from the screen it was read off would be worse than one that
 * did not classify it at all.
 */
function classify(deltaBytes: number, top: { label: string; deltaBytes: number } | undefined): string {
  if (deltaBytes < 0) return 'Memory released';
  if (!top) return 'Mixed growth';

  // One category has to carry most of it before the jump is attributable.
  if (Math.abs(top.deltaBytes) / Math.abs(deltaBytes) < 0.6) return 'Mixed growth';

  switch (top.label) {
    case 'Graphics':
      return 'Asset upload';
    case 'Native Heap':
      return 'Content load';
    case 'Code':
      return 'Code load';
    case 'Java Heap':
      return 'Managed allocation';
    default:
      return 'Mixed growth';
  }
}

export interface DetectSpikesInput {
  role: string;
  samples: MemorySample[];
  events: TimelineEvent[];
  /** Device RAM, so the threshold scales with the hardware. */
  totalRamBytes?: number;
  /** How many to keep. The report shows the worst, not all of them. */
  limit?: number;
}

/**
 * The largest memory jumps in one device's session.
 *
 * Threshold scales with the device: 20 MB is a real event on a 2 GB phone and
 * rounding error on a 12 GB one, so it is the larger of 20 MB and 1% of RAM -
 * the same rule the live console uses.
 */
export function detectSpikes(input: DetectSpikesInput): MemorySpike[] {
  const deep = input.samples
    .filter((s) => s.tier === 'deep' && s.summary)
    .sort((a, b) => a.elapsedMs - b.elapsedMs);

  if (deep.length < 2) return [];

  const threshold = Math.max(20 * MB, (input.totalRamBytes ?? 0) * 0.01);
  const markers = input.events
    .filter((e) => e.source === 'operator')
    .sort((a, b) => a.elapsedMs - b.elapsedMs);

  const spikes: MemorySpike[] = [];

  for (let i = 1; i < deep.length; i++) {
    const previous = deep[i - 1]!;
    const current = deep[i]!;

    const before = total(previous);
    const after = total(current);
    const deltaBytes = after - before;
    if (Math.abs(deltaBytes) < threshold) continue;

    const categories = CATEGORIES.map((c) => ({
      label: c.label,
      deltaBytes: (current.summary?.[c.key] ?? 0) - (previous.summary?.[c.key] ?? 0),
    }))
      .filter((c) => Math.abs(c.deltaBytes) >= 1 * MB)
      .sort((a, b) => Math.abs(b.deltaBytes) - Math.abs(a.deltaBytes));

    spikes.push({
      // Filled in below, once every candidate is ranked.
      letter: '',
      role: input.role,
      fromMs: previous.elapsedMs,
      toMs: current.elapsedMs,
      deltaBytes,
      totalBytes: after,
      kind: classify(deltaBytes, categories[0]),
      categories,
      // The last thing the tester marked before this point, which is the only
      // record of what the game was doing.
      nearestMarker:
        [...markers].reverse().find((m) => m.elapsedMs <= current.elapsedMs)?.label ?? null,
      mappings: mappingDeltas(previous, current),
      engine: engineDeltas(previous, current),
    });
  }

  const kept = spikes
    .sort((a, b) => Math.abs(b.deltaBytes) - Math.abs(a.deltaBytes))
    .slice(0, input.limit ?? 8);

  // Only growth is lettered. A release is worth listing but is not a peak, and
  // pointing a reader at it as though it were would be misleading.
  let next = 0;
  for (const spike of kept) {
    if (spike.deltaBytes > 0 && next < 26) {
      spike.letter = String.fromCharCode(65 + next++);
    }
  }

  return kept;
}

function total(sample: MemorySample): number {
  const s = sample.summary;
  if (!s) return 0;
  return CATEGORIES.reduce((sum, c) => sum + (s[c.key] ?? 0), 0);
}

/** Named mappings that moved, largest first. Empty when smaps was unreadable. */
function mappingDeltas(
  previous: MemorySample,
  current: MemorySample,
): Array<{ name: string; deltaBytes: number }> {
  if (!current.mappings) return [];

  const before = new Map(
    (previous.mappings ?? []).map((m) => [m.name, m.privateBytes || m.pssBytes]),
  );

  return current.mappings
    .map((m) => ({
      name: m.name,
      deltaBytes: (m.privateBytes || m.pssBytes) - (before.get(m.name) ?? 0),
    }))
    .filter((m) => Math.abs(m.deltaBytes) >= 1 * MB)
    .sort((a, b) => Math.abs(b.deltaBytes) - Math.abs(a.deltaBytes))
    .slice(0, 6);
}

/**
 * Unity's own buckets that moved.
 *
 * Only reported where *both* ends carry a reading: comparing a sample that has
 * a texture figure against one that does not would report the whole figure as
 * growth.
 */
function engineDeltas(
  previous: MemorySample,
  current: MemorySample,
): Array<{ label: string; deltaBytes: number }> {
  const a = previous.engine;
  const b = current.engine;
  if (!a || !b) return [];

  return ENGINE_BUCKETS.map((bucket) => {
    const x = a[bucket.key];
    const y = b[bucket.key];
    if (typeof x !== 'number' || typeof y !== 'number') return null;
    return { label: bucket.label, deltaBytes: y - x };
  })
    .filter((r): r is { label: string; deltaBytes: number } => r !== null && Math.abs(r.deltaBytes) >= 1 * MB)
    .sort((a2, b2) => Math.abs(b2.deltaBytes) - Math.abs(a2.deltaBytes));
}

/**
 * Thin the curve for the report.
 *
 * A ten-minute session holds ~120 deep samples, which is already a sensible
 * size for a chart; a long one holds far more than a document should carry.
 * Thinning keeps every local peak rather than sampling every Nth point, because
 * dropping a peak would flatten the very spike the report is about.
 */
export function buildTimelineSeries(
  role: string,
  samples: MemorySample[],
  maxPoints = 240,
): TimelineSeries {
  const deep = samples
    .filter((s) => s.tier === 'deep' && s.summary)
    .sort((a, b) => a.elapsedMs - b.elapsedMs);

  const points = deep.map((s) => ({
    elapsedMs: s.elapsedMs,
    totalBytes: total(s),
    categories: Object.fromEntries(
      CATEGORIES.map((c) => [c.key as string, s.summary?.[c.key] ?? 0]),
    ) as Record<string, number>,
  }));

  if (points.length <= maxPoints) return { role, points };

  // Keep the first, the last, every local maximum, and a regular sample of the
  // rest until the budget is spent.
  const keep = new Set<number>([0, points.length - 1]);
  for (let i = 1; i < points.length - 1; i++) {
    if (
      points[i]!.totalBytes > points[i - 1]!.totalBytes &&
      points[i]!.totalBytes >= points[i + 1]!.totalBytes
    ) {
      keep.add(i);
    }
  }

  const stride = Math.ceil(points.length / maxPoints);
  for (let i = 0; i < points.length && keep.size < maxPoints; i += stride) keep.add(i);

  return {
    role,
    points: [...keep].sort((a, b) => a - b).map((i) => points[i]!),
  };
}
