/**
 * Markdown rendering of the report, in three audience cuts.
 *
 * The same structured report answers three different questions depending on who
 * is reading it, and mixing them serves nobody: a lead scrolling past stack
 * traces to find the verdict, or an engineer hunting for a file path buried in
 * an executive summary.
 *
 *   lead      - is this a problem, how bad, what does it cost us?
 *   developer - what exactly do I change, and where?
 *   complete  - everything, including the evidence trail and the caveats.
 *
 * Each cut is a filter over the same data. Nothing appears in a narrower cut
 * that is not also in the wider ones, so the three can never disagree.
 */
import { FEATURES } from '../core/features.js';
import { renderFpsChartSvg } from './fpsChartSvg.js';
import { buildAllEventTimelines } from './eventTimeline.js';
import { CONFIDENCE_LABEL, CONFIDENCE_MEANING, type ConfidenceLevel } from '../analysis/confidence.js';
import { renderTimelineLegend, renderTimelineSvg } from './timelineSvg.js';
import {
  RATING_BASIS,
  RATING_LABEL,
  rateFps,
  rateJanks,
} from '../telemetry/deviceHealth.js';
import { relativeJankNote } from '../telemetry/fps.js';
import { MB } from '../core/types.js';
import { formatClock } from '../analysis/diagnostics.js';
import { tierTable } from '../analysis/deviceTier.js';
import { firstSentences, fmt, fmtPrecise, formatDuration } from './format.js';
import {
  audioDetailRows,
  bottleneckStatement,
  cpuDetailRows,
  fillRateNote,
  frameBudgetRows,
  gpuDetailRows,
  renderDetailRows,
  storageDetailRows,
  subsystemRows,
  STATUS_LABEL,
  STATUS_MARK,
  type PerfRow,
} from './performance.js';
import { buildSnapshot } from './snapshot.js';

/*
 * Re-exported from here because this module was where they lived, and the
 * printable renderer and the tests already import them from it. They moved to
 * `format.ts` so the summary snapshot can share them without importing a whole
 * Markdown renderer to get at `fmt`.
 */
export { firstSentences, fmt, fmtPrecise, formatDuration };
import { budgetTable, VERDICT_LABEL } from '../analysis/memoryBudget.js';
import type { AnalysisReport } from './model.js';

/*
 * Two cuts, not three.
 *
 * The developer cut sat between a summary that a lead reads and a complete
 * report that carries everything, and in practice it was the complete report
 * with some of the evidence removed - which is the one thing an engineer fixing
 * the problem does not want.
 */
export type ReportAudience = 'lead' | 'complete';

export interface AudienceProfile {
  id: ReportAudience;
  label: string;
  /** One-line description shown in the console's audience switcher. */
  description: string;
  fileName: string;
}

export const AUDIENCES: AudienceProfile[] = [
  {
    id: 'lead',
    label: 'Summary',
    description:
      'For a lead or producer: one page with the status, the four key numbers, the biggest ' +
      'issue and the bottom line.',
    fileName: 'report-summary.md',
  },
  {
    id: 'complete',
    label: 'Complete',
    description:
      'For the engineer fixing it: every finding with files and lines, all evidence, ' +
      'project data and caveats.',
    fileName: 'report.md',
  },
];

export function renderMarkdown(
  report: AnalysisReport,
  audience: ReportAudience = 'complete',
): string {
  const out: string[] = [];
  const w = (line = '') => out.push(line);

  /*
   * The summary is a different document, not a shorter one.
   *
   * It used to be this renderer with sections filtered out, which made it a
   * condensed technical report rather than an answer. `renderSnapshot` gives a
   * lead one page - status, four numbers, the biggest problem, the conclusion -
   * and everything it leaves out is still in the complete cut below.
   */
  if (audience === 'lead') {
    renderSnapshot(w, report);
    return out.join('\n');
  }

  /*
   * The lead cut returned above, so everything from here is a detailed cut. The
   * `isLead` flag the section renderers take stays because the printable
   * renderer shares them; on this path it is always false.
   */
  const isLead = false;
  const isComplete = audience === 'complete';

  // Summary first, in full: risk, memory against what this phone allows, the
  // session facts, and the curve. A reader who stops after this should still be
  // able to act.
  renderSummary(w, report, audience);

  // Everything from here explains why.
  renderDetailDivider(w);

  if (isLead) renderLeadPriorities(w, report);
  else renderDetailedPriorities(w, report, isComplete);

  renderRuntimeHealth(w, report, audience);
  renderFrameRate(w, report);
  // The subsystem figures behind the summary's one-row-per-subsystem table.
  // Complete cut only: a reader who wants a page-cache hit rate next to a
  // draw-call count is the engineer fixing it, not the lead reading the verdict.
  if (isComplete) renderSubsystemDetail(w, report);
  if (report.devices.length > 1) renderDevices(w, report, isLead);
  renderVerdict(w, report, isLead);
  renderSession(w, report, audience);

  if (!isLead && report.project) renderProject(w, report, isComplete);
  if (isComplete) renderAllFindings(w, report);
  if (isComplete) renderTierTable(w, report);
  if (isComplete) renderBudgetTable(w, report);
  if (isComplete) renderArtifacts(w, report);

  renderLimitations(w, report, isLead);
  renderFooter(w, report, audience);

  return out.join('\n');
}

/** Render every audience cut at once, for writing them all to disk. */
export function renderAllAudiences(report: AnalysisReport): Array<{
  audience: ReportAudience;
  fileName: string;
  markdown: string;
}> {
  return AUDIENCES.map((profile) => ({
    audience: profile.id,
    fileName: profile.fileName,
    markdown: renderMarkdown(report, profile.id),
  }));
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/**
 * The summary cut: a one-page performance snapshot.
 *
 * Same content as the printed snapshot, in the same order, because the two are
 * the same document in two formats and a reader must never have to reconcile
 * them. Markdown has no page, so the discipline the print layout gets from A4
 * is imposed here by hand: one line per fact, no paragraphs, and nothing that
 * needs explaining rather than reading.
 *
 * The tone marks are text, not colour, so the answer survives a plain-text
 * pipeline - a pasted Slack message, a ticket, a terminal.
 */
function renderSnapshot(w: Write, report: AnalysisReport): void {
  const snap = buildSnapshot(report);

  w(`# ${snap.gameName}`);
  w();
  w(`**${snap.eyebrow}**`);
  w();
  w('---');
  w();

  // Status, then the score, then confidence - and confidence on its own line so
  // it is never read as a second, smaller risk figure.
  w(`## ${toneMark(snap.risk.tone)} ${snap.risk.label} — ${snap.risk.value} / 100`);
  w();
  w(`${snap.concern}.`);
  w();
  w(`**Confidence: ${snap.confidence.percent}%** — ${snap.confidence.label}.`);
  w();

  for (const alert of snap.alerts) {
    w(`> ⚠️ **${alert}**`);
    w();
  }

  // The four numbers, as one table so they are read across rather than down.
  w(`| ${snap.kpis.map((k) => k.label.toUpperCase()).join(' | ')} |`);
  w(`|${snap.kpis.map(() => '---').join('|')}|`);
  w(`| ${snap.kpis.map((k) => (k.value ? `**${k.value}**` : '—')).join(' | ')} |`);
  w(`| ${snap.kpis.map((k) => (k.value ? k.caption : 'Not measured')).join(' | ')} |`);
  w(`| ${snap.kpis.map((k) => `${toneMark(k.tone)} ${k.status}`).join(' | ')} |`);
  w();

  // Pass or fail against this device class. First, because it is the question a
  // lead opens with and it answers in one word.
  if (snap.gate) {
    w(`## Build check: ${toneMark(snap.gate.tone)} ${snap.gate.status}`);
    w();
    w(snap.gate.headline);
    if (snap.gate.tier) {
      w();
      w(`Graded as ${snap.gate.tier}.`);
    }
    if (snap.gate.failed.length > 0) {
      w();
      for (const failed of snap.gate.failed) w(`- ${failed}`);
    }
    if (snap.gate.skipped > 0) {
      w();
      w(
        `*${snap.gate.skipped} check${snap.gate.skipped === 1 ? '' : 's'} could not be run, so this ` +
          'is not a clean bill of health for them — the complete report says which and why.*',
      );
    }
    w();
  }

  // What was holding the frame up: one line, plus how much to trust it.
  if (snap.limit) {
    w('## What is slowing it down?');
    w();
    w(`${toneMark(snap.limit.tone)} **${snap.limit.headline}**`);
    w();
    w(`*${snap.limit.basis}.*`);
    w();
  }

  // The five subsystems, one line each. This is the only place on the page where
  // a reader sees all of them at once and can tell which one to open.
  if (snap.subsystems.length > 0) {
    w('## Subsystem check');
    w();
    w('| Subsystem | Measured | Remark |');
    w('|---|---|---|');
    for (const s of snap.subsystems) {
      w(
        `| **${s.name}** | ${s.value ? escapePipes(s.value) : '—'} | ` +
          `${toneMark(s.tone)} ${s.status} |`,
      );
    }
    w();
  }

  w('## What is the biggest problem?');
  w();
  if (snap.issue) {
    const size = snap.issue.headline ? `**${snap.issue.headline}** — ` : '';
    w(`${size}**${snap.issue.kind}**`);
    if (snap.issue.detail) {
      w();
      w(snap.issue.detail);
    }
    w();
    w(`\`${snap.issue.priority}\``);
  } else {
    w('No major performance issue detected.');
  }
  w();

  // The worst frame collapse, with what happened alongside it. Deliberately one
  // entry: the complete report lists every episode, and the worst one is the
  // one a player noticed.
  if (snap.rootCause) {
    w('## Why did it stutter?');
    w();
    const rc = snap.rootCause;
    const during = rc.during ? ` during *${escapeMd(rc.during)}*` : '';
    const badge = rc.letter ? `**${rc.letter}** · ` : '';
    w(`${toneMark(rc.tone)} ${badge}**${rc.symptom}**${during}.`);
    w();
    // The size of the fall and how sure the tool is, on one line: without both,
    // a lead cannot tell a freeze from a slow game or a guess from a finding.
    if (rc.magnitude) {
      w(`Fell ${rc.magnitude} at ${rc.at}. Confidence: ${rc.confidence}.`);
      w();
    }
    if (rc.coincided) {
      w(`At the same moment: ${rc.coincided}.`);
      w();
    }
    w(`**What to do:** ${rc.fix}`);
    w();
  }

  w('## How did it play?');
  w();
  if (snap.experience) {
    w(snap.experience.facts.join(' · '));
    w();
    w(`**Overall: ${snap.experience.verdict}**`);
  } else {
    w('Frame rate was not measured in this session.');
  }
  w();

  w('## Device and session');
  w();
  w(`- **Device** — ${snap.device ?? 'No device measured'}`);
  w(`- **Session** — ${snap.session ?? 'No device session captured'}`);
  w();

  w('## Bottom line');
  w();
  w(`**${snap.bottomLine}**`);
  w();

  w('---');
  w();
  // The one distinction this page cannot afford to have misread, and where the
  // rest of the report went.
  w(
    '*Risk is how likely this game is to run out of memory. Confidence is how much of the ' +
      'intended testing actually happened — a low score with low confidence means "not yet shown ' +
      'to be a problem", not "known to be fine". The complete report carries the charts, the ' +
      'methodology and the technical detail behind every figure above.*',
  );
  w();
  w(
    `*GD-PerformanceShield ${report.toolVersion} · ` +
      `${report.generatedAt.slice(0, 16).replace('T', ' ')} · ${report.analysisId}*`,
  );
  w();
}

/** A traffic light as text, so the verdict survives a plain-text pipeline. */
function toneMark(tone: string): string {
  return tone === 'good' ? '🟢' : tone === 'watch' ? '🟠' : tone === 'bad' ? '🔴' : '⚪';
}



function renderVerdict(w: Write, report: AnalysisReport, isLead: boolean): void {
  const v = report.verdict;

  // The summary page already states the score, what it means and the confidence.
  // A lead cut has nothing further to add, and repeating it verbatim halfway down
  // reads as a second, different assessment.
  if (isLead) return;

  // For a developer the breakdown *is* new: which part of the score came from
  // reading the project and which from watching it run.
  w('## How does the risk score break down?');
  w();
  w('| Score | Value | Meaning |');
  w('|---|---|---|');
  w(
    `| **Combined OOM risk** | **${v.combinedRisk.value}/100 (${v.combinedRisk.band})** | ${bandMeaning(v.combinedRisk.band)} |`,
  );
  w(
    // Always 0 with no project, where it reads as a real score rather than an
    // absent one.
    ...(FEATURES.projectAnalysis
      ? [
          `| Static risk | ${v.staticRisk.value}/100 (${v.staticRisk.band}) | Risk predicted from the project source and assets. |`,
        ]
      : []),
  );
  w(
    `| Live risk | ${v.liveRisk.value}/100 (${v.liveRisk.band}) | Risk measured on real devices during play. |`,
  );
  w(
    `| Evidence confidence | ${Math.round(v.confidence.value * 100)}% | How much of the intended evidence was actually collected. |`,
  );
  w();
}

function renderDevices(w: Write, report: AnalysisReport, isLead: boolean): void {
  if (report.devices.length === 0) return;

  w('## Device results');
  w();

  if (isLead) {
    w('| Device | Peak memory | Budget for this device | Verdict |');
    w('|---|---|---|---|');
    for (const d of report.devices) {
      const b = d.budget;
      w(
        `| ${d.manufacturer} ${d.model} (${fmt(d.totalRamBytes)} RAM) | ${fmtOrDash(d.peakBytes)} | ` +
          `${b ? `target under ${fmt(b.targetMaxBytes)}, limit ~${fmt(b.hardLimitBytes)}` : '-'} | ` +
          `${b ? `${verdictMark(b.verdict)} ${VERDICT_LABEL[b.verdict]}` : '-'}${d.processDeaths > 0 ? ' — **crashed**' : ''} |`,
      );
    }
    w();
    for (const d of report.devices) {
      if (d.budget && d.budget.verdict !== 'green') w(`- ${d.budget.summary}`);
    }
    w();
    return;
  }

  w(
    'The lower-memory device (A) exposes practical OOM risk; the higher-memory device (B) separates ' +
      'genuine memory growth from device budget limits. Scores are deliberately not averaged.',
  );
  w();
  w(
    '| Device | Model | RAM | Peak | Budget target | Practical limit | Verdict | Baseline | Final | Growth | Killed |',
  );
  w('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const d of report.devices) {
    const b = d.budget;
    w(
      `| **${d.role}** | ${d.manufacturer} ${d.model} (Android ${d.androidVersion}) | ${fmt(d.totalRamBytes)} | ` +
        `${fmtOrDash(d.peakBytes)} | ${b ? `< ${fmt(b.targetMaxBytes)}` : '-'} | ${b ? `~${fmt(b.hardLimitBytes)}` : '-'} | ` +
        `${b ? `${verdictMark(b.verdict)} ${VERDICT_LABEL[b.verdict]}` : '-'} | ` +
        `${fmtOrDash(d.baselineBytes)} | ${fmtOrDash(d.finalBytes)} | ` +
        `${d.growthBytesPerMinute !== null ? `${fmt(d.growthBytesPerMinute)}/min` : '-'} | ` +
        `${d.processDeaths > 0 ? `**yes (${d.processDeaths})**` : 'no'} |`,
    );
  }
  w();
}

/** Lead view: what is wrong, what it costs, what to do - no code, no paths. */
function renderLeadPriorities(w: Write, report: AnalysisReport): void {
  w('## What is wrong?');
  w();
  renderDeviceContext(w, report);

  if (report.priority.length === 0) {
    w('No issues were found. Check the limitations below before treating this as a clean result.');
    w();
    return;
  }

  const top = report.priority.slice(0, 6);
  for (const item of top) {
    // The phone's name, not the analysis's role letter: "Device A" tells a lead
    // nothing, and this is the cut most likely to be read on its own.
    const f = { ...item.finding, title: namedForDisplay(item.finding.title, report) };
    w(`### ${item.rank}. ${f.title}`);
    w();
    w(`**${severityLabel(f.severity)} priority**${f.estimatedBytes ? ` · around **${fmt(f.estimatedBytes)}** at stake` : ''}${f.source === 'correlated' || f.source === 'live' ? ' · measured on a real device' : ''}`);
    w();
    w(firstSentences(f.description, 2));
    w();
    w(`**What to do:** ${firstSentences(f.recommendation, 1)}`);
    w();
  }

  if (report.priority.length > top.length) {
    w(
      `*${report.priority.length - top.length} further issues are listed in the developer report.*`,
    );
    w();
  }
}

/** Developer/complete view: full fixes with evidence. */
/**
 * The device a finding is about, named.
 *
 * Findings are written as "on Device A" because the analysis works in roles, and
 * a role letter means nothing to a reader. This states the phone, what it has,
 * what one app should use on it and what this build actually reached, so a
 * figure in a finding can be judged without hunting for the device table.
 */
function renderDeviceContext(w: Write, report: AnalysisReport): void {
  const d = report.devices[0];
  if (!d) return;

  const parts = [
    `**${d.manufacturer} ${d.model}**`,
    `${fmt(d.totalRamBytes)} of RAM`,
    d.budget ? `one app should stay under ${fmt(d.budget.targetMaxBytes)}` : '',
    d.peakBytes !== null ? `this build reached **${fmt(d.peakBytes)}**` : '',
  ].filter(Boolean);

  w(parts.join(' · '));
  w();
}

/** Replace the analysis's role letter with the phone's name, for display only. */
function namedForDisplay(title: string, report: AnalysisReport): string {
  return title.replace(/Device ([A-Z])(?![A-Za-z])/g, (whole, role: string) => {
    const device = report.devices.find((x) => x.role === role);
    return device ? `${device.manufacturer} ${device.model}` : whole;
  });
}

function renderDetailedPriorities(w: Write, report: AnalysisReport, isComplete: boolean): void {
  w('## What should we fix first?');
  w();

  if (report.priority.length === 0) {
    w('No findings were produced. See the limitations section before treating this as a clean result.');
    w();
    return;
  }

  renderDeviceContext(w, report);

  const limit = isComplete ? report.priority.length : 15;
  for (const item of report.priority.slice(0, limit)) {
    const f = item.finding;
    w(`### ${item.rank}. ${namedForDisplay(f.title, report)}`);
    w();
    w(
      `**${severityLabel(f.severity)}** · ${Math.round(f.confidence * 100)}% confidence · ${sourceLabel(f.source)}` +
        (f.estimatedBytes ? ` · estimated impact **${fmt(f.estimatedBytes)}**` : ''),
    );
    w();
    w(f.description);
    w();
    w('**Recommended fix**');
    w();
    w(f.recommendation);
    w();

    if (f.evidence.length > 0) {
      const shown = isComplete ? f.evidence : f.evidence.slice(0, 8);
      w('<details><summary>Where to look</summary>');
      w();
      for (const e of shown) {
        const location = e.path ? `\`${e.path}${e.line ? `:${e.line}` : ''}\`` : '';
        w(`- ${location}${location && e.summary ? ' — ' : ''}${escapeMd(e.summary)}`);
        if (e.excerpt) {
          w();
          w('  ```csharp');
          for (const line of e.excerpt.split('\n').slice(0, 8)) w(`  ${line}`);
          w('  ```');
        }
      }
      if (!isComplete && f.evidence.length > shown.length) {
        w(`- *…and ${f.evidence.length - shown.length} more (see the complete report)*`);
      }
      w();
      w('</details>');
      w();
    }
  }

  if (!isComplete && report.priority.length > limit) {
    w(`*${report.priority.length - limit} lower-priority findings omitted; see the complete report.*`);
    w();
  }
}

function renderSession(w: Write, report: AnalysisReport, audience: ReportAudience): void {
  const sess = report.session;

  if (!sess) {
    if (audience === 'lead') {
      w('## How was this tested?');
      w();
      w(
        'This analysis read the Unity project and the APK only — the game was **not run on a device**. ' +
          'Everything above is a prediction from the source, not something that was observed.',
      );
      w();
    } else {
      w('## Session timeline');
      w();
      w(
        'No live device session was captured. Every finding is a prediction from the project source and ' +
          'has not been confirmed on hardware.',
      );
      w();
    }
    return;
  }

  if (audience === 'lead') {
    w('## How was this tested?');
    w();
    w(
      `The game was installed and played on ${report.devices.length} device(s) for ` +
        `${formatDuration(sess.durationMs)}, with ${sess.markerCount} points marked during play.`,
    );
    w();
    const worst = [...sess.cycles]
      .filter((c) => c.recoveryDeltaBytes !== null)
      .sort((a, b) => (b.recoveryDeltaBytes ?? 0) - (a.recoveryDeltaBytes ?? 0))[0];
    if (worst && (worst.recoveryDeltaBytes ?? 0) > 0) {
      w(
        `Each time the same flow was repeated, roughly **${fmt(worst.recoveryDeltaBytes ?? 0)}** of memory ` +
          'was not given back. Memory that is never released after returning to the same screen is the ' +
          'clearest sign of a leak, and it accumulates every time a player repeats that loop.',
      );
      w();
    }
    return;
  }

  w('## Session timeline');
  w();
  w(
    `Session \`${sess.sessionId}\` ran for ${formatDuration(sess.durationMs)} with ` +
      `${sess.markerCount} operator marker(s).`,
  );
  w();

  if (sess.timeline.length > 0 && audience === 'complete') {
    const roles = Object.keys(sess.timeline[0]?.memoryByRole ?? {});
    w(`| Time | Event | ${roles.map((r) => `Device ${r}`).join(' | ')} |`);
    w(`|---|---|${roles.map(() => '---').join('|')}|`);
    for (const row of sess.timeline) {
      const cells = roles.map((r) => fmtOrDash(row.memoryByRole[r] ?? null));
      w(`| ${formatDuration(row.elapsedMs)} | ${escapePipes(row.label)} | ${cells.join(' | ')} |`);
    }
    w();
  }

  if (sess.cycles.length > 0) {
    w('### Repeated flow analysis');
    w();
    w(
      'Recovery delta is the memory still held after returning to the state the cycle started from. ' +
        'A delta that repeats or grows is stronger evidence of retention than a high peak.',
    );
    w();
    w('| Device | Cycle | Start | Peak | Returned to | Recovery delta |');
    w('|---|---|---|---|---|---|');
    for (const c of sess.cycles) {
      w(
        `| ${c.role} | ${escapePipes(c.label)} | ${fmtOrDash(c.startBytes)} | ${fmtOrDash(c.peakBytes)} | ` +
          `${fmtOrDash(c.recoveredBytes)} | ${signed(c.recoveryDeltaBytes)} |`,
      );
    }
    w();
  }

  if (sess.screenVisits.length > 0) {
    w('### Screen open/close behaviour');
    w();
    w('| Device | Screen | On open | Peak | After close | Retained |');
    w('|---|---|---|---|---|---|');
    for (const visit of sess.screenVisits) {
      w(
        `| ${visit.role} | ${escapePipes(visit.screen)} | ${fmtOrDash(visit.openBytes)} | ` +
          `${fmtOrDash(visit.peakBytes)} | ${fmtOrDash(visit.closedBytes)} | ${signed(visit.retainedBytes)} |`,
      );
    }
    w();
  }
}

/**
 * How the session ran: frame rate, heat and battery.
 *
 * These sit beside memory rather than under it because they are causes as often
 * as effects. A phone that throttles renders slower, a slower game holds assets
 * for longer, and the same peak reached hot and reached cool are not the same
 * result.
 */
/**
 * The same measurements under the in-game recorder's field names.
 *
 * See the HTML renderer for why this exists: two tools measuring one build have
 * to be readable together, and they are not when the same-looking name means a
 * different quantity in each.
 */
/**
 * Everything about frame rate, in one place, in the complete cut only.
 *
 * It used to be spread over three places: two rows in the runtime-health table,
 * a chart above the memory timeline, and the recorder fields further down. A
 * reader wanting the frame-rate story had to assemble it from all three.
 */
function renderFrameRate(w: Write, report: AnalysisReport): void {
  const d = report.devices[0];
  const f = d?.fps;
  if (!f || f.totalFrames === null) return;

  const sess = report.session;
  const jankRating = rateJanks(f.janks ?? 0, sess?.durationMs ?? 0);

  w('## Frame rate');
  w();
  w('| Figure | Value | Remark |');
  w('|---|---|---|');
  if (f.medianFps != null) w(`| Median | **${f.medianFps} fps** | the typical second |`);
  if (f.averageFps != null) w(`| Average | **${f.averageFps} fps** | frames over measured time |`);
  if (f.stabilityPercent != null) {
    w(
      `| Stability | **${f.stabilityPercent}%** | time within ±20% of the median · ` +
        `${f.stabilityPercent >= 80 ? 'good' : f.stabilityPercent >= 75 ? 'stable' : 'inconsistent - the rate wanders'} |`,
    );
  }
  if (f.janks != null) {
    w(
      `| Stutter | **${f.janks}** jank(s) | ${RATING_LABEL[jankRating]}` +
        (f.janksPerMinute != null ? ` · ${f.janksPerMinute}/min` : '') +
        ' |',
    );
  }
  if (f.bigJanks != null) {
    w(`| Severe jank | ${f.bigJanks} | ${f.bigJanks === 0 ? 'none' : 'visible hitches'} |`);
  }
  if (f.crossToolJanks != null) {
    w(
      `| Janks (cross-tool estimate) | ~${f.crossToolJanks} | what a GameBench-style counter ` +
        'reports - every frame over twice the typical interval; see the method note |',
    );
  }
  if (f.smallJanks != null) {
    w(`| Missed a refresh | ${f.smallJanks} | expected below the cap |`);
  }
  if (f.longestFrameMs != null) {
    w(
      `| Worst frame | ${f.longestFrameMs} ms | ` +
        `${f.longestFrameMs >= 500 ? 'a visible freeze' : 'longest single frame'} |`,
    );
  }
  if (f.displayHz != null) w(`| Screen refresh | ${f.displayHz} Hz | a device property |`);
  w();

  const p = f.percentiles;
  if (p) {
    const hz = f.displayHz;
    const share = (v: number) => (hz && hz > 0 ? `${Math.round((v / hz) * 100)}% of the panel` : '');
    w('### How the seconds were distributed');
    w();
    w('| Percentile | fps | What it says | Remark |');
    w('|---|---|---|---|');
    const ladder: Array<[string, number, string]> = [
      ['p01', p.p01, "the player's worst moments"],
      ['p05', p.p05, 'whether drops are frequent'],
      ['p25', p.p25, 'the bad quarter'],
      ['p50', p.p50, 'the typical second'],
      ['p75', p.p75, 'the good three-quarters'],
      ['p95', p.p95, 'near-best'],
      ['p99', p.p99, 'best sustained'],
    ];
    for (const [name, value, meaning] of ladder) {
      w(`| \`${name}\` | ${value} | ${meaning} | ${share(value)} |`);
    }
    w();
    w(
      'Percentiles are over one-second samples, so each value is a second the game actually ran. ' +
        'Read them against the cap the build asked for, not against 60.',
    );
    w();
  }

  renderFpsChart(w, report);
  renderTrackerFields(w, report);
}

function renderTrackerFields(w: Write, report: AnalysisReport): void {
  const d = report.devices[0];
  if (!d?.fps) return;

  const p = d.fps.percentiles ?? null;
  const mb = (bytes: number | null | undefined): string =>
    bytes === null || bytes === undefined ? '-' : String(Math.round(bytes / 1048576));
  const n = (v: number | null | undefined): string =>
    v === null || v === undefined ? '-' : String(v);

  w('### Read against the in-game recorder');
  w('');
  w('| Field | Measured | What it means |');
  w('| --- | --- | --- |');
  const rows: Array<[string, string, string]> = [
    ['fps_avg', n(d.fps.averageFps), 'Average over the session'],
    ['fps_min', n(d.fps.minFps), 'Worst single second'],
    ['fps_p01', p ? n(p.p01) : '-', "The player's worst moments"],
    ['fps_p05', p ? n(p.p05) : '-', 'Far below p50 means drops are frequent'],
    ['fps_p25', p ? n(p.p25) : '-', 'The bad quarter of the session'],
    ['fps_p50', p ? n(p.p50) : n(d.fps.medianFps), 'The typical second'],
    ['fps_p75', p ? n(p.p75) : '-', 'The good three-quarters boundary'],
    ['fps_p95', p ? n(p.p95) : '-', 'At the cap means the device has headroom'],
    ['fps_p99', p ? n(p.p99) : '-', 'Far under the cap means it can never reach target'],
    ['worst_ms', n(d.fps.longestFrameMs), 'Slowest single frame'],
    ['ram_total', mb(d.totalRamBytes), 'MB of physical RAM'],
    ['mem_sys_peak', mb(d.peakBytes), 'MB, whole process as the OS sees it'],
    ['mem_sys_avg', mb(d.averageBytes), 'MB, mean over the session'],
    [
      'seconds',
      n(report.session?.durationMs ? Math.round(report.session.durationMs / 1000) : null),
      'Length of the recorded window',
    ],
    // See the HTML renderer: the panel's refresh rate is not a substitute for
    // the cap the build asked for.
    ['tier_fps', '-', 'The cap the build asked for - in-engine only'],
  ];
  for (const [field, value, meaning] of rows) {
    w(`| \`${field}\` | ${value} | ${meaning} |`);
  }
  w('');
  w(
    'Field names match GDPerfTracker so a report and an analytics payload from the same build can ' +
      'be compared line by line. Two of the recorder\'s memory fields are missing here on purpose: ' +
      '`mem_alloc` and `mem_resv` are Unity\'s own counters, visible only from inside the process, ' +
      'and nothing measurable over adb stands in for them. `mem_sys` is the one the three share, and ' +
      "it is the figure Android's low-memory killer judges. `tier_fps` is blank for the same reason: " +
      'it is the cap the build asked for, and only the build knows that - so read every percentile ' +
      'above against the cap you set, not against 60.',
  );
  w('');
}

function renderRuntimeHealth(w: Write, report: AnalysisReport, audience: ReportAudience): void {
  const measured = report.devices.filter((d) => d.fps || d.thermal || d.battery);
  if (measured.length === 0) return;

  w('## Heat and battery');
  w();

  for (const d of measured) {
    if (report.devices.length > 1) {
      w(`### Device ${d.role} — ${d.manufacturer} ${d.model}`);
      w();
    }

    w('| | |');
    w('|---|---|');

    if (d.fps) {
      w(
        `| **Average frame rate** | ${d.fps.averageFps !== null ? `${d.fps.averageFps} fps` : 'not measured'} |`,
      );
      if (audience !== 'lead') {
        // The median belongs beside the average: one long stall drags an average
        // down but barely moves a median, so together they say both "how it
        // usually felt" and "what it cost overall".
        if (d.fps.medianFps !== null) w(`| Median frame rate | ${d.fps.medianFps} fps |`);
        if (
          d.fps.typicalFrameFps !== null &&
          d.fps.averageFps !== null &&
          d.fps.typicalFrameFps > d.fps.averageFps * 1.3
        ) {
          // Renders fast, then stalls. Neither the median nor the average shows
          // that on its own, and it points at a different cause than a game that
          // is simply slow throughout.
          w(
            `| Pace while rendering | ${d.fps.typicalFrameFps} fps — the game produces frames ` +
              `at this rate, then stalls; only ${d.fps.averageFps} fps of them arrived |`,
          );
        }
        if (d.fps.low1PercentFps !== null) {
          w(`| Worst 1% of frames | ${d.fps.low1PercentFps} fps |`);
        }
        if (d.fps.minFrameFps !== null && d.fps.longestFrameMs !== null) {
          w(
            `| Worst single frame | ${d.fps.minFrameFps} fps ` +
              `(${d.fps.longestFrameMs} ms) |`,
          );
        }
        if (d.fps.janks !== null) {
          w(
            `| **Stutter (janks)** | **${d.fps.janks}**` +
              (d.fps.janksPerMinute !== null ? ` · ${d.fps.janksPerMinute} per minute` : '') +
              (d.fps.bigJanks ? ` · ${d.fps.bigJanks} severe` : '') +
              ` · ${RATING_LABEL[rateJanks(d.fps.janks, report.session?.durationMs ?? 0)]} |`,
          );
        }
        if (d.fps.smallJanks !== null && d.fps.totalFrames !== null) {
          w(
            `| Frames that missed a refresh | ${d.fps.smallJanks} of ${d.fps.totalFrames} |`,
          );
        }
        // The panel's rate belongs beside the game's: on its own, "60 fps" does
        // not say whether the game is fast or simply following the screen.
        if (d.fps.displayHz !== null) {
          w(`| Screen refresh rate | ${d.fps.displayHz} Hz |`);
        }
        // The three rows that used to sit here - lowest 1% of window rates, worst
        // frame, and dropped-frame percentage - are superseded by the frame-level
        // figures above, which measure the same things per frame rather than per
        // five-second window. Keeping both duplicated a label and printed
        // "Stutter 0% of frames" directly beneath a count of 14 janks.
        if (d.fps.medianFps === null && d.fps.lowPercentileFps !== null) {
          // Only where frame times were unavailable, so something is still said.
          w(`| Lowest sampled rate | ${d.fps.lowPercentileFps} fps |`);
        }
      }
    }

    if (d.thermal) {
      const t = d.thermal;
      w(
        `| **Device heat** | ${THERMAL_LABEL[t.verdict]}` +
          (t.peakC !== null ? ` — peaked at ${t.peakC} °C` : '') +
          (t.riseC !== null ? `, up ${t.riseC} °C from the start` : '') +
          ' |',
      );
      // Start and end are separate facts from the peak: a device can touch 46 °C
      // mid-session and settle back to 40, and the end is the state the next
      // session would begin from.
      if (t.startC !== null && t.endC !== null) {
        w(`| Temperature, start → end | ${t.startC} °C → ${t.endC} °C |`);
      }
      if (audience !== 'lead' && t.throttlingMs > 0) {
        w(`| Time spent throttling | ${formatDuration(t.throttlingMs)} |`);
      }
      if (audience === 'complete' && t.hottestZone) {
        w(`| Hottest sensor | \`${t.hottestZone}\` |`);
      }
    }

    if (d.battery) {
      const b = d.battery;
      w(
        '| **Battery** | ' +
          (b.drainPercent !== null
            ? `${b.drainPercent}% used` +
              (b.drainPercentPerHour !== null ? ` (${b.drainPercentPerHour}%/hour)` : '') +
              (b.drainMah !== null ? `, ${b.drainMah} mAh` : '')
            : 'not measurable') +
          ' |',
      );
      if (b.startPercent !== null && b.endPercent !== null) {
        w(`| Battery, start → end | ${b.startPercent}% → ${b.endPercent}% |`);
      }
      if (b.startTemperatureC !== null && b.endTemperatureC !== null) {
        w(
          `| Battery temperature, start → end | ${b.startTemperatureC} °C → ` +
            `${b.endTemperatureC} °C |`,
        );
      }
    }

    w();

    // What the peak was measured against. Stated before the caveats, because it
    // changes how every number above should be read.
    const fresh = d.freshStart;
    if (fresh) {
      w('### What the phone was doing beforehand');
      w();
      w(
        '**The device was cleared before this run.** ' +
          (fresh.freedBytes !== null && fresh.freedBytes > 0
            ? `${fmt(fresh.freedBytes)} of memory was freed, `
            : '') +
          (fresh.stopped.length > 0
            ? `${fresh.stopped.length} background app(s) were closed`
            : 'no other app was holding memory') +
          (fresh.availableAfterBytes !== null
            ? `, leaving ${fmt(fresh.availableAfterBytes)} free when the game started.`
            : '.') +
          ' The peak above is therefore what this build needs on a quiet phone — on a device ' +
          'with other games resident it would have less room, and the same peak could get it killed.',
      );
      w();
      if (audience === 'complete' && fresh.stopped.length > 0) {
        w(`Closed: ${fresh.stopped.map((p) => `\`${p}\``).join(', ')}.`);
        w();
        if (fresh.skipped.length > 0) {
          w(
            'Left running: ' +
              fresh.skipped.map((s) => `\`${s.packageName}\` (${s.reason})`).join(', ') +
              '.',
          );
          w();
        }
      }
    } else if (d.fps || d.thermal) {
      w('### What the phone was doing beforehand');
      w();
      w(
        '*The device was not cleared before this run, so other apps were resident and holding ' +
          'memory. That is the realistic condition a player’s phone is in, but it means the ' +
          'figures above depend partly on what else was running.*',
      );
      w();
    }

    if (d.thermal?.verdict === 'throttling') {
      w(
        '⚠️ **The device was limiting its own performance during this session.** Frame rate and ' +
          'timings measured while throttling are lower than the game would achieve on a cool ' +
          'device, and memory that is held longer because frames take longer is a real effect, not ' +
          'a measurement artefact.',
      );
      w();
    }

    if (d.battery?.unavailableReason) {
      w('### Why battery drain is not reported');
      w();
      w(`*${d.battery.unavailableReason}*`);
      w();
    }

    // The most actionable thing frame-rate measurement can surface, and it is
    // silent unless it applies.
    if (d.fps?.matchesDisplayRate === true && d.fps.displayHz !== null) {
      w('### The frame-rate cap is not applying');
      w();
      w(
        `⚠️ **The game is running at the screen's refresh rate (${d.fps.displayHz} Hz), not at a ` +
          'frame rate of its own.** If the project sets a frame-rate cap, that cap is not taking ' +
          'effect. In Unity, `Application.targetFrameRate` is ignored whenever ' +
          '`QualitySettings.vSyncCount` is anything other than zero — which it is by default in ' +
          'most quality levels. Rendering twice as many frames as intended costs battery, heat and ' +
          'GPU memory pressure for no visible benefit.',
      );
      w();
    }

    // How a jank is counted, stated where the count is - a studio checking this
    // against another tool deserves to know where the two can disagree.
    if (audience === 'complete' && d.fps?.janks != null) {
      w(`*${relativeJankNote}*`);
      w();
      w(`*${RATING_BASIS}*`);
      w();
    }

    if (audience === 'complete' && d.fps?.source === 'gfxinfo') {
      w(
        '*Frame rate note:* measured through `gfxinfo`, which counts frames drawn by Android’s ' +
          'View system. A Unity game draws through its own surface, so this figure can ' +
          'under-report. It is used only where the compositor’s own per-layer timing was ' +
          'unavailable on this device.',
      );
      w();
    }
  }
}

/**
 * The memory curve, drawn.
 *
 * Markdown carries the SVG inline: every renderer that matters here (GitHub, the
 * PDF path, most viewers) accepts inline HTML, and an image beats a table of
 * numbers for the one question this answers - what shape was the session.
 */
function renderMemoryTimeline(w: Write, report: AnalysisReport, audience: ReportAudience): void {
  const sess = report.session;
  if (!sess || sess.timelineSeries.length === 0) return;

  w('## Memory over the session');
  w();

  const markers = sess.timeline
    .filter((e) => e.source === 'operator')
    .map((e) => ({ elapsedMs: e.elapsedMs, label: e.label }));

  for (const series of sess.timelineSeries) {
    if (series.points.length < 2) continue;

    const device = report.devices.find((d) => d.role === series.role);
    const svg = renderTimelineSvg({
      points: series.points,
      markers,
      checkpoints: (sess.spikes ?? [])
        .filter((sp) => sp.role === series.role && sp.letter)
        .map((sp) => ({ elapsedMs: sp.toMs, letter: sp.letter })),
      targetBytes: device?.budget?.targetMaxBytes ?? null,
      limitBytes: device?.budget?.hardLimitBytes ?? null,
      forPrint: false,
    });
    if (!svg) continue;

    if (report.devices.length > 1) {
      w(`**Device ${series.role} — ${device?.model ?? ''}**`);
      w();
    }
    w(svg);
    w();
    w(renderTimelineLegend());
    w();
  }

  w('---');
  w();
  w(
    '*Stacked by where the memory actually is, so the top edge is the total. Dashed lines are ' +
      'what one app may use on this phone; lettered circles mark the largest jumps and match ' +
      'the table below.*',
  );
  w();

  if (audience === 'lead') return;
}

/**
 * The largest jumps, with what moved inside them.
 *
 * Developer and complete only. A lead needs the verdict and the cost; a list of
 * memory mappings is noise to them and detail to an engineer, and putting it in
 * every cut would make the summary unreadable without making it more useful.
 */
function renderSpikes(w: Write, report: AnalysisReport, audience: ReportAudience): void {
  const spikes = report.session?.spikes ?? [];
  if (spikes.length === 0) return;

  w('### Largest memory jumps');
  w();
  w(
    'Each row is the change between two consecutive deep samples, biggest first. The deep tier ' +
      'runs at roughly one sample every five seconds, so a jump covers a few seconds of activity ' +
      'rather than one frame — enough to identify a scene load, not enough to blame a single call.',
  );
  w();

  const multiDevice = report.devices.length > 1;
  w(`| | ${multiDevice ? 'Device | ' : ''}At | Change | Total after | Looks like | Marker |`);
  w(`|---|${multiDevice ? '---|' : ''}---|---|---|---|---|`);
  for (const s of spikes) {
    w(
      `| **${s.letter || '·'}** |${multiDevice ? ` ${s.role} |` : ''} ` +
        `${clock(s.fromMs)} → ${clock(s.toMs)} | ` +
        `${signed(s.deltaBytes)} | ${fmt(s.totalBytes)} | ${s.kind} | ` +
        `${s.nearestMarker ? s.nearestMarker : '*unmarked*'} |`,
    );
  }
  w();

  // What moved inside each jump. Only worth printing where the OS or the engine
  // could actually name something.
  for (const s of spikes) {
    const hasDetail = s.categories.length > 0 || s.mappings.length > 0 || s.engine.length > 0;
    if (!hasDetail) continue;

    w(
      `#### ${s.letter ? `${s.letter} — ` : ''}` +
        `${s.deltaBytes > 0 ? '+' : ''}${fmt(s.deltaBytes)} at ${clock(s.toMs)}` +
        (multiDevice ? ` on device ${s.role}` : '') +
        ` — ${s.kind}`,
    );
    w();
    if (s.nearestMarker) {
      w(`Most recent marker before this point: **${s.nearestMarker}**.`);
    } else {
      w('*No marker was pressed before this point, so what the game was doing is unrecorded.*');
    }
    w();

    if (s.engine.length > 0) {
      w('**Unity engine allocations** — reported by the engine itself:');
      w();
      for (const e of s.engine) w(`- ${e.label}: ${signed(e.deltaBytes)}`);
      w();
    }

    if (s.mappings.length > 0) {
      w('**Named memory mappings** — read from the process:');
      w();
      for (const m of s.mappings) w(`- \`${m.name}\`: ${signed(m.deltaBytes)}`);
      w();
    }

    if (s.categories.length > 0) {
      w('**Reported categories** — from the system memory report:');
      w();
      for (const c of s.categories) w(`- ${c.label}: ${signed(c.deltaBytes)}`);
      w();
    }

    if (audience === 'complete' && s.engine.length === 0 && s.mappings.length === 0) {
      w(
        '*Only category totals are available for this jump. Naming the file or the asset type ' +
          'needs either the process’s own memory map (a debuggable build or a rooted device) or ' +
          'the Unity reporter component in the build.*',
      );
      w();
    }
  }
}

const THERMAL_LABEL: Record<string, string> = {
  cool: '🟢 stayed cool',
  warm: '🟡 warmed up',
  hot: '🔴 got hot',
  throttling: '🔴 throttled — the device limited its own performance',
  unknown: 'not measured',
};

function clock(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * The summary.
 *
 * One rule shapes it: a reader who sees only this should still be able to act.
 * So it carries the risk, the memory measured against what this phone allows,
 * how long the session ran and how the device behaved - then the curve itself.
 *
 * What it leaves out is the build metadata that used to lead the report. On a
 * run that profiles an installed app there is no APK to inspect, so package,
 * version, Unity and architecture all read "unknown", and the first thing a
 * reader met was a table of absences. Those move to the footer.
 */
function renderSummary(w: Write, report: AnalysisReport, audience: ReportAudience): void {
  const device = report.devices[0];
  const sess = report.session;

  w(`# ${report.subject.gameName} - memory risk report`);
  w();
  w(`> ${report.verdict.headline}`);
  w();

  const risk = report.verdict.combinedRisk;
  const confidence = Math.round(report.verdict.confidence.value * 100);
  w(`## Out of memory risk: ${risk.value} / 100 - ${risk.band.toUpperCase()}`);
  w();
  // What the band means in plain words, so the summary is complete on its own.
  w(bandMeaning(risk.band));
  w();
  w(
    `Confidence in this assessment: **${confidence}%** - ` +
      (confidence < 50
        ? 'an early indication only; most of the intended testing did not happen.'
        : 'the intended checks ran.'),
  );
  w();

  if (!device) {
    w('No device was measured, so there is nothing to report against a memory budget.');
    w();
    return;
  }

  // The session average, from the curve the report already carries. Worth as
  // much as the peak: a game that sat above target all session is a different
  // problem from one that touched it once.
  const points = sess?.timelineSeries[0]?.points ?? [];
  const averageBytes = points.length
    ? points.reduce((sum, p) => sum + p.totalBytes, 0) / points.length
    : null;

  const b = device.budget;
  w(`## Memory on ${device.manufacturer} ${device.model} (${fmt(device.totalRamBytes)} RAM)`);
  w();
  w('| | |');
  w('|---|---|');
  w(
    `| **Peak this session** | **${fmtOrDash(device.peakBytes)}**` +
      (b ? ` ${verdictMark(b.verdict)} ${VERDICT_LABEL[b.verdict]}` : '') +
      ' |',
  );
  if (averageBytes !== null) w(`| Average across the session | ${fmt(averageBytes)} |`);
  if (b) {
    w(`| Most one app should use on this phone | ${fmt(b.targetMaxBytes)} (${b.tier} device) |`);
    w(`| Where this phone starts killing apps | ~${fmt(b.hardLimitBytes)} |`);
  }
  w();

  // Session facts: duration, heat and frame rate, which frame everything above.
  const t = device.thermal;
  const f = device.fps;
  if (sess || t || f) {
    w('## The session');
    w();
    w('| | |');
    w('|---|---|');
    if (sess) {
      w(`| **Played for** | ${formatDuration(sess.durationMs)} |`);
      if (sess.markerCount > 0) w(`| Points marked during play | ${sess.markerCount} |`);
    }
    if (t?.peakC != null) {
      w(
        `| **Device heat** | ${t.peakC} °C peak - ${THERMAL_WORD[t.verdict] ?? ''}` +
          (t.riseC != null ? `, rose ${t.riseC} °C` : '') +
          ' |',
      );
    }
    if (f?.medianFps != null && f.averageFps != null) {
      // Both, with equal billing: the median says how the game usually felt,
      // the average says what the stalls cost overall.
      w(
        `| **Frame rate** | **${f.medianFps} fps** median · **${f.averageFps} fps** average` +
          (f.stabilityPercent != null ? ` · ${f.stabilityPercent}% stable` : '') +
          (f.displayHz ? ` (screen refreshes at ${f.displayHz} Hz)` : '') +
          ' |',
      );
    } else if (f?.averageFps != null) {
      // Frame rate is gathered into its own section in the complete cut, so
      // nothing about it is stated here. It used to appear in both places, which
      // asked the reader to reconcile two figures that never disagreed.
      void f;
    }
    w();
  }

  // Start against end. Battery drain is omitted where it cannot be measured, but
  // the charge levels are real readings and stay.
  const bat = device.battery;
  const rows: string[] = [];
  /*
   * Two decimals, because one was hiding the rows this table exists for. Over
   * three minutes the battery moves a fraction of a percent and the temperature
   * moves tenths; rounding those to 0.0 printed "no change", which is a
   * different claim from "changed by less than we print".
   */
  const delta = (
    label: string,
    start: number | null | undefined,
    end: number | null | undefined,
    unit: string,
    note = '',
  ) => {
    if (start == null || end == null) return;
    const change = end - start;
    const changed = Math.abs(change) < 0.005 ? 'no change' : `${change > 0 ? '+' : ''}${change.toFixed(2)}${unit}`;
    rows.push(
      `| ${label} | ${start.toFixed(2)}${unit} | ${end.toFixed(2)}${unit} | ${changed} | ${note} |`,
    );
  };

  const heatNote = t
    ? `${THERMAL_LABEL[t.verdict] ?? ''}${t.riseC != null ? ` · rose ${t.riseC.toFixed(2)} °C` : ''}`
    : '';
  delta('Device temperature', t?.startC, t?.endC, ' °C', heatNote);
  // The level is a whole percent, so its own columns can only ever say "no
  // change" over a short session. The remark carries the figure that moved: the
  // fuel gauge steps by 5 mAh, about a tenth of a percent.
  delta(
    'Battery charge',
    bat?.startPercent,
    bat?.endPercent,
    '%',
    bat?.netChargeMah != null
      ? `${bat.netChargeMah > 0 ? '+' : ''}${bat.netChargeMah.toFixed(2)} mAh net` +
          (bat.wasCharging ? ' · cable in' : '')
      : 'level is whole percent only',
  );
  delta(
    'Battery temperature',
    bat?.startTemperatureC,
    bat?.endTemperatureC,
    ' °C',
    'battery sensor · comparable between runs',
  );
  if (device.baselineBytes != null && device.finalBytes != null) {
    const change = device.finalBytes - device.baselineBytes;
    const budget = device.budget;
    const note = !budget
      ? ''
      : device.finalBytes > budget.hardLimitBytes
        ? 'past the practical limit'
        : device.finalBytes > budget.targetMaxBytes
          ? 'over target'
          : 'within budget';
    rows.push(
      `| Memory held | ${fmtPrecise(device.baselineBytes)} | ${fmtPrecise(device.finalBytes)} | ` +
        `${change === 0 ? 'no change' : `${change > 0 ? '+' : ''}${fmtPrecise(change)}`} | ${note} |`,
    );
  }

  if (rows.length > 0) {
    w('## Start to end of session');
    w();
    w('| Reading | At start | At end | Change | Remark |');
    w('|---|---|---|---|---|');
    for (const row of rows) w(row);
    w();
  }

  // Performance, in the order the questions get asked: did the build pass, what
  // limited the frame, which subsystem to open first, and why it stuttered when
  // it did. All four are up here because a reader who stops at the summary still
  // has to be able to act, and "the GPU was the limit" is the most actionable
  // sentence this tool produces.
  renderQualityGate(w, report, audience);
  renderBottleneck(w, report);
  renderSubsystemCheck(w, report);
  renderDiagnostics(w, report, audience);

  // Memory, then the breakdown that explains it. The frame-rate chart used to
  // sit above this; it now lives in the frame-rate section with the rest of the
  // frame-rate figures, so a reader finds all of them together.
  renderMemoryTimeline(w, report, audience);
  if (audience !== 'lead') renderSpikes(w, report, audience);

  // Whether it came back down, which no single jump can answer.
  renderMemoryGrowth(w, report, audience);

  /*
   * Last of the four, and deliberately after all of them: the timeline is a
   * cross-reference, not an introduction. It is only useful once a reader has
   * seen the frame-rate and memory sections it stitches together, and putting
   * it first would ask them to read a table of letters that mean nothing yet.
   */
  renderEventTimeline(w, report, audience);
}

/**
 * Frame rate over time.
 *
 * Beside the memory curve deliberately: a stutter that lines up with a memory
 * spike is one event with two symptoms, and seeing them on the same page is the
 * whole reason this tool measures both.
 */
function renderFpsChart(w: Write, report: AnalysisReport): void {
  for (const d of report.devices) {
    const series = d.fpsSeries ?? [];
    if (series.length < 2) continue;

    const svg = renderFpsChartSvg({
      points: series,
      displayHz: d.fps?.displayHz ?? null,
      // The same letters the detail section and the event table use, badged on
      // the curve, so "look at B" resolves in one glance.
      events: (d.fpsEvents ?? []).map((e) => ({
        elapsedMs: e.atMs,
        letter: e.letter,
        kind: e.kind,
      })),
      forPrint: false,
    });
    if (!svg) continue;

    w('### Over the session');
    w();
    if (report.devices.length > 1) {
      w(`**Device ${d.role} — ${d.model}**`);
      w();
    }
    w(svg);
    w();
    // Caption after the chart, short, and marked as an aside.
    w('---');
    w();
    w(
      '*Frames per second, measured from the compositor; the dashed line is what the hardware ' +
        'allows. Red marks are stutter — where one lines up with a memory jump below, it is ' +
        'one event and not two.*',
    );
    w();
  }
}

const THERMAL_WORD: Record<string, string> = {
  cool: 'stayed cool',
  warm: 'warmed up',
  hot: 'got hot',
  throttling: 'throttled, so the device limited its own performance',
  unknown: 'not measured',
};

// ---------------------------------------------------------------------------
// Performance: what limited the frame, and which subsystem to open first
// ---------------------------------------------------------------------------

/**
 * A label/value table from the rows `performance.ts` decided.
 *
 * The note column is dropped when no row has one, so a two-column table does
 * not carry an empty third column purely because the renderer is generic.
 */
function renderPerfRows(w: Write, rows: PerfRow[]): void {
  if (rows.length === 0) return;
  const hasNotes = rows.some((r) => r.note && r.note.length > 0);

  if (hasNotes) {
    w('| | | |');
    w('|---|---|---|');
    for (const row of rows) {
      w(`| ${escapePipes(row.label)} | **${escapePipes(row.value)}** | ${escapePipes(row.note ?? '')} |`);
    }
  } else {
    w('| | |');
    w('|---|---|');
    for (const row of rows) {
      w(`| ${escapePipes(row.label)} | **${escapePipes(row.value)}** |`);
    }
  }
  w();
}

/**
 * What was holding the frame up.
 *
 * Immediately after the session facts, because it is the sentence that decides
 * where a studio spends the next week. The frame budget table follows it rather
 * than leading, so a reader who only wants the answer gets it in one line.
 */
function renderBottleneck(w: Write, report: AnalysisReport): void {
  for (const device of report.devices) {
    const statement = bottleneckStatement(device);
    if (!statement) continue;
    // Nothing to say is better than a section that exists to report a shrug -
    // the limitations list already explains what was missing and why.
    if (device.bottleneck?.kind === 'unknown' && device.bottleneck.contributors.length === 0) {
      continue;
    }

    w('## What is slowing it down?');
    w();
    if (report.devices.length > 1) {
      w(`**${device.manufacturer} ${device.model}** (device ${device.role})`);
      w();
    }
    w(`**${statement.headline}**`);
    w();
    w(statement.reason);
    w();

    renderPerfRows(w, frameBudgetRows(device));

    const stages = frameBudgetRows(device).filter((r) => r.label.startsWith('—'));
    if (stages.length > 1) {
      // Said once, here, because a reader who adds these three numbers up and
      // compares the total against the frame time will conclude the report is
      // wrong when it is not.
      w(
        '*These three do not add up to the frame time: the render thread and the GPU work on the ' +
          'previous frame while the main thread works on the current one, so a frame costs about ' +
          'the longest of the three.*',
      );
      w();
    }

    const fillRate = fillRateNote(device);
    if (fillRate) {
      w(fillRate);
      w();
    }

    for (const contributor of device.bottleneck?.contributors ?? []) {
      w(`- ${contributor.note}`);
    }
    if ((device.bottleneck?.contributors.length ?? 0) > 0) w();

    w(`*${statement.basis}*`);
    w();
  }
}

/**
 * One row per subsystem, with the figure and whether it is a problem.
 *
 * The table a reader scans to decide which section to open. Rows that could not
 * be measured stay in it and say so: dropping them would make a run that
 * measured two subsystems look like a run where three were fine.
 */
function renderSubsystemCheck(w: Write, report: AnalysisReport): void {
  for (const device of report.devices) {
    const rows = subsystemRows(device);
    if (rows.length === 0) continue;

    w('## Subsystem check');
    w();
    if (report.devices.length > 1) {
      w(`**${device.manufacturer} ${device.model}** (device ${device.role})`);
      w();
    }
    w('| Subsystem | Measured | Against what | Remark |');
    w('|---|---|---|---|');
    for (const row of rows) {
      w(
        `| **${row.subsystem}** | ${escapePipes(row.headline)} | ` +
          `${escapePipes(row.detail)} | ${STATUS_MARK[row.status]} ${STATUS_LABEL[row.status]} |`,
      );
    }
    w();

    const unmeasured = rows.filter((r) => r.status === 'unmeasured');
    if (unmeasured.length > 0) {
      w(
        `*${unmeasured.length} of ${rows.length} subsystems could not be measured on this run, so ` +
          'this table is not a clean bill of health for them. The reasons are in the "Against what" ' +
          'column.*',
      );
      w();
    }
  }
}

/**
 * Why frames dropped, moment by moment.
 *
 * The payoff of measuring five subsystems on one clock: each entry names a
 * moment, says what the frame rate did, and lists what every other subsystem
 * was doing at the same instant. The wording is careful to stay at
 * "coincided with" rather than "caused by", because that is all a correlation
 * can support.
 */
function renderDiagnostics(w: Write, report: AnalysisReport, audience: ReportAudience): void {
  const diagnoses = report.diagnostics ?? [];
  if (diagnoses.length === 0) return;

  /*
   * The summary cut never reaches here.
   *
   * `renderMarkdown` sends `lead` to `renderSnapshot`, which is a different
   * document rather than a filtered one, and its brief account of the worst
   * collapse comes from `buildRootCause`. A second lead branch in this function
   * would be unreachable code claiming to be the summary's behaviour.
   */
  w('## FPS spike details');
  w();
  w(
    'One entry per lettered moment on the frame-rate chart, with what every other subsystem was ' +
      'doing at the same instant. These are coincidences in the data, ranked by how well they ' +
      'line up — the tool does not claim to have proved causation, and says so where the ' +
      'evidence is thin.',
  );
  w();

  for (const d of diagnoses) {
    const marker = d.nearestMarker ? ` — during *${escapeMd(d.nearestMarker)}*` : '';
    const heading = d.letter ? `${d.letter} · ${formatClock(d.atMs)}` : formatClock(d.atMs);
    w(
      `### ${heading} · ${severityLabel(d.severity)}` +
        (report.devices.length > 1 ? ` · device ${d.role}` : '') +
        marker,
    );
    w();

    // The numbers first, as a block, so the shape of the event is available
    // before the prose that interprets it.
    w('| | |');
    w('|---|---|');
    if (d.beforeFps != null && d.lowestFps != null) {
      w(`| **Frame rate** | ${d.beforeFps} → ${d.lowestFps} fps, recovered to ${d.afterFps ?? '—'} |`);
    } else {
      w(`| **Frame rate** | ${d.fps} fps at the worst point |`);
    }
    if (d.changePercent != null && d.changePercent !== 0) {
      w(`| **Drop** | ${Math.abs(d.changePercent).toFixed(0)}% against ${escapePipes(d.basis ?? 'the session median')} |`);
    }
    if (d.durationMs) {
      w(`| **Duration** | ${(d.durationMs / 1000).toFixed(1)} s |`);
    }
    if (d.janks > 0) w(`| **Stutter** | ${d.janks} jank(s) inside the event |`);
    w(`| **Confidence** | ${d.level ? CONFIDENCE_LABEL[d.level as ConfidenceLevel] : 'Insufficient data'} |`);
    w();

    w('**What changed at this moment**');
    w();
    if (d.causes.length === 0) {
      w(
        'Nothing else moved in the same window. The drop is real and measured; what caused it is ' +
          'not in this data.',
      );
      w();
    } else {
      w('| Subsystem | What it was doing |');
      w('|---|---|');
      for (const cause of d.causes) {
        w(`| ${SUBSYSTEM_TITLE[cause.subsystem] ?? cause.subsystem} | ${escapePipes(cause.statement)} |`);
      }
      w();
    }

    w(`**Why this conclusion.** ${d.conclusion}`);
    w();
    w(`**What to investigate.** ${d.recommendation}`);
    w();
  }
}

/** Subsystem names as a reader would say them, not as the enum spells them. */
const SUBSYSTEM_TITLE: Record<string, string> = {
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
 * Everything that happened, in the order it happened.
 *
 * The one view that makes a frame drop and a memory jump at the same second
 * legible as one event rather than two bugs. Severity-sorted lists cannot do
 * that, which is why this exists alongside them rather than replacing them.
 */
function renderEventTimeline(w: Write, report: AnalysisReport, audience: ReportAudience): void {
  if (audience === 'lead') return;

  const rows = buildAllEventTimelines(report);
  if (rows.length === 0) return;

  w('## Performance event timeline');
  w();
  w(
    'Every significant moment in time order, so a frame drop and a memory jump at the same ' +
      'second read as one event rather than two. Letters match the badges on the charts and the ' +
      'detail sections above.',
  );
  w();
  w('| Time | Event | Frame rate | Memory | CPU | GPU | Most likely | How sure |');
  w('|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    w(
      `| ${r.letter ? `**${r.letter}** · ` : ''}${r.clock} ` +
        `| ${r.event}${report.devices.length > 1 ? ` (${r.role})` : ''} ` +
        `| ${r.fps.text} | ${r.memory.text} | ${r.cpu.text} | ${r.gpu.text} ` +
        `| ${escapePipes(r.culprit)} | ${r.confidenceText} |`,
    );
  }
  w();
  w(
    'A dash means the metric was not measured at that moment, which is a different thing from ' +
      'it being normal.',
  );
  w();

  // The ladder, once, where the words are first used in anger.
  const used = new Set(rows.map((r) => r.confidence).filter(Boolean) as ConfidenceLevel[]);
  if (used.size > 0) {
    w('**How to read "how sure":**');
    w();
    for (const level of ['confirmed', 'high', 'medium', 'possible', 'insufficient'] as const) {
      if (!used.has(level)) continue;
      w(`- **${CONFIDENCE_LABEL[level]}** — ${CONFIDENCE_MEANING[level]}`);
    }
    w();
  }
}

/**
 * Whether memory was given back.
 *
 * Separate from the spike table because it answers a question no single jump
 * can: a 300 MB rise that returned to baseline is a level load, and the same
 * rise that stayed is the shape of a retention bug. The two need opposite
 * responses, so leaving the reader to infer which they have is the one thing
 * this section exists to prevent.
 */
function renderMemoryGrowth(w: Write, report: AnalysisReport, audience: ReportAudience): void {
  const interesting = report.devices.filter(
    (d) => d.memoryGrowth && d.memoryGrowth.verdict !== 'insufficient',
  );
  if (interesting.length === 0) return;

  // A summary cut carries it only when it is a problem; the complete cut always
  // carries it, because "memory behaved" is worth stating explicitly.
  const shown =
    audience === 'lead' ? interesting.filter((d) => d.memoryGrowth!.verdict === 'retained') : interesting;
  if (shown.length === 0) return;

  w('## Did memory come back down?');
  w();
  for (const device of shown) {
    const g = device.memoryGrowth!;
    const mark = g.verdict === 'retained' ? '🔴' : '🟢';
    const title =
      g.verdict === 'retained'
        ? 'Memory was retained'
        : g.verdict === 'released'
          ? 'Memory was released again'
          : 'Memory stayed level';

    w(
      `### ${mark} ${title}` +
        (report.devices.length > 1 ? ` — ${escapeMd(device.manufacturer)} ${escapeMd(device.model)}` : ''),
    );
    w();
    w(g.summary);
    w();
    if (g.verdict === 'retained') {
      w('| | |');
      w('|---|---|');
      w(`| **Held at the end** | ${fmtPrecise(g.retainedBytes)} above where it started |`);
      w(`| **Climb** | ${fmtPrecise(g.bytesPerMinute)} per minute |`);
      w(`| **Of what it gained** | ${Math.round(g.heldAtEndFraction * 100)}% never returned |`);
      if (g.floorRoseBytes > 0) {
        w(`| **Quiet moments rose** | ${fmtPrecise(g.floorRoseBytes)} |`);
      }
      w(`| **Confidence** | ${CONFIDENCE_LABEL[confidenceOf(g.confidence)]} |`);
      w();
    }
    if (g.recommendation) {
      w(`**What to investigate.** ${g.recommendation}`);
      w();
    }
  }
}

/** The ladder, without importing the mapper into every call site. */
function confidenceOf(value: number): ConfidenceLevel {
  if (value >= 0.85) return 'high';
  if (value >= 0.65) return 'medium';
  if (value >= 0.4) return 'possible';
  return 'insufficient';
}

/**
 * The CI gate, as a table.
 *
 * In the summary because "did this build pass?" is the first question a lead
 * asks, and because a check that failed is more useful to them than the figure
 * behind it. Skipped checks are listed rather than hidden: a green gate with
 * four skipped checks is not a green build.
 */
function renderQualityGate(w: Write, report: AnalysisReport, audience: ReportAudience): void {
  const gate = report.qualityGate;
  if (!gate) return;

  const mark = gate.status === 'pass' ? '🟢' : gate.status === 'warn' ? '🟡' : '🔴';
  w(`## Build check: ${mark} ${gate.status.toUpperCase()}`);
  w();
  w(
    gate.status === 'fail'
      ? `${gate.summary.failed} check${gate.summary.failed === 1 ? '' : 's'} failed against the ` +
          'thresholds for this device class. A build pipeline wired to this gate would stop here.'
      : gate.status === 'warn'
        ? `Nothing failed outright, but ${gate.summary.warned} check${gate.summary.warned === 1 ? ' is' : 's are'} ` +
            'within measurement noise of its threshold.'
        : 'Every check that could be measured passed the thresholds for this device class.',
  );
  w();

  for (const device of gate.devices) {
    if (gate.devices.length > 1) {
      w(`**${device.model}** — ${device.tier}`);
      w();
    } else {
      w(`Graded as **${device.tier}**.`);
      w();
    }

    // The lead cut shows what went wrong; the complete cut shows everything, so
    // a passing check's threshold is auditable too.
    const checks =
      audience === 'lead'
        ? device.checks.filter((c) => c.status === 'fail' || c.status === 'warn')
        : device.checks;

    if (checks.length === 0) {
      w('All checks passed.');
      w();
      continue;
    }

    w('| | Check | Measured | Limit |');
    w('|---|---|---|---|');
    for (const check of checks) {
      const gateMark =
        check.status === 'pass'
          ? '🟢'
          : check.status === 'warn'
            ? '🟡'
            : check.status === 'fail'
              ? '🔴'
              : '⚪';
      const limit =
        check.threshold === null
          ? '-'
          : `${check.direction === 'at-least' ? '≥' : '≤'} ${formatGateValue(check.threshold, check.unit)}`;
      w(
        `| ${gateMark} | ${escapePipes(check.label)} | ` +
          `${check.value === null ? 'not measured' : formatGateValue(check.value, check.unit)} | ${limit} |`,
      );
    }
    w();

    const skipped = device.checks.filter((c) => c.status === 'skipped');
    if (skipped.length > 0) {
      w(`**${skipped.length} check${skipped.length === 1 ? '' : 's'} could not be run:**`);
      w();
      for (const check of skipped) w(`- ${check.label} — ${check.message}`);
      w();
    }
  }

  w(
    '*Machine-readable at `quality-gate.json`: `status` is `pass`, `warn` or `fail`, and ' +
      '`exitCode` is non-zero on failure, so a pipeline step can gate on one field.*',
  );
  w();
}

/** A gate figure in the unit it was measured in. */
function formatGateValue(value: number, unit: string): string {
  if (unit === 'bytes') return fmt(value);
  if (unit === '°C') return `${value} °C`;
  return `${value.toLocaleString()} ${unit}`;
}

/**
 * The subsystem detail, in the complete cut only.
 *
 * Everything the summary compressed into one row per subsystem, expanded. Kept
 * out of the summary deliberately: a lead reading a draw-call count next to a
 * page-cache hit rate learns nothing they can act on.
 */
function renderSubsystemDetail(w: Write, report: AnalysisReport): void {
  for (const device of report.devices) {
    const sections: Array<[string, PerfRow[], string]> = [
      [
        'GPU and rendering',
        [...gpuDetailRows(device), ...renderDetailRows(device)],
        'GPU load comes from vendor sysfs; the per-frame counts come from the engine, because ' +
          'nothing outside the process can see them.',
      ],
      [
        'CPU and threading',
        cpuDetailRows(device),
        'A thread’s figure is a percentage of *one* core: a game’s main thread cannot spread ' +
          'across cores, so 100% is saturated no matter how much silicon is idle elsewhere.',
      ],
      [
        'Storage',
        storageDetailRows(device),
        'The gap between what the app read and what reached the flash is the page cache doing its ' +
          'job — a large read that never touched storage cost almost nothing.',
      ],
      ['Audio', audioDetailRows(device), ''],
    ];

    const populated = sections.filter(([, rows]) => rows.length > 0);
    if (populated.length === 0) continue;

    w('## Subsystem detail');
    w();
    if (report.devices.length > 1) {
      w(`**${device.manufacturer} ${device.model}** (device ${device.role})`);
      w();
    }

    for (const [title, rows, note] of populated) {
      w(`### ${title}`);
      w();
      renderPerfRows(w, rows);
      if (note) {
        w(`*${note}*`);
        w();
      }
    }

    // Per-thread and per-cluster tables, which only mean anything at this depth.
    const cpu = device.cpu;
    if (cpu && cpu.clusters.length > 0) {
      w('### CPU clusters');
      w();
      w('| Cluster | Cores | Average load | Peak load | Average clock | At its ceiling |');
      w('|---|---|---|---|---|---|');
      for (const cluster of cpu.clusters) {
        w(
          `| ${cluster.cluster} | ${cluster.coreCount} | ` +
            `${cluster.averageUsagePercent ?? '-'}% | ${cluster.peakUsagePercent ?? '-'}% | ` +
            `${cluster.averageFreqMhz ?? '-'} MHz | ${cluster.clockPinnedPercent ?? '-'}% of samples |`,
        );
      }
      w();
      w(
        '*Clusters are grouped by each core’s maximum frequency, which is how big.LITTLE is ' +
          'detectable without a vendor table — cores that share a ceiling share a cluster.*',
      );
      w();
    }

    if (cpu && cpu.threads.length > 0) {
      w('### Busiest threads');
      w();
      w('| Thread | What it is | Average | Peak | Saturated | Ran on |');
      w('|---|---|---|---|---|---|');
      for (const thread of cpu.threads) {
        w(
          `| \`${thread.name}\` | ${THREAD_ROLE_LABEL[thread.role] ?? thread.role} | ` +
            `${thread.averageCpuPercent}% | ${thread.peakCpuPercent}% | ` +
            `${thread.saturatedSamplePercent}% of samples | ` +
            `${thread.dominantCluster ?? '-'}` +
            `${thread.clusterConsistencyPercent !== null ? ` (${thread.clusterConsistencyPercent}%)` : ''} |`,
        );
      }
      w();
      w(
        '*Percentages are of one core. "Saturated" is the share of samples above 85%, where a ' +
          'thread has effectively run out of time. Thread names are truncated to 15 characters by ' +
          'the kernel, which is why the render thread reads `UnityGfxDeviceW`.*',
      );
      w();
    }

    const io = device.io;
    if (io && io.bursts.length > 0) {
      w('### Heaviest reads');
      w();
      w('| At | Read rate | From flash | Frame rate then | Stutter | During |');
      w('|---|---|---|---|---|---|');
      for (const burst of io.bursts) {
        w(
          `| ${formatClock(burst.elapsedMs)} | ${(burst.readBytesPerSecond / MB).toFixed(1)} MB/s | ` +
            `${burst.storageReadBytesPerSecond !== null ? `${(burst.storageReadBytesPerSecond / MB).toFixed(1)} MB/s` : '-'} | ` +
            `${burst.fps !== null ? `${burst.fps} fps` : '-'} | ${burst.janks ?? '-'} janks | ` +
            `${burst.nearestMarker ? escapePipes(burst.nearestMarker) : '-'} |`,
        );
      }
      w();
    }
  }
}

const THREAD_ROLE_LABEL: Record<string, string> = {
  main: 'main thread — game logic',
  render: 'render thread — draw submission',
  worker: 'job worker',
  audio: 'audio',
  gc: 'garbage collection',
  io: 'loading',
  other: 'other',
};

/**
 * The tier rubric, in the complete cut only.
 *
 * Same reasoning as the memory budget table: these thresholds are industry
 * practice rather than anything a platform publishes, so a reader who wants to
 * argue with a failed check needs to see the table it came from.
 */
function renderTierTable(w: Write, report: AnalysisReport): void {
  if (!report.devices.some((d) => d.tier)) return;

  w('## Performance thresholds per device class');
  w();
  w(
    'What "acceptable" means, by hardware class. A build is graded against the row its device ' +
      'lands in, because 45 fps is a good result on a budget handset and a bug on a flagship. ' +
      'Devices are tiered on RAM and on the fastest core’s clock; the frame-rate floor is also ' +
      'capped against the panel’s refresh rate, so a 120 Hz screen is not graded as though 60 ' +
      'were its ceiling.',
  );
  w();
  w('| Class | Median frame rate | Stutter | Temperature rise | Draw calls | Triangles | Audio dropouts |');
  w('|---|---|---|---|---|---|---|');
  for (const row of tierTable()) {
    w(
      `| ${row.label} | ≥ ${row.minMedianFps} fps | ≤ ${row.maxJanksPerMinute}/min | ` +
        `≤ ${row.maxThermalRiseC} °C | ≤ ${row.maxDrawCalls.toLocaleString()} | ` +
        `≤ ${row.maxTriangles.toLocaleString()} | ≤ ${row.maxUnderrunsPerMinute}/min |`,
    );
  }
  w();
  w(
    '*Draw-call and triangle ceilings are "unusual for the class" rather than hard budgets — a 2D ' +
      'game with 40 draw calls and a stylised 3D game with 900 can both be correct. They earn ' +
      'their place because a build that jumps from 300 to 1,900 between releases has regressed ' +
      'whatever the absolute is. The memory ceiling comes from the RAM tier table below, so the ' +
      'two never disagree.*',
  );
  w();
}

/**
 * The line between the summary and the detail.
 *
 * Markdown has no pages, so the boundary the print layout gets from a page break
 * has to be stated instead - otherwise a reader cannot tell where the part they
 * needed ends and the part explaining it begins.
 */
function renderDetailDivider(w: Write): void {
  w('---');
  w();
  w('# Detail');
  w();
  w('*Everything above is the summary. What follows explains it.*');
  w();
}

function renderProject(w: Write, report: AnalysisReport, isComplete: boolean): void {
  const p = report.project;
  if (!p) return;

  w('## Project overview');
  w();
  w('| | |');
  w('|---|---|');
  w(`| Assets indexed | ${p.assetCount.toLocaleString()} |`);
  w(`| C# files scanned | ${p.scriptFileCount.toLocaleString()} |`);
  w(`| Scenes (in build) | ${p.sceneCount} (${p.buildSceneCount}) |`);
  w(`| Textures | ${p.textureCount.toLocaleString()} - estimated ${fmt(p.estimatedTextureBytes)} |`);
  w(`| Audio clips | ${p.audioCount.toLocaleString()} - estimated ${fmt(p.estimatedAudioBytes)} |`);
  w(`| Addressables | ${p.usesAddressables ? 'yes' : 'no'} |`);
  w(`| Import settings available | ${p.metaFilesPresent ? 'yes' : 'no'} |`);
  w();

  if (p.heaviestScenes.length > 0) {
    w('### Heaviest scenes by referenced content');
    w();
    w('| Scene | Estimated assets | Objects |');
    w('|---|---|---|');
    for (const scene of p.heaviestScenes.slice(0, isComplete ? 20 : 8)) {
      w(`| \`${scene.path}\` | ${fmt(scene.estimatedBytes)} | ${scene.objectCount.toLocaleString()} |`);
    }
    w();
  }

  if (p.largestTextures.length > 0) {
    w('### Largest textures by estimated runtime memory');
    w();
    w('| Texture | Source size | Estimated memory |');
    w('|---|---|---|');
    for (const t of p.largestTextures.slice(0, isComplete ? 25 : 10)) {
      w(`| \`${t.path}\` | ${t.dimensions ?? '-'} | ${fmt(t.estimatedBytes)} |`);
    }
    w();
  }
}

function renderAllFindings(w: Write, report: AnalysisReport): void {
  w('## All findings');
  w();
  renderFindingGroup(
    w,
    'Correlated (measured on device, cause identified in the project)',
    report.findings.correlated,
  );
  renderFindingGroup(w, 'Runtime (measured on device)', report.findings.live);
  if (FEATURES.projectAnalysis) {
    renderFindingGroup(w, 'Static (predicted from the project)', report.findings.static);
  }
}

function renderArtifacts(w: Write, report: AnalysisReport): void {
  if (report.artifacts.length === 0) return;
  w('## Artifacts');
  w();
  for (const a of report.artifacts) {
    w(`- **${a.kind}** - ${a.description}: \`${a.path}\``);
  }
  w();
}

/**
 * The budget rubric, in the complete cut only.
 *
 * These figures are industry practice rather than anything Android publishes, so
 * a reader who wants to argue with a verdict needs to see the table it came from.
 */
function renderBudgetTable(w: Write, report: AnalysisReport): void {
  if (report.devices.length === 0) return;

  w('## Memory budget per device class');
  w();
  w(
    'How much memory one app may reasonably use, by device RAM. Verdicts above are graded against ' +
      'these figures. They reflect common practice for shipping mobile games, not a limit Android ' +
      'publishes — the hard limit is where the low-memory killer realistically starts choosing your ' +
      'process, not a hard cap.',
  );
  w();
  w('| Device RAM | Common industry target | Hard practical limit (OS kills you) |');
  w('|---|---|---|');
  for (const row of budgetTable()) {
    w(`| ${row.tier} | ${row.target} | ${row.hardLimit} |`);
  }
  w();
  w(
    '*Devices are matched on measured `MemTotal`, which is always below the marketed RAM — a "4 GB" ' +
      'phone typically reports about 3.7 GB.*',
  );
  w();
}

function renderLimitations(w: Write, report: AnalysisReport, isLead: boolean): void {
  const unique = [...new Set(report.limitations)];

  if (isLead) {
    const caveats = report.verdict.confidence.caveats;
    if (caveats.length === 0) return;
    w('## What would make this more certain?');
    w();
    for (const caveat of caveats.slice(0, 5)) w(`- ${caveat}`);
    w();
    return;
  }

  w('## Limitations and how to read this report');
  w();
  w(
    'Static findings are predictions: they describe content and code patterns that commonly cause ' +
      'memory problems, with estimated sizes derived from import settings. Runtime findings are ' +
      'measurements from a real device. Where the two agree, the finding is reported as correlated and ' +
      'carries the highest confidence.',
  );
  w();
  for (const limitation of unique) w(`- ${limitation}`);
  w();
}

function renderFooter(w: Write, report: AnalysisReport, audience: ReportAudience): void {
  w('---');
  w();
  const others = AUDIENCES.filter((a) => a.id !== audience)
    .map((a) => `\`${a.fileName}\` (${a.label.toLowerCase()})`)
    .join(', ');
  // The build metadata that used to lead the report lives here instead: on a run
  // that profiles an installed app there is no APK to inspect, so most of it
  // reads "unknown" and it made a poor opening statement. Values that exist are
  // still printed, so the report stays traceable.
  const s = report.subject;
  const facts = [
    s.packageName,
    s.versionName ? `version ${s.versionName}` : null,
    s.unityVersion ? `Unity ${s.unityVersion}` : null,
    s.scriptingBackend,
    s.abis.length > 0 ? s.abis.join(', ') : null,
  ].filter(Boolean);

  if (facts.length > 0) {
    w(`*${facts.join(' · ')}*`);
    w();
  }
  w(
    `*Measured on device during real gameplay by GD-PerformanceShield ${report.toolVersion}, ` +
      `${report.generatedAt.slice(0, 16).replace('T', ' ')}. Reference \`${report.analysisId}\`. ` +
      `Other views: ${others}. Structured data: \`report.json\`.*`,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Write = (line?: string) => void;

function renderFindingGroup(
  w: Write,
  title: string,
  findings: AnalysisReport['findings']['static'],
): void {
  w(`### ${title}`);
  w();
  if (findings.length === 0) {
    w('None.');
    w();
    return;
  }
  w('| Severity | Confidence | Finding | Estimated impact | Rule |');
  w('|---|---|---|---|---|');
  for (const f of [...findings].sort(bySeverity)) {
    w(
      `| ${severityLabel(f.severity)} | ${Math.round(f.confidence * 100)}% | ${escapePipes(f.title)} | ` +
        `${f.estimatedBytes ? fmt(f.estimatedBytes) : '-'} | \`${f.ruleId}\` |`,
    );
  }
  w();
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

function bySeverity(
  a: AnalysisReport['findings']['static'][number],
  b: AnalysisReport['findings']['static'][number],
): number {
  const diff = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
  return diff !== 0 ? diff : b.confidence - a.confidence;
}



function bandMeaning(band: string): string {
  switch (band) {
    case 'critical':
      return 'The game is very likely to run out of memory on the target device class.';
    case 'high':
      return 'Serious memory problems were found; expect crashes on lower-memory devices.';
    case 'moderate':
      return 'Real issues exist but the game is not in immediate danger on the tested devices.';
    default:
      return 'No significant memory risk was identified in what was tested.';
  }
}

function confidenceMeaning(value: number): string {
  if (value >= 0.8) return 'nearly all of the intended checks were completed.';
  if (value >= 0.6) return 'most checks were completed; see the notes at the end.';
  if (value >= 0.4) return 'a significant part of the intended testing did not happen.';
  return 'this is an early indication only; most of the intended testing did not happen.';
}





function fmtOrDash(bytes: number | null | undefined): string {
  return bytes === null || bytes === undefined ? '-' : fmt(bytes);
}

function signed(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '-';
  const formatted = fmt(bytes);
  return bytes > 0 ? `**+${formatted}**` : formatted;
}



/**
 * Traffic light as text, so it survives plain-text and PDF rendering rather than
 * depending on colour the reader may not get.
 */
function verdictMark(verdict: 'green' | 'yellow' | 'red'): string {
  return verdict === 'green' ? '🟢' : verdict === 'yellow' ? '🟡' : '🔴';
}

function severityLabel(severity: string): string {
  return severity.charAt(0).toUpperCase() + severity.slice(1);
}

function sourceLabel(source: string): string {
  switch (source) {
    case 'correlated':
      return 'measured on device, cause found in the project';
    case 'live':
      return 'measured on device';
    default:
      return 'predicted from the project';
  }
}

function escapePipes(value: string): string {
  return value.replace(/\|/g, '\\|');
}

function escapeMd(value: string): string {
  return value.replace(/([*_`])/g, '\\$1');
}
