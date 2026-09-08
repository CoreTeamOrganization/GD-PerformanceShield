/**
 * One table of everything that happened, in the order it happened.
 *
 * The report already carried this information, spread across three places: the
 * frame-rate drops in one section, the memory jumps in another, a process kill
 * in a third. Each was sorted by severity, which is right for "what should I fix
 * first" and wrong for the question this table answers - *what happened, and
 * what else was happening at the same moment?*
 *
 * That question needs time order and one row per moment, because the whole point
 * is to notice that row three's frame drop and row three's memory jump are the
 * same event seen twice. A reader scanning severity-sorted lists in two
 * different sections cannot see that, and will report two bugs.
 *
 * The columns are fixed and narrow on purpose: time, what happened, the frame
 * rate, and one cell each for the subsystems, so the eye can run down a column
 * and find the one that moved. Anything longer belongs in the detail section,
 * which each row points at by letter.
 */
import { formatFpsClock } from '../analysis/fpsEvents.js';
import { CONFIDENCE_LABEL, type ConfidenceLevel } from '../analysis/confidence.js';
import type { AnalysisReport } from './model.js';
import type { Severity } from '../core/types.js';

type Diagnosis = NonNullable<AnalysisReport['diagnostics']>[number];
type Spike = NonNullable<AnalysisReport['session']>['spikes'][number];

export type EventKind = 'fps-drop' | 'fps-step' | 'memory-spike' | 'process-death';

/** How a metric behaved at one moment, in the fewest words that stay honest. */
export type CellState = 'up' | 'down' | 'normal' | 'unmeasured';

export interface EventCell {
  state: CellState;
  /** What to print. "Normal" and "-" are different claims and read differently. */
  text: string;
}

export interface EventRow {
  role: string;
  atMs: number;
  clock: string;
  kind: EventKind;
  /** A, B, C... the same letter the chart badge and the detail section use. */
  letter: string;
  /** What happened, in two or three words. */
  event: string;
  severity: Severity;
  /** Frame rate, as a transition where one is known. */
  fps: EventCell;
  memory: EventCell;
  cpu: EventCell;
  gpu: EventCell;
  /** The subsystem the diagnosis ranked first, or an honest absence. */
  culprit: string;
  confidence: ConfidenceLevel | null;
  confidenceText: string;
  /** Id of the diagnosis to link to, when there is one. */
  diagnosisId: string | null;
}

const MB = 1024 * 1024;

function fmtBytes(bytes: number): string {
  const abs = Math.abs(bytes);
  const sign = bytes > 0 ? '+' : bytes < 0 ? '-' : '';
  if (abs >= 1024 * MB) return `${sign}${(abs / (1024 * MB)).toFixed(2)} GB`;
  if (abs >= MB) return `${sign}${(abs / MB).toFixed(0)} MB`;
  return `${sign}${(abs / 1024).toFixed(0)} KB`;
}

const blank: EventCell = { state: 'unmeasured', text: '—' };
const normal: EventCell = { state: 'normal', text: 'normal' };

/** Plain-English name for the subsystem a diagnosis blamed. */
const CULPRIT: Record<string, string> = {
  memory: 'Memory / asset loading',
  gpu: 'GPU',
  rendering: 'Rendering workload',
  cpu: 'CPU / main thread',
  storage: 'Storage I/O',
  audio: 'Audio',
  thermal: 'Heat / throttling',
  system: 'Other apps on the device',
};

/**
 * Which subsystems a diagnosis found moving, as cells.
 *
 * Only the subsystems this table has a column for. A cause the table cannot
 * show still reaches the reader through the culprit column and the detail
 * section, so nothing is lost by not having a column for it.
 */
function cellsFromCauses(causes: Array<{ subsystem: string; statement: string }>): {
  memory: EventCell;
  cpu: EventCell;
  gpu: EventCell;
} {
  const has = (name: string) => causes.some((c) => c.subsystem === name);

  return {
    // Memory is filled in from the spike itself where one is attached, so this
    // is only the fallback for a diagnosis whose memory cause carried no figure.
    memory: has('memory') ? { state: 'up', text: 'rose' } : normal,
    cpu: has('cpu') ? { state: 'up', text: 'high' } : normal,
    gpu: has('gpu') || has('rendering') ? { state: 'up', text: 'high' } : normal,
  };
}

/**
 * Build the timeline for one device's role.
 *
 * Diagnoses are a top-level list tagged by role and memory spikes hang off the
 * session, so both are passed in rather than read off a device: the shapes do
 * not live in the same place and pretending otherwise is how a multi-device
 * report ends up attributing one phone's stutter to another.
 *
 * Rows are merged by moment: a frame drop and a memory spike within the
 * correlation tolerance are one row, not two, because they are one event. The
 * frame-rate row wins the merge, since a drop is what a player noticed and the
 * memory jump is the explanation.
 */
export function buildEventTimeline(
  role: string,
  allDiagnoses: readonly Diagnosis[],
  allSpikes: readonly Spike[],
  toleranceMs = 5000,
): EventRow[] {
  const rows: EventRow[] = [];
  const diagnoses = allDiagnoses.filter((d) => d.role === role);
  const spikes = allSpikes.filter((s) => s.role === role);

  /** Spikes already accounted for by a frame-rate row. */
  const claimed = new Set<string>();

  for (const d of diagnoses) {
    const causes = d.causes ?? [];
    const cells = cellsFromCauses(causes);

    // The memory spike that belongs to this moment, if any, so the row can
    // print the actual figure rather than the word "rose".
    const spike = spikes.find(
      (s) => Math.abs(s.toMs - d.atMs) <= toleranceMs || (s.fromMs <= d.atMs && s.toMs >= d.atMs),
    );
    if (spike) claimed.add(`${spike.fromMs}:${spike.toMs}`);

    const isDeath = d.kind === 'process-death';

    rows.push({
      role,
      atMs: d.atMs,
      clock: formatFpsClock(d.atMs),
      kind: isDeath ? 'process-death' : d.kind === 'step' ? 'fps-step' : 'fps-drop',
      letter: d.letter ?? '',
      event: isDeath ? 'Process died' : d.kind === 'step' ? 'Frame-rate step' : 'Frame-rate drop',
      severity: d.severity,
      fps: isDeath
        ? blank
        : {
            state: 'down',
            text: `${d.beforeFps ?? '?'} → ${d.lowestFps ?? d.fps}`,
          },
      memory: spike ? { state: 'up', text: fmtBytes(spike.deltaBytes) } : cells.memory,
      cpu: cells.cpu,
      gpu: cells.gpu,
      culprit:
        causes.length === 0
          ? 'Unknown'
          : (CULPRIT[causes[0]!.subsystem] ?? causes[0]!.subsystem),
      confidence: (d.level as ConfidenceLevel | undefined) ?? null,
      confidenceText: d.level
        ? (CONFIDENCE_LABEL[d.level as ConfidenceLevel] ?? '')
        : 'Insufficient data',
      diagnosisId: d.id,
    });
  }

  // Memory jumps that no frame-rate event explains. Worth a row of their own:
  // memory can climb without the frame rate moving at all, and that is exactly
  // the case that ends in a kill rather than a stutter.
  for (const s of spikes) {
    if (claimed.has(`${s.fromMs}:${s.toMs}`)) continue;
    rows.push({
      role,
      atMs: s.toMs,
      clock: formatFpsClock(s.toMs),
      kind: 'memory-spike',
      letter: s.letter,
      event: 'Memory jump',
      severity: 'medium',
      // Not "normal": the frame rate was not measured *for this row*, and
      // claiming it was fine is a stronger statement than the data supports.
      fps: blank,
      memory: { state: 'up', text: fmtBytes(s.deltaBytes) },
      cpu: blank,
      gpu: blank,
      culprit: s.categories?.[0]?.label
        ? `Memory: ${s.categories[0]!.label}`
        : 'Memory / asset loading',
      confidence: null,
      confidenceText: '—',
      diagnosisId: null,
    });
  }

  // Time order. This is the whole reason the table exists.
  rows.sort((a, b) => a.atMs - b.atMs);
  return rows;
}

/** Every device's rows, still in time order, for a single-table report. */
export function buildAllEventTimelines(report: AnalysisReport, toleranceMs = 5000): EventRow[] {
  const diagnoses = report.diagnostics ?? [];
  // A session block is absent for a static-only run, which has no timeline at
  // all - so no events, rather than a crash reading spikes off null.
  const spikes = report.session?.spikes ?? [];
  const rows = report.devices.flatMap((d) =>
    buildEventTimeline(d.role, diagnoses, spikes, toleranceMs),
  );
  rows.sort((a, b) => a.atMs - b.atMs || a.role.localeCompare(b.role));
  return rows;
}
