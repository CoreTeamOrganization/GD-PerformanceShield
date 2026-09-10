/**
 * Attach the previous run's headline delta to a fresh report.
 *
 * "Did the update make it better?" is the first question a producer asks of any
 * session, and until now answering it meant knowing the compare command exists
 * and which two ids to feed it. This finds the most recent earlier analysis of
 * the same game in the workspace, runs the full comparison engine over the two
 * stored reports, and keeps only the headline rows - the complete comparison
 * remains available through the compare command; this is the five-line answer.
 *
 * Deliberately incapable of failing a run: a report with no comparison is a
 * report, a run killed by a comparison bug is a lost session. Every path out of
 * here on error is "attach nothing and say why in the log".
 */
import { compareSessions, type MetricChange } from '../analysis/compareSessions.js';
import { loadConfig } from '../core/config.js';
import { listJobs } from '../core/job.js';
import type { Logger } from '../core/logger.js';
import { Workspace } from '../core/workspace.js';

import { safeValidateReport, type AnalysisReport } from './model.js';

/** The runtime rows worth putting in front of every reader, in display order. */
const HEADLINE_LABELS = [
  'Median frame rate (fps)',
  'Average frame rate (fps)',
  'Frame rate against its own target (%)',
  'Stutter (janks per minute)',
  'Combined risk score',
];

export function attachPreviousRun(
  report: AnalysisReport,
  config = loadConfig(),
  logger?: Logger,
): void {
  try {
    const previous = findPreviousReport(report, config);
    if (!previous) return;

    const comparison = compareSessions(previous.report, report);

    const rows: MetricChange[] = [];
    for (const label of HEADLINE_LABELS) {
      const row = comparison.runtime.find((r) => r.label === label);
      if (row && (row.before !== null || row.after !== null)) rows.push(row);
    }
    // Peak memory and kills carry their own gating (same-screens coverage), so
    // they come from their dedicated slots rather than the runtime table.
    for (const row of [comparison.peak, comparison.kills]) {
      if (row && (row.before !== null || row.after !== null)) rows.push(row);
    }
    if (rows.length === 0) return;

    report.previousRun = {
      analysisId: previous.report.analysisId,
      when: previous.createdAt ?? null,
      device: comparison.before.device || null,
      blocked: comparison.blocked,
      caveats: [
        ...comparison.gates.filter((g) => g.level !== 'note').map((g) => g.message),
        ...(comparison.runtimeCaveat ? [comparison.runtimeCaveat] : []),
      ],
      rows: rows.map((r) => ({
        label: r.label,
        before: r.before,
        after: r.after,
        direction: r.direction,
        ...(r.note ? { note: r.note } : {}),
      })),
    };
    logger?.info('Attached comparison with the previous run', {
      previous: previous.report.analysisId,
      rows: rows.length,
    });
  } catch (e) {
    logger?.warn('Could not attach the previous-run comparison', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function findPreviousReport(
  current: AnalysisReport,
  config: ReturnType<typeof loadConfig>,
): { report: AnalysisReport; createdAt: string | null } | null {
  // Newest first; skip the run being reported on and anything unreadable. A
  // workspace accumulates aborted runs with no report - those are not previous
  // runs, they are noise, so the walk continues past them.
  for (const meta of listJobs(config, 200)) {
    if (meta.gameId !== current.gameId) continue;
    if (meta.analysisId === current.analysisId) continue;
    try {
      const ws = new Workspace(config.workspaceRoot, meta.gameId, meta.analysisId);
      const raw = ws.readJson<unknown>('reports', 'report.json');
      if (!raw) continue;
      const parsed = safeValidateReport(raw);
      if (!parsed.ok || !parsed.report) continue;
      return { report: parsed.report, createdAt: meta.createdAt ?? null };
    } catch {
      continue;
    }
  }
  return null;
}
