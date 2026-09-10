/**
 * Print-ready HTML rendering of the report — the source for PDF export.
 *
 * Deliberately a separate renderer from the Markdown one rather than a Markdown
 * conversion: a printed report has constraints Markdown has no way to express -
 * page size, where a page may break, which sections must stay together, and how
 * a table behaves when it runs past the paper. Getting those right is most of
 * what makes a PDF readable.
 *
 * Always light: a dark report wastes ink and reads badly on paper, so this
 * ignores the console's theme entirely.
 *
 * The audience cuts match the Markdown renderer exactly, so a PDF and its .md
 * equivalent can never disagree about what a reader was shown.
 */
import { FEATURES } from '../core/features.js';
import { renderFpsChartSvg } from './fpsChartSvg.js';
import { renderTimelineLegend, renderTimelineSvg } from './timelineSvg.js';
import { RATING_BASIS, RATING_LABEL, rateJanks } from '../telemetry/deviceHealth.js';
import { relativeJankNote } from '../telemetry/fps.js';
import {
  AUDIENCES,
  firstSentences,
  fmt,
  fmtPrecise,
  formatDuration,
  type ReportAudience,
} from './markdown.js';
import { VERDICT_LABEL } from '../analysis/memoryBudget.js';
import { MB } from '../core/types.js';
import { renderSnapshotHtml } from './snapshotHtml.js';
import { buildAllEventTimelines, type EventCell } from './eventTimeline.js';
import {
  CONFIDENCE_LABEL,
  CONFIDENCE_MEANING,
  CONFIDENCE_TONE,
  confidenceLevel,
  type ConfidenceLevel,
} from '../analysis/confidence.js';
import { formatClock } from '../analysis/diagnostics.js';
import { tierTable } from '../analysis/deviceTier.js';
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
  type PerfRow,
} from './performance.js';
import type { AnalysisReport } from './model.js';

type Finding = AnalysisReport['findings']['static'][number];

export function renderPrintableHtml(
  report: AnalysisReport,
  audience: ReportAudience = 'complete',
  opts: { autoPrint?: boolean } = {},
): string {
  /*
   * The summary is a different document, not a shorter one.
   *
   * It used to be this renderer with sections filtered out, which made it a
   * condensed technical report: the same headings, the same tables, the same
   * prose, only less of it. A lead does not need a smaller report - they need
   * the answer. `renderSnapshotHtml` gives them one page holding the status, the
   * four numbers, the biggest problem and the conclusion, and everything it
   * leaves out is still here in the complete cut.
   */
  if (audience === 'lead') return renderSnapshotHtml(report, opts);

  const profile = AUDIENCES.find((a) => a.id === audience);
  const isLead = false;
  const isComplete = audience === 'complete';

  const title = `${report.subject.gameName} — OOM Risk ${profile?.label ?? 'Report'}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>${PRINT_CSS}</style>
</head>
<body>
<!--
  The summary carries the risk, the memory against what this phone allows, the
  session facts and the curve itself. A reader who sees only that should still be
  able to act; everything after it explains those numbers. Content flows rather
  than being forced onto page boundaries, so no page is left half empty.
-->
${renderSummary(report, audience)}
${isLead ? renderLeadFindings(report) : renderDetailedFindings(report, isComplete)}
${renderRuntimeHealth(report, audience)}
${isLead ? '' : renderFrameRate(report, audience)}
${isComplete ? renderSubsystemDetail(report) : ''}
${report.devices.length > 1 ? renderDevices(report, isLead) : ''}
${renderVerdict(report, isLead)}
${renderSession(report, audience)}
${!isLead ? renderProject(report, isComplete) : ''}
${isComplete ? renderAllFindings(report) : ''}
${isComplete ? renderTierTable(report) : ''}
${renderAbout(report, audience)}
${renderLimitations(report, isLead)}
${renderFooter(report, audience)}
${opts.autoPrint ? '<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},250)})</script>' : ''}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/**
 * The first page.
 *
 * One rule shapes it: a reader who sees only this page should still be able to
 * act. So it carries the risk, the memory against what this phone allows, how
 * long the session ran and how the device behaved - and then the curve itself.
 * Everything that explains those numbers starts afterwards.
 *
 * What it deliberately leaves out is the build metadata that used to lead the
 * report. On a run that profiles an installed app there is no APK to inspect, so
 * package, version, Unity and architecture all read "unknown" and the first
 * thing a reader met was a table of absences. Those move to the footer, where
 * the ones that do have values still make the report traceable.
 */
function renderSummary(report: AnalysisReport, audience: ReportAudience): string {
  const device = report.devices[0];
  if (!device) return '';

  const session = report.session;
  const budget = device.budget;
  const fps = device.fps;
  const thermal = device.thermal;
  const battery = device.battery;

  // The session average, from the curve the report already carries. Worth as
  // much as the peak: a game that sat above target all session is a different
  // problem from one that touched it once.
  const points = session?.timelineSeries[0]?.points ?? [];
  const averageBytes = points.length
    ? points.reduce((sum, p) => sum + p.totalBytes, 0) / points.length
    : null;

  const chip = budget ? verdictChip(budget.verdict) : '';

  const memoryRows = [
    `<tr class="headline"><td class="k">Peak this session</td>
      <td class="v">${orDash(device.peakBytes)} ${chip}</td></tr>`,
    averageBytes !== null
      ? `<tr><td class="k">Average across the session</td>
          <td class="v">${fmt(averageBytes)}</td></tr>`
      : '',
    budget
      ? `<tr><td class="k">Most one app should use on this phone
          <span class="sub"><br>for a ${esc(budget.tier)} device</span></td>
          <td class="v">${fmt(budget.targetMaxBytes)}</td></tr>`
      : '',
    budget
      ? `<tr><td class="k">Where this phone starts killing apps</td>
          <td class="v">${fmt(budget.hardLimitBytes)}</td></tr>`
      : '',
  ].join('');

  const confidence = Math.round(report.verdict.confidence.value * 100);
  const band = report.verdict.combinedRisk.band;

  const strip = [
    session
      ? statCell('Played for', formatDuration(session.durationMs), `${session.markerCount} point(s) marked`)
      : '',
    thermal?.peakC != null
      ? statCell(
          'Device heat',
          `${thermal.peakC}<span class="unit">°C peak</span>`,
          `${THERMAL_WORD[thermal.verdict] ?? ''}${thermal.riseC != null ? ` · rose ${thermal.riseC} °C` : ''}`,
        )
      : '',
    // Frame rate is deliberately absent from this strip. Everything about it -
    // the chart, the percentile ladder, the jank breakdown and the recorder
    // fields - is gathered into one "Frame rate" section in the complete report,
    // so a reader looking for it finds all of it in one place instead of a
    // headline here and the detail four sections down.
  ]
    .filter(Boolean)
    .join('');

  // Battery drain is omitted rather than shown as a dash: over a USB cable there
  // is nothing to measure, and an empty card is worse than no card. The charge
  // levels are real readings, so they stay in the table below.
  const deltas = [
    deltaRow(
      'Device temperature',
      thermal?.startC ?? null,
      thermal?.endC ?? null,
      ' °C',
      heatRemark(thermal?.riseC ?? null, thermal?.verdict),
    ),
    deltaRow(
      'Battery charge',
      battery?.startPercent ?? null,
      battery?.endPercent ?? null,
      '%',
      // The level is a whole percent, so its own row can only ever say "no
      // change" over a few minutes. The remark carries the figure that moved.
      battery?.netChargeMah != null
        ? remark(
            `${battery.netChargeMah > 0 ? '+' : ''}${battery.netChargeMah.toFixed(2)} mAh net` +
              (battery.wasCharging ? ' · cable in' : ''),
            battery.wasCharging ? 'flat' : battery.netChargeMah <= -100 ? 'watch' : 'good',
          )
        : remark('level is whole percent only', 'flat'),
    ),
    deltaRow(
      'Battery temperature',
      battery?.startTemperatureC ?? null,
      battery?.endTemperatureC ?? null,
      ' °C',
      remark('battery sensor · comparable between runs', 'flat'),
    ),
    deltaRowBytes(
      'Memory held',
      device.baselineBytes,
      device.finalBytes,
      budgetRemark(device.finalBytes, device.budget),
    ),
  ]
    .filter(Boolean)
    .join('');

  return `<section class="summary">
  <div class="eyebrow">Memory risk report · measured on device during real gameplay</div>
  <h1>${esc(report.subject.gameName)}</h1>
  <p class="lede">${esc(report.verdict.headline)}</p>

  <div class="top">
    <div class="risk band-${esc(band)}">
      <div class="blk-label">Out of memory risk</div>
      <div class="score">${report.verdict.combinedRisk.value}<span class="out-of">/100</span></div>
      <div class="band">${esc(band)}</div>
      <div class="conf">Confidence ${confidence}% — ${esc(
        confidenceMeaning(report.verdict.confidence.value),
      )}</div>
    </div>

    <div class="memory">
      <div class="blk-label">Memory · ${esc(device.manufacturer)} ${esc(device.model)} · ${fmt(device.totalRamBytes)} RAM</div>
      <table>${memoryRows}</table>
    </div>
  </div>

  ${strip ? `<div class="strip">${strip}</div>` : ''}

  ${
    deltas
      ? `<div class="blk-label">Start to end of session</div>
         <table class="delta bordered">
           <thead><tr><th>Reading</th><th class="num">At start</th><th class="num">At end</th>
           <th class="num">Change</th><th>Remark</th></tr></thead>
           <tbody>${deltas}</tbody>
         </table>`
      : ''
  }
</section>
${renderQualityGate(report, audience)}
${renderBottleneck(report)}
${renderSubsystemCheck(report)}
${renderDiagnostics(report, audience)}
${renderMemoryTimeline(report, audience)}
${audience === 'lead' ? '' : renderSpikes(report, audience)}
${renderMemoryGrowth(report)}
${/*
   * Last, and deliberately so: the timeline is a cross-reference, not an
   * introduction. It is only useful once a reader has seen the frame-rate and
   * memory sections it stitches together - put first, it would ask them to
   * read a table of letters that mean nothing yet.
   */ ''}
${renderEventTimeline(report)}`;
}

// ---------------------------------------------------------------------------
// Performance: the build check, the bottleneck, the subsystems, the diagnoses
//
// The same content the Markdown cut renders, from the same decisions in
// `performance.ts`. Two renderers each deciding for themselves when 62% GPU
// utilisation is worth flagging would eventually disagree, and two documents
// from one report disagreeing about a number is the one failure a report cannot
// survive.
// ---------------------------------------------------------------------------

/** Map a subsystem or gate status onto the remark pills the stylesheet defines. */
function statusPill(status: string, label: string): string {
  const tone =
    status === 'pass' || status === 'ok'
      ? 'r-good'
      : status === 'warn' || status === 'watch'
        ? 'r-watch'
        : status === 'fail' || status === 'problem'
          ? 'r-bad'
          : 'r-flat';
  return `<span class="remark ${tone}">${esc(label)}</span>`;
}

/** A two- or three-column label/value table from `performance.ts` rows. */
function perfRowsTable(rows: PerfRow[]): string {
  if (rows.length === 0) return '';
  const hasNotes = rows.some((r) => r.note && r.note.length > 0);

  const body = rows
    .map(
      (r) =>
        `<tr><td>${esc(r.label)}</td><td class="num"><strong>${esc(r.value)}</strong></td>` +
        (hasNotes ? `<td class="sub">${esc(r.note ?? '')}</td>` : '') +
        '</tr>',
    )
    .join('');

  return `<table class="data">${body}</table>`;
}

/**
 * The CI gate.
 *
 * Right after the summary block, because "did this build pass?" is the question
 * a reader opens with and it answers in one word. Skipped checks are listed
 * rather than hidden: a green gate with four skipped checks is not a green
 * build, and a reader who cannot see the gaps will read it as one.
 */
function renderQualityGate(report: AnalysisReport, audience: ReportAudience): string {
  const gate = report.qualityGate;
  if (!gate) return '';

  const headline =
    gate.status === 'fail'
      ? `${gate.summary.failed} check${gate.summary.failed === 1 ? '' : 's'} failed against the ` +
        'thresholds for this device class. A build pipeline wired to this gate would stop here.'
      : gate.status === 'warn'
        ? `Nothing failed outright, but ${gate.summary.warned} check` +
          `${gate.summary.warned === 1 ? ' is' : 's are'} within measurement noise of its threshold.`
        : 'Every check that could be measured passed the thresholds for this device class.';

  const devices = gate.devices
    .map((device) => {
      const checks =
        audience === 'lead'
          ? device.checks.filter((c) => c.status === 'fail' || c.status === 'warn')
          : device.checks;

      const rows = checks
        .map((check) => {
          const limit =
            check.threshold === null
              ? '—'
              : `${check.direction === 'at-least' ? '≥' : '≤'} ${gateValue(check.threshold, check.unit)}`;
          return (
            '<tr>' +
            `<td>${statusPill(check.status, check.status)}</td>` +
            `<td>${esc(check.label)}</td>` +
            `<td class="num">${check.value === null ? 'not measured' : esc(gateValue(check.value, check.unit))}</td>` +
            `<td class="num">${esc(limit)}</td>` +
            `<td class="sub">${esc(check.message)}</td>` +
            '</tr>'
          );
        })
        .join('');

      return (
        `<h3>${esc(device.model)} — ${esc(device.tier)}</h3>` +
        (rows
          ? `<table class="data"><thead><tr><th></th><th>Check</th><th class="num">Measured</th>
             <th class="num">Limit</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table>`
          : '<p class="note">All checks passed.</p>')
      );
    })
    .join('');

  return `<section class="block gate gate-${esc(gate.status)}">
  <h2>Build check: ${esc(gate.status.toUpperCase())}</h2>
  <p class="note">${esc(headline)}</p>
  ${devices}
  <p class="caption">Machine-readable at <code>quality-gate.json</code>: <code>status</code> is
  <code>pass</code>, <code>warn</code> or <code>fail</code>, and <code>exitCode</code> is non-zero
  on failure, so a pipeline step can gate on one field. A check that could not be measured is
  reported as skipped and never as a pass.</p>
</section>`;
}

function gateValue(value: number, unit: string): string {
  if (unit === 'bytes') return fmt(value);
  if (unit === '°C') return `${value} °C`;
  return `${value.toLocaleString()} ${unit}`;
}

/**
 * What was holding the frame up.
 *
 * The most actionable sentence the tool produces, so it leads the performance
 * material. The basis line under it is not decoration: a verdict from the
 * engine's own per-frame timings and one inferred from five-second CPU samples
 * deserve different amounts of trust.
 */
function renderBottleneck(report: AnalysisReport): string {
  const blocks = report.devices
    .map((device) => {
      const statement = bottleneckStatement(device);
      if (!statement) return '';
      if (device.bottleneck?.kind === 'unknown' && device.bottleneck.contributors.length === 0) {
        return '';
      }

      const rows = frameBudgetRows(device);
      const stages = rows.filter((r) => r.label.startsWith('—'));
      const fillRate = fillRateNote(device);
      const contributors = device.bottleneck?.contributors ?? [];

      return `<section class="block limit">
  <h2>What is slowing it down?</h2>
  ${report.devices.length > 1 ? `<div class="device-context">${esc(device.manufacturer)} ${esc(device.model)} — device ${esc(device.role)}</div>` : ''}
  <p class="limit-head">${esc(statement.headline)}</p>
  <p class="note">${esc(statement.reason)}</p>
  ${perfRowsTable(rows)}
  ${
    stages.length > 1
      ? `<p class="caption">These three do not add up to the frame time: the render thread and the
         GPU work on the previous frame while the main thread works on the current one, so a frame
         costs about the longest of the three.</p>`
      : ''
  }
  ${fillRate ? `<p class="note">${esc(fillRate)}</p>` : ''}
  ${
    contributors.length > 0
      ? `<ul class="note">${contributors.map((c) => `<li>${esc(c.note)}</li>`).join('')}</ul>`
      : ''
  }
  <p class="caption">${esc(statement.basis)}</p>
</section>`;
    })
    .join('');

  return blocks;
}

/**
 * One row per subsystem, with the figure and whether it is a problem.
 *
 * The table a reader scans to decide which section to open. Rows that could not
 * be measured stay in it and say so - dropping them would make a run that
 * measured two subsystems look like a run where three were fine.
 */
function renderSubsystemCheck(report: AnalysisReport): string {
  return report.devices
    .map((device) => {
      const rows = subsystemRows(device);
      if (rows.length === 0) return '';

      /*
       * The verdict is the last column, not the first.
       *
       * Every other table in this report puts its remark on the right - the
       * reader takes the figures in first and meets the judgement at the end of
       * the row. This table used to open with an unlabelled pill, which both
       * broke that habit and left a column with no heading over it.
       */
      const body = rows
        .map(
          (row) =>
            '<tr>' +
            `<td><strong>${esc(row.subsystem)}</strong></td>` +
            `<td>${esc(row.headline)}</td>` +
            `<td class="sub">${esc(row.detail)}</td>` +
            `<td class="remark-cell">${statusPill(row.status, STATUS_LABEL[row.status])}</td>` +
            '</tr>',
        )
        .join('');

      const unmeasured = rows.filter((r) => r.status === 'unmeasured').length;

      return `<section class="block">
  <h2>Subsystem check</h2>
  ${report.devices.length > 1 ? `<div class="device-context">${esc(device.manufacturer)} ${esc(device.model)} — device ${esc(device.role)}</div>` : ''}
  <table class="data ruled"><thead><tr><th>Subsystem</th><th>Measured</th>
  <th>Against what</th><th>Remark</th></tr></thead><tbody>${body}</tbody></table>
  ${
    unmeasured > 0
      ? `<p class="caption">${unmeasured} of ${rows.length} subsystems could not be measured on
         this run, so this table is not a clean bill of health for them. The reasons are under
         &ldquo;against what&rdquo;.</p>`
      : ''
  }
</section>`;
    })
    .join('');
}

/**
 * Why frames dropped, moment by moment.
 *
 * The payoff of measuring five subsystems on one clock. The wording stays at
 * "coincided with" rather than "caused by", because that is all a correlation
 * across subsystems can support.
 */
function renderDiagnostics(report: AnalysisReport, audience: ReportAudience): string {
  const diagnoses = report.diagnostics ?? [];
  if (diagnoses.length === 0) return '';

  /*
   * The summary cut never reaches here: `renderPrintableHtml` sends `lead` to
   * `renderSnapshotHtml`, which is a different document rather than a filtered
   * one. This used to slice the list for a lead, which was unreachable code
   * describing behaviour the summary does not have.
   */
  void audience;

  const entries = diagnoses
    .map((d) => {
      const level = (d.level as ConfidenceLevel | undefined) ?? 'insufficient';
      const seconds = d.durationMs ? Math.max(1, Math.round(d.durationMs / 1000)) : null;

      /*
       * The figures before the prose.
       *
       * The event's shape - what it fell from, to, for how long - is what makes
       * the paragraph underneath judgeable, so it is set as a small table
       * rather than buried in the sentence.
       */
      const facts: Array<[string, string]> = [];
      facts.push([
        'Frame rate',
        d.beforeFps != null && d.lowestFps != null
          ? `${d.beforeFps} → ${d.lowestFps} fps` +
            (d.afterFps != null ? `, recovered to ${d.afterFps}` : '')
          : `${d.fps} fps at the worst point`,
      ]);
      if (d.changePercent != null && d.changePercent !== 0) {
        facts.push([
          'Drop',
          `${Math.abs(d.changePercent).toFixed(0)}% against ${d.basis ?? 'the session median'}`,
        ]);
      }
      if (seconds != null) facts.push(['Duration', `${(d.durationMs! / 1000).toFixed(1)} s`]);
      if (d.janks > 0) facts.push(['Stutter', `${d.janks} jank(s) inside the event`]);

      const factRows = facts
        .map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`)
        .join('');

      const causes =
        d.causes.length > 0
          ? `<table class="data compact"><thead><tr><th>Subsystem</th>
             <th>What it was doing</th></tr></thead><tbody>${d.causes
               .map(
                 (c) =>
                   `<tr><td>${esc(SUBSYSTEM_TITLE[c.subsystem] ?? c.subsystem)}</td>` +
                   `<td>${esc(c.statement)}</td></tr>`,
               )
               .join('')}</tbody></table>`
          : `<p class="note">Nothing else moved in the same window. The drop is real and measured;
             what caused it is not in this data.</p>`;

      return `<article class="diag sev-${esc(d.severity)}" id="${esc(d.id)}">
  <h3>${d.letter ? `<span class="diag-letter">${esc(d.letter)}</span>` : ''}${esc(formatClock(d.atMs))}
  · <span class="chip sev-${esc(d.severity)}">${esc(d.severity)}</span>
  · ${remark(CONFIDENCE_LABEL[level], CONFIDENCE_TONE[level])}${
    report.devices.length > 1 ? ` · device ${esc(d.role)}` : ''
  }${d.nearestMarker ? ` — during “${esc(d.nearestMarker)}”` : ''}</h3>
  <table class="data compact facts"><tbody>${factRows}</tbody></table>
  <h4>What changed at this moment</h4>
  ${causes}
  <p><strong>Why this conclusion.</strong> ${esc(d.conclusion)}</p>
  <p class="note"><strong>What to investigate.</strong> ${esc(d.recommendation)}</p>
</article>`;
    })
    .join('');

  return `<section class="block">
  <h2>FPS spike details</h2>
  <p class="note">One entry per lettered moment on the frame-rate chart, with what every other
  subsystem was doing at the same instant. These are coincidences in the data, ranked by how well
  they line up — the tool does not claim to have proved causation, and says so where the evidence
  is thin.</p>
  ${entries}
</section>`;
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

/** A cell in the event table, toned so a column can be scanned. */
function eventCell(cell: EventCell): string {
  const tone =
    cell.state === 'up' ? 'up' : cell.state === 'down' ? 'down' : cell.state === 'normal' ? 'flat' : 'muted';
  return `<td class="num ${tone}">${esc(cell.text)}</td>`;
}

/**
 * Everything that happened, in the order it happened.
 *
 * The one view that makes a frame drop and a memory jump in the same second
 * legible as one event rather than two bugs. Severity-sorted lists cannot do
 * that, which is why this sits alongside them rather than replacing them.
 */
function renderEventTimeline(report: AnalysisReport): string {
  const rows = buildAllEventTimelines(report);
  if (rows.length === 0) return '';

  const multi = report.devices.length > 1;
  const body = rows
    .map((r) => {
      const level = r.confidence;
      return `<tr>
    <td class="num">${r.letter ? `<span class="diag-letter">${esc(r.letter)}</span>` : ''}${esc(r.clock)}</td>
    <td>${esc(r.event)}${multi ? ` <span class="muted">(${esc(r.role)})</span>` : ''}</td>
    ${eventCell(r.fps)}${eventCell(r.memory)}${eventCell(r.cpu)}${eventCell(r.gpu)}
    <td>${esc(r.culprit)}</td>
    <td>${level ? remark(CONFIDENCE_LABEL[level], CONFIDENCE_TONE[level]) : '<span class="muted">—</span>'}</td>
  </tr>`;
    })
    .join('');

  // The ladder, explained once, where its words are first used in anger.
  const used = new Set(rows.map((r) => r.confidence).filter(Boolean) as ConfidenceLevel[]);
  const ladder =
    used.size === 0
      ? ''
      : `<h4>How to read “how sure”</h4>
  <table class="data compact"><tbody>${(
    ['confirmed', 'high', 'medium', 'possible', 'insufficient'] as const
  )
    .filter((l) => used.has(l))
    .map(
      (l) =>
        `<tr><td>${remark(CONFIDENCE_LABEL[l], CONFIDENCE_TONE[l])}</td>` +
        `<td>${esc(CONFIDENCE_MEANING[l])}</td></tr>`,
    )
    .join('')}</tbody></table>`;

  return `<section class="block">
  <h2>Performance event timeline</h2>
  <p class="note">Every significant moment in time order, so a frame drop and a memory jump at the
  same second read as one event rather than two. Letters match the badges on the charts and the
  detail sections above.</p>
  <div class="scroll-x">
  <table class="data bordered">
    <thead><tr><th>Time</th><th>Event</th><th class="num">Frame rate</th><th class="num">Memory</th>
    <th class="num">CPU</th><th class="num">GPU</th><th>Most likely</th><th>How sure</th></tr></thead>
    <tbody>${body}</tbody>
  </table>
  </div>
  <p class="caption">A dash means the metric was not measured at that moment, which is a different
  thing from it being normal.</p>
  ${ladder}
</section>`;
}

/**
 * Whether memory was given back.
 *
 * Separate from the spike table because it answers a question no single jump
 * can: a 300 MB rise that returned to baseline is a level load, and the same
 * rise that stayed is the shape of a retention bug. The two need opposite
 * responses, so leaving a reader to infer which they have is the one thing this
 * section exists to prevent.
 */
function renderMemoryGrowth(report: AnalysisReport): string {
  const shown = report.devices.filter(
    (d) => d.memoryGrowth && d.memoryGrowth.verdict !== 'insufficient',
  );
  if (shown.length === 0) return '';

  const blocks = shown
    .map((device) => {
      const g = device.memoryGrowth!;
      const retained = g.verdict === 'retained';
      const title = retained
        ? 'Memory was retained'
        : g.verdict === 'released'
          ? 'Memory was released again'
          : 'Memory stayed level';

      const rows: Array<[string, string]> = retained
        ? [
            ['Held at the end', `${fmtPrecise(g.retainedBytes)} above where it started`],
            ['Climb', `${fmtPrecise(g.bytesPerMinute)} per minute`],
            ['Of what it gained', `${Math.round(g.heldAtEndFraction * 100)}% never returned`],
            ...(g.floorRoseBytes > 0
              ? ([['Quiet moments rose', fmtPrecise(g.floorRoseBytes)]] as Array<[string, string]>)
              : []),
          ]
        : [];

      const table =
        rows.length === 0
          ? ''
          : `<table class="data compact facts"><tbody>${rows
              .map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`)
              .join('')}</tbody></table>`;

      const level = confidenceLevel(g.confidence);

      return `<article class="diag ${retained ? 'sev-high' : ''}">
  <h3>${esc(title)} ${remark(CONFIDENCE_LABEL[level], retained ? 'bad' : CONFIDENCE_TONE[level])}${
    report.devices.length > 1 ? ` · ${esc(device.manufacturer)} ${esc(device.model)}` : ''
  }</h3>
  <p>${esc(g.summary)}</p>
  ${table}
  ${g.recommendation ? `<p class="note"><strong>What to investigate.</strong> ${esc(g.recommendation)}</p>` : ''}
</article>`;
    })
    .join('');

  return `<section class="block">
  <h2>Did memory come back down?</h2>
  ${blocks}
</section>`;
}

/**
 * The subsystem figures behind the summary's one-row-per-subsystem table.
 *
 * Complete cut only. A lead reading a page-cache hit rate next to a draw-call
 * count learns nothing they can act on, and the summary already gave them the
 * verdict.
 */
function renderSubsystemDetail(report: AnalysisReport): string {
  return report.devices
    .map((device) => {
      const groups: Array<[string, PerfRow[], string]> = [
        [
          'GPU and rendering',
          [...gpuDetailRows(device), ...renderDetailRows(device)],
          'GPU load comes from vendor sysfs; the per-frame counts come from the engine, because ' +
            'nothing outside the process can see them.',
        ],
        [
          'CPU and threading',
          cpuDetailRows(device),
          'A thread’s figure is a percentage of one core: a game’s main thread cannot spread ' +
            'across cores, so 100% is saturated no matter how much silicon is idle elsewhere.',
        ],
        [
          'Storage',
          storageDetailRows(device),
          'The gap between what the app read and what reached the flash is the page cache doing ' +
            'its job — a large read that never touched storage cost almost nothing.',
        ],
        ['Audio', audioDetailRows(device), ''],
      ].filter(([, rows]) => (rows as PerfRow[]).length > 0) as Array<[string, PerfRow[], string]>;

      const cpu = device.cpu;
      const io = device.io;

      const clusters =
        cpu && cpu.clusters.length > 0
          ? `<h3>CPU clusters</h3>
             <table class="data"><thead><tr><th>Cluster</th><th class="num">Cores</th>
             <th class="num">Average load</th><th class="num">Peak load</th>
             <th class="num">Average clock</th><th class="num">At its ceiling</th></tr></thead>
             <tbody>${cpu.clusters
               .map(
                 (c) =>
                   `<tr><td>${esc(c.cluster)}</td><td class="num">${c.coreCount}</td>` +
                   `<td class="num">${c.averageUsagePercent ?? '—'}%</td>` +
                   `<td class="num">${c.peakUsagePercent ?? '—'}%</td>` +
                   `<td class="num">${c.averageFreqMhz ?? '—'} MHz</td>` +
                   `<td class="num">${c.clockPinnedPercent ?? '—'}%</td></tr>`,
               )
               .join('')}</tbody></table>
             <p class="caption">Clusters are grouped by each core’s maximum frequency, which is how
             big.LITTLE is detectable without a vendor table — cores that share a ceiling share a
             cluster.</p>`
          : '';

      const threads =
        cpu && cpu.threads.length > 0
          ? `<h3>Busiest threads</h3>
             <table class="data"><thead><tr><th>Thread</th><th>What it is</th>
             <th class="num">Average</th><th class="num">Peak</th><th class="num">Saturated</th>
             <th>Ran on</th></tr></thead>
             <tbody>${cpu.threads
               .map(
                 (t) =>
                   `<tr><td><code>${esc(t.name)}</code></td>` +
                   `<td>${esc(THREAD_ROLE_LABEL[t.role] ?? t.role)}</td>` +
                   `<td class="num">${t.averageCpuPercent}%</td>` +
                   `<td class="num">${t.peakCpuPercent}%</td>` +
                   `<td class="num">${t.saturatedSamplePercent}%</td>` +
                   `<td>${esc(t.dominantCluster ?? '—')}${
                     t.clusterConsistencyPercent !== null ? ` (${t.clusterConsistencyPercent}%)` : ''
                   }</td></tr>`,
               )
               .join('')}</tbody></table>
             <p class="caption">Percentages are of one core. “Saturated” is the share of samples
             above 85%, where a thread has effectively run out of time. Thread names are truncated
             to 15 characters by the kernel, which is why the render thread reads
             <code>UnityGfxDeviceW</code>.</p>`
          : '';

      const bursts =
        io && io.bursts.length > 0
          ? `<h3>Heaviest reads</h3>
             <table class="data"><thead><tr><th class="num">At</th><th class="num">Read rate</th>
             <th class="num">From flash</th><th class="num">Frame rate then</th>
             <th class="num">Stutter</th><th>During</th></tr></thead>
             <tbody>${io.bursts
               .map(
                 (b) =>
                   `<tr><td class="num">${esc(formatClock(b.elapsedMs))}</td>` +
                   `<td class="num">${(b.readBytesPerSecond / MB).toFixed(1)} MB/s</td>` +
                   `<td class="num">${
                     b.storageReadBytesPerSecond !== null
                       ? `${(b.storageReadBytesPerSecond / MB).toFixed(1)} MB/s`
                       : '—'
                   }</td>` +
                   `<td class="num">${b.fps !== null ? `${b.fps} fps` : '—'}</td>` +
                   `<td class="num">${b.janks ?? '—'}</td>` +
                   `<td>${esc(b.nearestMarker ?? '—')}</td></tr>`,
               )
               .join('')}</tbody></table>`
          : '';

      if (groups.length === 0 && !clusters && !threads && !bursts) return '';

      return `<section class="block">
  <h2>Subsystem detail</h2>
  ${report.devices.length > 1 ? `<div class="device-context">${esc(device.manufacturer)} ${esc(device.model)} — device ${esc(device.role)}</div>` : ''}
  ${groups
    .map(
      ([title, rows, note]) =>
        `<h3>${esc(title)}</h3>${perfRowsTable(rows)}${note ? `<p class="caption">${esc(note)}</p>` : ''}`,
    )
    .join('')}
  ${clusters}
  ${threads}
  ${bursts}
</section>`;
    })
    .join('');
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
function renderTierTable(report: AnalysisReport): string {
  if (!report.devices.some((d) => d.tier)) return '';

  const rows = tierTable()
    .map(
      (row) =>
        `<tr><td>${esc(row.label)}</td><td class="num">≥ ${row.minMedianFps} fps</td>` +
        `<td class="num">≤ ${row.maxJanksPerMinute}/min</td>` +
        `<td class="num">≤ ${row.maxThermalRiseC} °C</td>` +
        `<td class="num">≤ ${row.maxDrawCalls.toLocaleString()}</td>` +
        `<td class="num">≤ ${row.maxTriangles.toLocaleString()}</td>` +
        `<td class="num">≤ ${row.maxUnderrunsPerMinute}/min</td></tr>`,
    )
    .join('');

  return `<section class="block">
  <h2>Performance thresholds per device class</h2>
  <p class="note">What “acceptable” means, by hardware class. A build is graded against the row its
  device lands in, because 45 fps is a good result on a budget handset and a bug on a flagship.
  Devices are tiered on RAM and on the fastest core’s clock; the frame-rate floor is also capped
  against the panel’s refresh rate, so a 120 Hz screen is not graded as though 60 were its
  ceiling.</p>
  <table class="data bordered"><thead><tr><th>Class</th><th class="num">Median frame rate</th>
  <th class="num">Stutter</th><th class="num">Temperature rise</th><th class="num">Draw calls</th>
  <th class="num">Triangles</th><th class="num">Audio dropouts</th></tr></thead>
  <tbody>${rows}</tbody></table>
  <p class="caption">Draw-call and triangle ceilings are “unusual for the class” rather than hard
  budgets — a 2D game with 40 draw calls and a stylised 3D game with 900 can both be correct. They
  earn their place because a build that jumps from 300 to 1,900 between releases has regressed
  whatever the absolute is. The memory ceiling comes from the RAM tier table, so the two never
  disagree.</p>
</section>`;
}

function statCell(label: string, value: string, note: string, tone = ''): string {
  return `<div class="cell ${tone}">
    <div class="label">${esc(label)}</div>
    <div class="value">${value}</div>
    <div class="note">${esc(note)}</div>
  </div>`;
}

/**
 * A card holding two figures of equal weight.
 *
 * Used where neither number is the subordinate one: median and average frame
 * rate answer different questions, and setting one in small type beneath the
 * other implies it matters less than it does.
 */
function pairCell(
  label: string,
  values: Array<{ value: string; label: string }>,
  unit: string,
  note: string,
): string {
  const pairs = values
    .map(
      (v) =>
        `<div class="pair"><div class="value">${esc(v.value)}</div>` +
        `<div class="pair-label">${esc(v.label)}</div></div>`,
    )
    .join('');

  return `<div class="cell">
    <div class="label">${esc(label)} <span class="unit-inline">(${esc(unit)})</span></div>
    <div class="pairs">${pairs}</div>
    <div class="note">${esc(note)}</div>
  </div>`;
}

/** Map a rating onto the card tones the print stylesheet already defines. */
function rateTone(rating: string): string {
  if (rating === 'excellent' || rating === 'good') return 'ok';
  if (rating === 'fair') return 'warn';
  if (rating === 'poor') return 'bad';
  return '';
}

/**
 * Frame rate over time.
 *
 * Placed with the memory curve on purpose: a stutter that lines up with a memory
 * spike is one event with two symptoms, and seeing both on one page is the whole
 * reason this tool measures them together.
 */
function renderFpsChart(report: AnalysisReport): string {
  const charts = report.devices
    .map((d) => {
      const series = d.fpsSeries ?? [];
      if (series.length < 2) return '';

      const svg = renderFpsChartSvg({
        points: series,
        displayHz: d.fps?.displayHz ?? null,
        // The same letters the detail section and the event table use, badged
        // on the curve, so "look at B" resolves in one glance.
        events: (d.fpsEvents ?? []).map((e) => ({
          elapsedMs: e.atMs,
          letter: e.letter,
          kind: e.kind,
        })),
        forPrint: true,
      });
      if (!svg) return '';

      return (
        (report.devices.length > 1 ? `<h3>Device ${esc(d.role)} — ${esc(d.model)}</h3>` : '') +
        `<div class="chart">${svg}</div>`
      );
    })
    .join('');

  if (!charts) return '';

  /*
   * Chart and caption only - no section wrapper and no heading of its own.
   *
   * This used to be a top-level section. Now that it sits inside "Frame rate"
   * it would nest a section in a section and print two headings one after the
   * other, which is how a reader ends up thinking there are two charts. The
   * caption also no longer points "below" at the memory curve: that lives in the
   * summary cut now, not underneath this.
   */
  return `<h3>Over the session</h3>
  ${charts}
  <p class="caption">Frames per second, measured from the compositor; the dashed line is what the
  hardware allows. Red marks are stutter &mdash; check one against the memory timeline in the
  summary, because a stall that lines up with a memory jump is one event and not two.</p>`;
}

/**
 * A start-against-end row, to two decimals.
 *
 * One decimal was hiding the rows this table exists for. A three-minute session
 * moves the battery by a fraction of a percent and the temperature by tenths;
 * rounding those to 0.0 renders them as "no change", which is a different claim
 * from "changed by less than we print". Two decimals resolve a 0.01 step, and
 * the trailing zeros are worth the noise because they say the measurement was
 * taken rather than skipped.
 */
function deltaRow(
  label: string,
  start: number | null,
  end: number | null,
  unit: string,
  remark = '',
  decimals = 2,
): string {
  if (start === null || end === null) return '';
  const change = end - start;
  const tone = change === 0 ? 'flat' : change > 0 ? 'up' : 'down';
  const n = (v: number) => v.toFixed(decimals);
  const changed =
    Math.abs(change) < 0.5 / 10 ** decimals
      ? 'no change'
      : `${change > 0 ? '+' : ''}${n(change)}${unit}`;
  return `<tr><td>${esc(label)}</td><td class="num">${n(start)}${unit}</td>
    <td class="num">${n(end)}${unit}</td>
    <td class="num ${tone}">${changed}</td>
    <td>${remark}</td></tr>`;
}

/**
 * The same row for a byte figure.
 *
 * Memory held at the start against memory held at the end is the clearest
 * retention signal in the report, and it had nowhere to live before.
 */
function deltaRowBytes(
  label: string,
  start: number | null,
  end: number | null,
  remark = '',
): string {
  if (start === null || end === null) return '';
  const change = end - start;
  const tone = change === 0 ? 'flat' : change > 0 ? 'up' : 'down';
  return `<tr><td>${esc(label)}</td><td class="num">${fmtPrecise(start)}</td>
    <td class="num">${fmtPrecise(end)}</td>
    <td class="num ${tone}">${change === 0 ? 'no change' : `${change > 0 ? '+' : ''}${fmtPrecise(change)}`}</td>
    <td>${remark}</td></tr>`;
}

/**
 * A short verdict beside a number, set as a pill so it reads at a glance.
 *
 * These phrases were already in the report as plain grey captions under the
 * summary tiles, where a reader had to compare a figure against a budget
 * themselves to learn whether it was good. The judgement is the useful half,
 * so it is given the emphasis and a tone.
 */
function remark(text: string, tone: 'good' | 'watch' | 'bad' | 'flat' = 'flat'): string {
  if (!text) return '';
  return `<span class="remark r-${tone}">${esc(text)}</span>`;
}

/**
 * How a temperature rise over one session should be read.
 *
 * The tone has to answer to the verdict and not only to the rise. A phone that
 * started hot and stayed there rises by nothing, and judging on the rise alone
 * printed "got hot" in the green of a good result - two halves of one remark
 * disagreeing with each other.
 */
function heatRemark(riseC: number | null, verdict: string | null | undefined): string {
  const word = verdict ? (THERMAL_WORD[verdict] ?? '') : '';
  const byVerdict =
    verdict === 'throttling' ? 'bad' : verdict === 'hot' ? 'bad' : verdict === 'warm' ? 'watch' : null;
  if (riseC === null) return remark(word || 'not measured', byVerdict ?? 'flat');

  const byRise = riseC >= 8 ? 'bad' : riseC >= 4 ? 'watch' : 'good';
  // Whichever reads worse wins: a hot phone that did not get hotter is still hot.
  const rank = { good: 0, watch: 1, bad: 2, flat: 0 } as const;
  const tone = byVerdict && rank[byVerdict] > rank[byRise] ? byVerdict : byRise;

  return remark(
    word ? `${word} · rose ${riseC.toFixed(2)} °C` : `rose ${riseC.toFixed(2)} °C`,
    tone as 'good' | 'watch' | 'bad',
  );
}

/** Memory held at the end, against what one app should use on this phone. */
function budgetRemark(
  bytes: number | null,
  // Only the two thresholds, so this takes the report's budget shape as well
  // as the analysis one - they are not the same type.
  budget: { targetMaxBytes: number; hardLimitBytes: number } | null | undefined,
): string {
  if (bytes === null || !budget) return '';
  if (bytes > budget.hardLimitBytes) return remark('past the practical limit', 'bad');
  if (bytes > budget.targetMaxBytes) return remark('over target', 'watch');
  return remark('within budget', 'good');
}

const THERMAL_WORD: Record<string, string> = {
  cool: 'stayed cool',
  warm: 'warmed up',
  hot: 'got hot',
  throttling: 'throttled - the device limited its own performance',
  unknown: 'not measured',
};



function renderVerdict(report: AnalysisReport, isLead: boolean): string {
  // The summary page already states the score, its meaning and the confidence.
  // Repeating that verbatim halfway down reads as a second assessment.
  if (isLead) return '';

  const v = report.verdict;
  const pct = Math.round(v.confidence.value * 100);


  // For a developer the breakdown *is* new: which part of the score came from
  // reading the project, and which from watching it run.
  return `
<section>
  <h2>How does the risk score break down?</h2>
  <table class="data bordered">
    <thead><tr><th>Score</th><th class="num">Value</th><th>Meaning</th></tr></thead>
    <tbody>
      <tr class="row-strong">
        <td>Combined OOM risk</td>
        <td class="num"><strong>${v.combinedRisk.value}/100</strong> <span class="chip band-${esc(v.combinedRisk.band)}">${esc(v.combinedRisk.band)}</span></td>
        <td>${esc(bandMeaning(v.combinedRisk.band))}</td>
      </tr>
      ${
        // Always 0 with no project, where it reads as a real score rather than
        // an absent one.
        FEATURES.projectAnalysis
          ? `<tr><td>Static risk</td><td class="num">${v.staticRisk.value}/100</td><td>Predicted from the project source and assets.</td></tr>`
          : ''
      }
      <tr><td>Live risk</td><td class="num">${v.liveRisk.value}/100</td><td>Measured on real devices during play.</td></tr>
      <tr><td>Evidence confidence</td><td class="num">${pct}%</td><td>How much of the intended evidence was actually collected.</td></tr>
    </tbody>
  </table>
</section>`;
}

function renderDevices(report: AnalysisReport, isLead: boolean): string {
  if (report.devices.length === 0) return '';

  if (isLead) {
    return `
<section>
  <h2>Device results</h2>
  <table class="data">
    <thead><tr><th>Device</th><th class="num">Peak</th><th class="num">Target</th><th class="num">Limit</th><th>Verdict</th></tr></thead>
    <tbody>
      ${report.devices
        .map(
          (d) => `<tr>
        <td>${esc(d.manufacturer)} ${esc(d.model)} <span class="dim">(${fmt(d.totalRamBytes)} RAM)</span></td>
        <td class="num">${orDash(d.peakBytes)}</td>
        <td class="num">${d.budget ? `&lt; ${fmt(d.budget.targetMaxBytes)}` : '—'}</td>
        <td class="num">${d.budget ? `~${fmt(d.budget.hardLimitBytes)}` : '—'}</td>
        <td>${d.budget ? verdictChip(d.budget.verdict) : '—'}${d.processDeaths > 0 ? ' <strong class="bad">crashed</strong>' : ''}</td>
      </tr>`,
        )
        .join('\n      ')}
    </tbody>
  </table>
</section>`;
  }

  return `
<section>
  <h2>Device results</h2>
  <p class="note">The lower-memory device (A) exposes practical OOM risk; the higher-memory device (B) separates genuine memory growth from device budget limits. Scores are deliberately not averaged.</p>
  <div class="scroll">
  <table class="data compact">
    <thead><tr><th>Role</th><th>Model</th><th class="num">RAM</th><th class="num">Peak</th><th class="num">% RAM</th><th class="num">Baseline</th><th class="num">Final</th><th class="num">Growth</th><th>Killed</th><th class="num">Risk</th></tr></thead>
    <tbody>
      ${report.devices
        .map(
          (d) => `<tr>
        <td><strong>${esc(d.role)}</strong></td>
        <td>${esc(d.manufacturer)} ${esc(d.model)} <span class="dim">Android ${esc(d.androidVersion)}</span></td>
        <td class="num">${fmt(d.totalRamBytes)}</td>
        <td class="num">${orDash(d.peakBytes)}</td>
        <td class="num">${d.peakRamFraction !== null ? `${(d.peakRamFraction * 100).toFixed(1)}%` : '—'}</td>
        <td class="num">${orDash(d.baselineBytes)}</td>
        <td class="num">${orDash(d.finalBytes)}</td>
        <td class="num">${d.growthBytesPerMinute !== null ? `${fmt(d.growthBytesPerMinute)}/min` : '—'}</td>
        <td>${d.processDeaths > 0 ? `<strong class="bad">yes (${d.processDeaths})</strong>` : 'no'}</td>
        <td class="num">${d.risk ? `${d.risk.value}/100` : '—'}</td>
      </tr>`,
        )
        .join('\n      ')}
    </tbody>
  </table>
  </div>
</section>`;
}

/** Lead: what is wrong, what it costs, what to do. No code, no paths. */
function renderLeadFindings(report: AnalysisReport): string {
  if (report.priority.length === 0) {
    return `<section><h2>What is wrong?</h2><p>No issues were found. Check the limitations below before treating this as a clean result.</p></section>`;
  }

  const top = report.priority.slice(0, 6);
  const more =
    report.priority.length > top.length
      ? `<p class="note">${report.priority.length - top.length} further issues of lower priority were also found.</p>`
      : '';

  return `
<section>
  <h2>What is wrong?</h2>
  ${renderDeviceContext(report)}
  ${top
    .map((item) => {
      const f = item.finding;
      const measured = f.source === 'live' || f.source === 'correlated';
      return `
  <article class="finding">
    <h3><span class="rank">${item.rank}</span>${esc(namedForDisplay(f.title, report))}</h3>
    <p class="tags">
      <span class="chip sev-${esc(f.severity)}">${esc(f.severity)} priority</span>
      ${f.estimatedBytes ? `<span class="chip">${fmt(f.estimatedBytes)} at stake</span>` : ''}
      ${measured ? '<span class="chip measured">measured on device</span>' : ''}
    </p>
    <p>${esc(firstSentences(f.description, 2))}</p>
    <p class="fix"><strong>What to do:</strong> ${esc(firstSentences(f.recommendation, 1))}</p>
  </article>`;
    })
    .join('\n')}
  ${more}
</section>`;
}

/** Developer / complete: full fixes with evidence locations. */
/**
 * The device a finding is about, named.
 *
 * Findings are written as "on Device A" because the analysis works in roles, and
 * a role letter means nothing to a reader. This states the phone, what it has,
 * what one app should use on it and what this build actually reached - so a
 * figure in a finding can be judged without hunting for the device table.
 */
function renderDeviceContext(report: AnalysisReport): string {
  const d = report.devices[0];
  if (!d) return '';

  const parts = [
    `<strong>${esc(d.manufacturer)} ${esc(d.model)}</strong>`,
    `${fmt(d.totalRamBytes)} of RAM`,
    d.budget ? `one app should stay under ${fmt(d.budget.targetMaxBytes)}` : '',
    d.peakBytes !== null ? `this build reached <strong>${fmt(d.peakBytes)}</strong>` : '',
  ].filter(Boolean);

  return `<p class="device-context">${parts.join(' &middot; ')}</p>`;
}

/** Replace the analysis's role letter with the phone's name, for display only. */
function namedForDisplay(title: string, report: AnalysisReport): string {
  return title.replace(/Device ([A-Z])\b/g, (whole, role: string) => {
    const device = report.devices.find((d) => d.role === role);
    return device ? `${device.manufacturer} ${device.model}` : whole;
  });
}

function renderDetailedFindings(report: AnalysisReport, isComplete: boolean): string {
  if (report.priority.length === 0) {
    return `<section><h2>What should we fix first?</h2><p>No findings were produced. See the limitations section before treating this as a clean result.</p></section>`;
  }

  const limit = isComplete ? report.priority.length : 15;
  const shown = report.priority.slice(0, limit);
  const more =
    report.priority.length > limit
      ? `<p class="note">${report.priority.length - limit} further findings of lower priority were also recorded.</p>`
      : '';

  return `
<section>
  <h2>What should we fix first?</h2>
  ${renderDeviceContext(report)}
  ${shown
    .map((item) =>
      renderDetailedFinding(
        item.rank,
        { ...item.finding, title: namedForDisplay(item.finding.title, report) },
        isComplete,
      ),
    )
    .join('\n')}
  ${more}
</section>`;
}

function renderDetailedFinding(rank: number, f: Finding, isComplete: boolean): string {
  const evidence = isComplete ? f.evidence : f.evidence.slice(0, 8);
  const hidden = f.evidence.length - evidence.length;

  return `
  <article class="finding">
    <h3><span class="rank">${rank}</span>${esc(f.title)}</h3>
    <p class="tags">
      <span class="chip sev-${esc(f.severity)}">${esc(f.severity)}</span>
      <span class="chip">${Math.round(f.confidence * 100)}% confidence</span>
      <span class="chip">${esc(sourceLabel(f.source))}</span>
      ${f.estimatedBytes ? `<span class="chip">est. ${fmt(f.estimatedBytes)}</span>` : ''}
    </p>
    <p>${esc(f.description)}</p>
    <p class="fix"><strong>Recommended fix:</strong> ${esc(f.recommendation)}</p>
    ${
      evidence.length
        ? `<div class="evidence">
      <div class="ev-head">Where to look</div>
      <ul>
        ${evidence
          .map((e) => {
            const loc = e.path ? `<code>${esc(e.path)}${e.line ? `:${e.line}` : ''}</code>` : '';
            const sep = loc && e.summary ? ' — ' : '';
            const excerpt = e.excerpt ? `<pre>${esc(e.excerpt)}</pre>` : '';
            return `<li>${loc}${sep}${esc(e.summary)}${excerpt}</li>`;
          })
          .join('\n        ')}
        ${hidden > 0 ? `<li class="dim">…and ${hidden} more occurrence(s)</li>` : ''}
      </ul>
    </div>`
        : ''
    }
  </article>`;
}

function renderSession(report: AnalysisReport, audience: ReportAudience): string {
  const sess = report.session;
  const isLead = audience === 'lead';

  if (!sess) {
    return `
<section>
  <h2>How was this tested?</h2>
  <p>${
    isLead
      ? 'This analysis read the Unity project and the APK only — the game was <strong>not run on a device</strong>. Everything above is a prediction from the source, not something that was observed.'
      : 'No live device session was captured. Every finding is a prediction from the project source and has not been confirmed on hardware.'
  }</p>
</section>`;
  }

  if (isLead) {
    const worst = [...sess.cycles]
      .filter((c) => c.recoveryDeltaBytes !== null)
      .sort((a, b) => (b.recoveryDeltaBytes ?? 0) - (a.recoveryDeltaBytes ?? 0))[0];

    const leak =
      worst && (worst.recoveryDeltaBytes ?? 0) > 0
        ? `<p>Each time the same flow was repeated, roughly <strong>${fmt(worst.recoveryDeltaBytes ?? 0)}</strong> of memory was not given back. Memory that is never released after returning to the same screen is the clearest sign of a leak, and it accumulates every time a player repeats that loop.</p>`
        : '';

    return `
<section>
  <h2>How was this tested?</h2>
  <p>The game was installed and played on ${report.devices.length} device(s) for ${formatDuration(sess.durationMs)}, with ${sess.markerCount} points marked during play.</p>
  ${leak}
</section>`;
  }

  const cycles = sess.cycles.length
    ? `
  <h3>Repeated flow analysis</h3>
  <p class="note">Recovery delta is the memory still held after returning to the state the cycle started from. A delta that repeats or grows is stronger evidence of retention than a high peak.</p>
  <table class="data">
    <thead><tr><th>Device</th><th>Cycle</th><th class="num">Start</th><th class="num">Peak</th><th class="num">Returned to</th><th class="num">Recovery delta</th></tr></thead>
    <tbody>
      ${sess.cycles
        .map(
          (c) => `<tr>
        <td>${esc(c.role)}</td><td>${esc(c.label)}</td>
        <td class="num">${orDash(c.startBytes)}</td>
        <td class="num">${orDash(c.peakBytes)}</td>
        <td class="num">${orDash(c.recoveredBytes)}</td>
        <td class="num">${signed(c.recoveryDeltaBytes)}</td>
      </tr>`,
        )
        .join('\n      ')}
    </tbody>
  </table>`
    : '';

  const screens = sess.screenVisits.length
    ? `
  <h3>Screen open / close behaviour</h3>
  <table class="data">
    <thead><tr><th>Device</th><th>Screen</th><th class="num">On open</th><th class="num">Peak</th><th class="num">After close</th><th class="num">Retained</th></tr></thead>
    <tbody>
      ${sess.screenVisits
        .map(
          (v) => `<tr>
        <td>${esc(v.role)}</td><td>${esc(v.screen)}</td>
        <td class="num">${orDash(v.openBytes)}</td>
        <td class="num">${orDash(v.peakBytes)}</td>
        <td class="num">${orDash(v.closedBytes)}</td>
        <td class="num">${signed(v.retainedBytes)}</td>
      </tr>`,
        )
        .join('\n      ')}
    </tbody>
  </table>`
    : '';

  const timeline =
    audience === 'complete' && sess.timeline.length
      ? (() => {
          const roles = Object.keys(sess.timeline[0]?.memoryByRole ?? {});
          return `
  <h3>Session timeline</h3>
  <div class="scroll">
  <table class="data compact">
    <thead><tr><th class="num">Time</th><th>Event</th>${roles.map((r) => `<th class="num">Device ${esc(r)}</th>`).join('')}</tr></thead>
    <tbody>
      ${sess.timeline
        .map(
          (row) => `<tr>
        <td class="num">${formatDuration(row.elapsedMs)}</td>
        <td>${esc(row.label)}</td>
        ${roles.map((r) => `<td class="num">${orDash(row.memoryByRole[r] ?? null)}</td>`).join('')}
      </tr>`,
        )
        .join('\n      ')}
    </tbody>
  </table>
  </div>`;
        })()
      : '';

  return `
<section>
  <h2>Session</h2>
  <p>Session <code>${esc(sess.sessionId)}</code> ran for ${formatDuration(sess.durationMs)} with ${sess.markerCount} operator marker(s).</p>
  ${cycles}
  ${screens}
  ${timeline}
</section>`;
}

/**
 * Heat and battery. Frame rate has its own section in the complete cut.
 *
 * Placed before the memory detail because they frame it: the same peak reached
 * on a throttling device and on a cool one are not the same result, and a reader
 * needs to know which they are looking at before they read the numbers.
 */
/**
 * The same measurements, under the field names the in-game recorder uses.
 *
 * The studio's build carries GDPerfTracker, which records the same quantities
 * from inside the engine and ships them to analytics. Two tools measuring one
 * build should be readable together, and they are not if one says
 * "worst 1% of frames" and the other says `fps_p01` for a different quantity
 * entirely. This table states which field each number answers to, and says
 * plainly which of the recorder's fields cannot be measured from outside the
 * process at all - guessing at those would be worse than leaving them blank.
 */
/**
 * Everything about frame rate, in one place, in the complete report only.
 *
 * It used to be spread across three places: two tiles in the summary strip, a
 * chart between the summary and the memory timeline, and the jank breakdown
 * inside runtime health. A reader who wanted the frame-rate story had to
 * assemble it from all three, and the summary page - which is a memory-risk
 * page - carried figures it never explained.
 */
function renderFrameRate(report: AnalysisReport, audience: ReportAudience): string {
  const d = report.devices[0];
  const fps = d?.fps;
  if (!fps || fps.totalFrames === null) return '';

  const session = report.session;
  const jankRating = rateJanks(fps.janks ?? 0, session?.durationMs ?? 0);
  const p = fps.percentiles ?? null;

  const headline = [
    fps.medianFps != null
      ? statCell('Median', `${fps.medianFps}<span class="unit">fps</span>`, 'the typical second')
      : '',
    fps.averageFps != null
      ? statCell('Average', `${fps.averageFps}<span class="unit">fps</span>`, 'frames over measured time')
      : '',
    fps.stabilityPercent != null
      ? statCell(
          'Stability',
          `${fps.stabilityPercent}<span class="unit">%</span>`,
          fps.stabilityPercent >= 80
            ? 'within ±20% of median · good'
            : fps.stabilityPercent >= 75
              ? 'within ±20% of median · stable'
              : 'within ±20% of median · inconsistent',
        )
      : '',
    fps.janks != null
      ? statCell(
          'Stutter',
          `${fps.janks}<span class="unit">janks</span>`,
          `${RATING_LABEL[jankRating]}` +
            (fps.janksPerMinute != null ? ` · ${fps.janksPerMinute}/min` : ''),
          rateTone(jankRating),
        )
      : '',
    fps.longestFrameMs != null
      ? statCell(
          'Worst frame',
          `${fps.longestFrameMs}<span class="unit">ms</span>`,
          fps.longestFrameMs >= 500 ? 'a visible freeze' : 'longest single frame',
          fps.longestFrameMs >= 500 ? 'bad' : fps.longestFrameMs >= 125 ? 'watch' : 'good',
        )
      : '',
  ]
    .filter(Boolean)
    .join('');

  /* The ladder is the honest way to read a frame rate: an average of 58 with a
   * p05 of 20 is a game that stutters often, and the average alone hides it. */
  const ladder = p
    ? `<h3>How the seconds were distributed</h3>
    <table class="bordered">
      <thead><tr><th>Percentile</th><th class="num">fps</th><th>What it says</th><th>Remark</th></tr></thead>
      <tbody>
        ${percentileRow('p01', p.p01, 'the player&rsquo;s worst moments', p, fps)}
        ${percentileRow('p05', p.p05, 'whether drops are frequent', p, fps)}
        ${percentileRow('p25', p.p25, 'the bad quarter', p, fps)}
        ${percentileRow('p50', p.p50, 'the typical second', p, fps)}
        ${percentileRow('p75', p.p75, 'the good three-quarters', p, fps)}
        ${percentileRow('p95', p.p95, 'near-best', p, fps)}
        ${percentileRow('p99', p.p99, 'best sustained', p, fps)}
      </tbody>
    </table>
    <p class="caption">Percentiles are over one-second samples, so each value is a second the game
    actually ran. Read them against the cap the build asked for, not against 60.</p>`
    : '';

  const stutter =
    fps.janks !== null
      ? `<h3>Stutter in detail</h3>
    <table class="bordered">
      <thead><tr><th>Kind</th><th class="num">Count</th><th>Meaning</th><th>Remark</th></tr></thead>
      <tbody>
        <tr><td>Missed a refresh</td><td class="num">${fps.smallJanks ?? '&mdash;'}</td>
          <td>Frame took longer than 1.5 screen refreshes</td>
          <td>${remark('expected below the cap', 'flat')}</td></tr>
        <tr><td>Janks (cross-tool estimate)</td><td class="num">${
          fps.crossToolJanks != null ? `~${fps.crossToolJanks}` : '&mdash;'
        }</td>
          <td>Frame over twice the typical interval &mdash; what GameBench-style counters report</td>
          <td>${remark('for comparing against other tools; see the method note', 'flat')}</td></tr>
        <tr><td>Jank</td><td class="num">${fps.janks}</td>
          <td>Frame over 83 ms &mdash; noticeable</td>
          <td>${remark(
            `${RATING_LABEL[jankRating]}${fps.janksPerMinute != null ? ` · ${fps.janksPerMinute}/min` : ''}`,
            rateTone(jankRating) === 'good' ? 'good' : rateTone(jankRating) === 'bad' ? 'bad' : 'watch',
          )}</td></tr>
        <tr><td>Severe jank</td><td class="num">${fps.bigJanks ?? '&mdash;'}</td>
          <td>Frame over 125 ms &mdash; a visible hitch</td>
          <td>${
            fps.bigJanks === 0
              ? remark('none', 'good')
              : remark(`${fps.bigJanks} visible hitch(es)`, 'bad')
          }</td></tr>
      </tbody>
    </table>`
      : '';

  return `<section class="block">
  <h2>Frame rate</h2>
  <div class="strip">${headline}</div>
  ${renderFpsChart(report)}
  ${ladder}
  ${stutter}
  ${renderTrackerFields(report)}
</section>`;
}

/** One rung of the ladder, with a remark judging it against the panel. */
function percentileRow(
  name: string,
  value: number,
  meaning: string,
  p: { p50: number },
  fps: { displayHz: number | null },
): string {
  // Judged against the panel, because the cap the build asked for is not
  // readable from outside the process. Stated as a share of the refresh rate so
  // the reader can re-judge it against their own target.
  const hz = fps.displayHz;
  const share = hz && hz > 0 ? value / hz : null;
  let note = '';
  if (share !== null) {
    const pct = Math.round(share * 100);
    note =
      share >= 0.95
        ? remark(`${pct}% of the panel`, 'good')
        : share >= 0.8
          ? remark(`${pct}% of the panel`, 'watch')
          : remark(`${pct}% of the panel`, 'bad');
  }
  const drop = value < p.p50 * 0.5 ? ` ${remark('less than half the median', 'bad')}` : '';
  return `<tr><td><code>${name}</code></td><td class="num">${value}</td>
    <td>${meaning}</td><td>${note}${drop}</td></tr>`;
}

function renderTrackerFields(report: AnalysisReport): string {
  const d = report.devices[0];
  if (!d?.fps) return '';

  const p = d.fps.percentiles ?? null;
  const mb = (bytes: number | null | undefined): string =>
    bytes === null || bytes === undefined ? '&mdash;' : `${Math.round(bytes / 1048576)}`;
  const n = (v: number | null | undefined): string =>
    v === null || v === undefined ? '&mdash;' : String(v);

  const rows: Array<[string, string, string]> = [
    ['fps_avg', n(d.fps.averageFps), 'Average over the session'],
    ['fps_min', n(d.fps.minFps), 'Worst single second'],
    ['fps_p01', p ? n(p.p01) : '&mdash;', 'The player&rsquo;s worst moments'],
    ['fps_p05', p ? n(p.p05) : '&mdash;', 'Far below p50 means drops are frequent'],
    ['fps_p25', p ? n(p.p25) : '&mdash;', 'The bad quarter of the session'],
    ['fps_p50', p ? n(p.p50) : n(d.fps.medianFps), 'The typical second'],
    ['fps_p75', p ? n(p.p75) : '&mdash;', 'The good three-quarters boundary'],
    ['fps_p95', p ? n(p.p95) : '&mdash;', 'At the cap means the device has headroom'],
    ['fps_p99', p ? n(p.p99) : '&mdash;', 'Far under the cap means it can never reach target'],
    ['worst_ms', n(d.fps.longestFrameMs), 'Slowest single frame'],
    ['ram_total', mb(d.totalRamBytes), 'MB of physical RAM'],
    ['mem_sys_peak', mb(d.peakBytes), 'MB, whole process as the OS sees it'],
    ['mem_sys_avg', mb(d.averageBytes), 'MB, mean over the session'],
    [
      'seconds',
      n(report.session?.durationMs ? Math.round(report.session.durationMs / 1000) : null),
      'Length of the recorded window',
    ],
    // Left blank rather than filled with the panel's refresh rate. `tier_fps` is
    // `Application.targetFrameRate`, which lives inside the process: the cap the
    // build asked for, not the rate the hardware allows. Substituting the panel
    // would make every percentile look correct against a target the build never
    // set - and a cap that is set but not applying is precisely the fault worth
    // catching.
    ['tier_fps', '&mdash;', 'The cap the build asked for &mdash; in-engine only'],
  ];

  const body = rows
    .map(
      ([field, value, meaning]) =>
        `<tr><td><code>${field}</code></td><td class="num">${value}</td>` +
        `<td>${meaning}</td></tr>`,
    )
    .join('');

  return `<h3>Read against the in-game recorder</h3>
  <table class="bordered">
    <thead><tr><th>Field</th><th class="num">Measured</th><th>What it means</th></tr></thead>
    <tbody>${body}</tbody>
  </table>
  <p class="caption">Field names match GDPerfTracker so a report and an analytics payload from the same
  build can be compared line by line. <strong>Two of the recorder&rsquo;s memory fields are missing here
  on purpose:</strong> <code>mem_alloc</code> and <code>mem_resv</code> are Unity&rsquo;s own counters,
  visible only from inside the process, and nothing measurable over adb stands in for them.
  <code>mem_sys</code> is the one the three share, and it is the figure Android&rsquo;s low-memory killer
  judges. <code>tier_fps</code> is blank for the same reason: it is the cap the build asked for, and
  only the build knows that &mdash; so every percentile above should be read against the cap you set,
  not against 60.</p>`;
}

function renderRuntimeHealth(report: AnalysisReport, audience: ReportAudience): string {
  const measured = report.devices.filter((d) => d.fps || d.thermal || d.battery);
  if (measured.length === 0) return '';

  const isLead = audience === 'lead';

  const blocks = measured
    .map((d) => {
      const cards: string[] = [];

      // Frame rate is not carried here. The summary cut has no frame-rate
      // figures at all, and the complete cut gathers every one of them into its
      // own section - stating an average in both places invited the reader to
      // compare two numbers that were never in dispute.

      if (d.thermal) {
        const t = d.thermal;
        cards.push(
          statCard(
            'Device heat',
            t.peakC !== null ? `${t.peakC}<span class="unit">°C</span>` : '—',
            `${THERMAL_LABEL[t.verdict] ?? ''}` +
              (t.riseC !== null ? ` · rose ${t.riseC} °C during play` : ''),
            t.verdict === 'throttling' || t.verdict === 'hot' ? 'bad' : t.verdict === 'warm' ? 'warn' : 'ok',
          ),
        );
      }

      if (d.battery) {
        const b = d.battery;
        cards.push(
          statCard(
            'Battery used',
            b.drainPercent !== null ? `${b.drainPercent}<span class="unit">%</span>` : '—',
            b.drainPercent !== null
              ? (b.drainPercentPerHour !== null ? `${b.drainPercentPerHour}% per hour` : '') +
                (b.drainMah !== null ? ` · ${b.drainMah} mAh` : '')
              : 'Not measurable for this session.',
          ),
        );
      }

      const notes: string[] = [];

      // Start and end readings, which the stat cards above do not carry.
      const spans: string[] = [];
      if (d.thermal?.startC != null && d.thermal.endC != null) {
        spans.push(
          `<tr><td>Temperature</td><td class="num">${d.thermal.startC} °C</td>` +
            `<td class="num">${d.thermal.endC} °C</td>` +
            `<td class="num">${d.thermal.peakC ?? '—'} °C</td></tr>`,
        );
      }
      if (d.battery?.startPercent != null && d.battery.endPercent != null) {
        spans.push(
          `<tr><td>Battery charge</td><td class="num">${d.battery.startPercent}%</td>` +
            `<td class="num">${d.battery.endPercent}%</td><td class="num">—</td></tr>`,
        );
      }
      if (d.battery?.startTemperatureC != null && d.battery.endTemperatureC != null) {
        spans.push(
          `<tr><td>Battery temperature</td><td class="num">${d.battery.startTemperatureC} °C</td>` +
            `<td class="num">${d.battery.endTemperatureC} °C</td>` +
            `<td class="num">—</td></tr>`,
        );
      }
      if (spans.length > 0) {
        notes.push(
          '<h3>Start and end readings</h3>' +
            '<table class="bordered"><thead><tr><th>Reading</th><th class="num">At start</th>' +
            '<th class="num">At end</th><th class="num">Peak</th></tr></thead>' +
            `<tbody>${spans.join('')}</tbody></table>`,
        );
      }

      const fresh = d.freshStart;
      if (fresh) {
        notes.push('<h3>What the phone was doing beforehand</h3>');
        notes.push(
          '<p class="callout"><strong>The phone was cleared before this run.</strong> ' +
            (fresh.freedBytes !== null && fresh.freedBytes > 0
              ? `${fmt(fresh.freedBytes)} of memory was freed and `
              : '') +
            (fresh.stopped.length > 0
              ? `${fresh.stopped.length} background app(s) were closed`
              : 'no other app was holding memory') +
            (fresh.availableAfterBytes !== null
              ? `, leaving ${fmt(fresh.availableAfterBytes)} free at launch.`
              : '.') +
            ' The figures above are therefore what this build needs on a quiet phone. On a device ' +
            'with other apps resident it would have less room to work in.</p>',
        );
      } else {
        notes.push('<h3>What the phone was doing beforehand</h3>');
        notes.push(
          '<p class="note">The phone was not cleared before this run, so other apps were resident ' +
            'and holding memory. That is the realistic condition a player’s phone is in, but it ' +
            'means these figures depend partly on what else happened to be running.</p>',
        );
      }
      if (d.thermal?.verdict === 'throttling') {
        notes.push(
          '<p class="callout bad"><strong>The device limited its own performance during this ' +
            'session.</strong> Frame rate measured while throttling is lower than the game would ' +
            'achieve on a cool device — and memory held longer because frames take longer is a ' +
            'real effect, not a measurement artefact.</p>',
        );
      }
      if (d.battery?.unavailableReason) {
        notes.push('<h3>Why battery drain is not reported</h3>');
        notes.push(`<p class="note">${esc(d.battery.unavailableReason)}</p>`);
      }
      if (d.fps?.matchesDisplayRate === true && d.fps.displayHz !== null) {
        notes.push('<h3>The frame-rate cap is not applying</h3>');
        notes.push(
          '<p class="callout bad"><strong>The game is running at the screen’s refresh rate ' +
            `(${d.fps.displayHz} Hz), not at a frame rate of its own.</strong> If the project sets ` +
            'a frame-rate cap, that cap is not taking effect — in Unity, ' +
            '<code>Application.targetFrameRate</code> is ignored whenever ' +
            '<code>QualitySettings.vSyncCount</code> is anything other than zero, which it is by ' +
            'default in most quality levels. Rendering twice as many frames as intended costs ' +
            'battery, heat and GPU memory pressure for no visible benefit.</p>',
        );
      }

      if (d.fps?.janks != null) {
        notes.push(
          '<h3>Stutter in detail</h3>' +
            '<table class="bordered"><thead><tr><th>Stutter</th><th class="num">Count</th>' +
            '<th>Meaning</th></tr>' +
            '</thead><tbody>' +
            `<tr><td>Janks</td><td class="num">${d.fps.janks}</td>` +
            '<td>A frame took over 83 ms, or over twice the typical frame time</td></tr>' +
            `<tr><td>Severe janks</td><td class="num">${d.fps.bigJanks ?? 0}</td>` +
            '<td>A frame took over 125 ms &mdash; a visible freeze</td></tr>' +
            `<tr><td>Missed a refresh</td><td class="num">${d.fps.smallJanks ?? 0}</td>` +
            `<td>Of ${d.fps.totalFrames ?? 0} frames measured</td></tr>` +
            '</tbody></table>',
        );
        if (audience === 'complete') {
          notes.push(`<p class="note">${esc(relativeJankNote)}</p>`);
          notes.push(`<p class="note">${esc(RATING_BASIS)}</p>`);
        }
      }

      if (audience === 'complete' && d.fps?.source === 'gfxinfo') {
        notes.push(
          '<p class="note">Frame rate came from <code>gfxinfo</code>, which counts frames drawn ' +
            'through Android’s View system. A Unity game draws through its own surface, so this ' +
            'figure can under-report; it was used because per-layer compositor timing was not ' +
            'available on this device.</p>',
        );
      }

      return (
        (report.devices.length > 1
          ? `<h3>Device ${esc(d.role)} — ${esc(d.manufacturer)} ${esc(d.model)}</h3>`
          : '') +
        `<div class="stat-row">${cards.join('')}</div>` +
        notes.join('')
      );
    })
    .join('');

  return `<section class="block">
  <h2>Heat and battery</h2>
  <p>Measured on the device throughout play. These sit beside memory because they are causes as
  often as effects: a phone that throttles renders slower, and a slower game holds its assets for
  longer.</p>
  ${blocks}
</section>`;
}

function statCard(label: string, value: string, note: string, tone = ''): string {
  return `<div class="stat-card ${tone}">
    <div class="stat-label">${esc(label)}</div>
    <div class="stat-value">${value}</div>
    <div class="stat-note">${note}</div>
  </div>`;
}

/**
 * The memory curve, and the jumps in it.
 *
 * The chart is inline SVG: no rendering dependency, sharp at any zoom in a PDF,
 * and the same shape and category order the operator watched live. A different
 * chart of the same data would only make a reader wonder which was right.
 */
function renderMemoryTimeline(report: AnalysisReport, audience: ReportAudience): string {
  const sess = report.session;
  if (!sess || sess.timelineSeries.length === 0) return '';

  const markers = sess.timeline
    .filter((e) => e.source === 'operator')
    .map((e) => ({ elapsedMs: e.elapsedMs, label: e.label }));

  const charts = sess.timelineSeries
    .map((series) => {
      if (series.points.length < 2) return '';
      const device = report.devices.find((d) => d.role === series.role);
      const svg = renderTimelineSvg({
        points: series.points,
        markers,
        checkpoints: (sess.spikes ?? [])
          .filter((sp) => sp.role === series.role && sp.letter)
          .map((sp) => ({ elapsedMs: sp.toMs, letter: sp.letter })),
        targetBytes: device?.budget?.targetMaxBytes ?? null,
        limitBytes: device?.budget?.hardLimitBytes ?? null,
        forPrint: true,
      });
      if (!svg) return '';
      return (
        (report.devices.length > 1
          ? `<h3>Device ${esc(series.role)} — ${esc(device?.model ?? '')}</h3>`
          : '') +
        `<div class="chart">${svg}</div>` +
        renderTimelineLegend(true)
      );
    })
    .join('');

  if (!charts) return '';

  return `<section class="block">
  <h2>Memory over the session</h2>
  ${charts}
  <p class="caption">Stacked by where the memory actually is, so the top edge is the total. Dashed
  lines are what one app may use on this phone; lettered circles mark the largest jumps and match
  the table below.</p>
</section>`;
}

/**
 * The largest jumps, with what moved inside them.
 *
 * Developer and complete cuts only. A lead needs the verdict and the cost; a
 * list of memory mappings is detail to an engineer and noise to them, and
 * printing it in every cut would make the summary unreadable without making it
 * more useful.
 */
function renderSpikes(report: AnalysisReport, audience: ReportAudience): string {
  const spikes = report.session?.spikes ?? [];
  if (spikes.length === 0) return '';

  const multiDevice = report.devices.length > 1;

  const rows = spikes
    .map(
      (s) =>
        '<tr>' +
        `<td>${s.letter ? `<span class="cp">${esc(s.letter)}</span>` : ''}</td>` +
        (multiDevice ? `<td>${esc(s.role)}</td>` : '') +
        `<td class="mono">${clockOf(s.fromMs)} → ${clockOf(s.toMs)}</td>` +
        `<td class="num"><strong>${signed(s.deltaBytes)}</strong></td>` +
        `<td class="num">${fmt(s.totalBytes)}</td>` +
        `<td>${esc(s.kind)}</td>` +
        `<td>${s.nearestMarker ? esc(s.nearestMarker) : '<span class="dim">unmarked</span>'}</td>` +
        '</tr>',
    )
    .join('');

  const detail = spikes
    .map((s) => {
      const parts: string[] = [];

      if (s.engine.length > 0) {
        parts.push(
          movedList(
            'Unity engine allocations',
            'reported by the engine itself',
            s.engine.map((e) => ({ name: e.label, deltaBytes: e.deltaBytes })),
          ),
        );
      }
      if (s.mappings.length > 0) {
        parts.push(
          movedList('Named memory mappings', 'read from the process', s.mappings, true),
        );
      }
      if (s.categories.length > 0) {
        parts.push(
          movedList(
            'Reported categories',
            'from the system memory report',
            s.categories.map((c) => ({ name: c.label, deltaBytes: c.deltaBytes })),
          ),
        );
      }
      if (parts.length === 0) return '';

      const gap =
        audience === 'complete' && s.engine.length === 0 && s.mappings.length === 0
          ? '<p class="note">Only category totals are available for this jump. Naming the file or ' +
            'the asset type needs either the process’s own memory map (a debuggable build or a ' +
            'rooted device) or the Unity reporter component in the build.</p>'
          : '';

      return `<div class="spike">
        <div class="spike-head">
          ${s.letter ? `<span class="cp">${esc(s.letter)}</span>` : ''}
          <strong>${signed(s.deltaBytes)}</strong>
          <span class="dim">at ${clockOf(s.toMs)}${multiDevice ? ` · device ${esc(s.role)}` : ''}</span>
          <span class="spike-kind">${esc(s.kind)}</span>
        </div>
        <p class="note">${
          s.nearestMarker
            ? `Most recent marker before this point: <strong>${esc(s.nearestMarker)}</strong>.`
            : 'No marker was pressed before this point, so what the game was doing is unrecorded.'
        }</p>
        ${parts.join('')}
        ${gap}
      </div>`;
    })
    .join('');

  return `<section class="block">
  <h2>Largest memory jumps</h2>
  <p>Each row is the change between two consecutive deep samples, biggest first. The deep tier runs
  at roughly one sample every five seconds, so a jump covers a few seconds of activity rather than
  one frame — enough to identify a scene load, not enough to blame a single call.</p>
  <table>
    <thead><tr><th></th>${multiDevice ? '<th>Device</th>' : ''}<th>At</th>
    <th class="num">Change</th><th class="num">Total after</th><th>Looks like</th>
    <th>Marker</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${detail}
</section>`;
}

function movedList(
  title: string,
  note: string,
  rows: Array<{ name: string; deltaBytes: number }>,
  mono = false,
): string {
  const items = rows
    .map(
      (r) =>
        `<li><span class="${mono ? 'mono' : ''}">${esc(r.name)}</span>` +
        `<span class="moved-value">${signed(r.deltaBytes)}</span></li>`,
    )
    .join('');

  return `<div class="moved">
    <div class="moved-head">${esc(title)} <span class="dim">— ${esc(note)}</span></div>
    <ul>${items}</ul>
  </div>`;
}

const THERMAL_LABEL: Record<string, string> = {
  cool: 'Stayed cool',
  warm: 'Warmed up',
  hot: 'Got hot',
  throttling: 'Throttled — the device limited its own performance',
  unknown: 'Not measured',
};

function clockOf(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function renderProject(report: AnalysisReport, isComplete: boolean): string {
  const p = report.project;
  if (!p) return '';

  const scenes = p.heaviestScenes.length
    ? `
  <h3>Heaviest scenes by referenced content</h3>
  <table class="data">
    <thead><tr><th>Scene</th><th class="num">Estimated assets</th><th class="num">Objects</th></tr></thead>
    <tbody>${p.heaviestScenes
      .slice(0, isComplete ? 20 : 8)
      .map(
        (s) =>
          `<tr><td><code>${esc(s.path)}</code></td><td class="num">${fmt(s.estimatedBytes)}</td><td class="num">${s.objectCount.toLocaleString()}</td></tr>`,
      )
      .join('')}</tbody>
  </table>`
    : '';

  const textures = p.largestTextures.length
    ? `
  <h3>Largest textures by estimated runtime memory</h3>
  <table class="data">
    <thead><tr><th>Texture</th><th class="num">Source size</th><th class="num">Estimated memory</th></tr></thead>
    <tbody>${p.largestTextures
      .slice(0, isComplete ? 25 : 10)
      .map(
        (t) =>
          `<tr><td><code>${esc(t.path)}</code></td><td class="num">${esc(t.dimensions ?? '—')}</td><td class="num">${fmt(t.estimatedBytes)}</td></tr>`,
      )
      .join('')}</tbody>
  </table>`
    : '';

  return `
<section>
  <h2>Project overview</h2>
  <table class="meta">
    <tr><th>Assets indexed</th><td>${p.assetCount.toLocaleString()}</td></tr>
    <tr><th>C# files scanned</th><td>${p.scriptFileCount.toLocaleString()}</td></tr>
    <tr><th>Scenes (in build)</th><td>${p.sceneCount} (${p.buildSceneCount})</td></tr>
    <tr><th>Textures</th><td>${p.textureCount.toLocaleString()} — estimated ${fmt(p.estimatedTextureBytes)}</td></tr>
    <tr><th>Audio clips</th><td>${p.audioCount.toLocaleString()} — estimated ${fmt(p.estimatedAudioBytes)}</td></tr>
    <tr><th>Addressables</th><td>${p.usesAddressables ? 'yes' : 'no'}</td></tr>
    <tr><th>Import settings available</th><td>${p.metaFilesPresent ? 'yes' : 'no'}</td></tr>
  </table>
  ${scenes}
  ${textures}
</section>`;
}

function renderAllFindings(report: AnalysisReport): string {
  const group = (title: string, findings: Finding[]) => {
    if (findings.length === 0) return `<h3>${esc(title)}</h3><p class="dim">None.</p>`;
    return `
  <h3>${esc(title)}</h3>
  <table class="data compact">
    <thead><tr><th>Severity</th><th class="num">Confidence</th><th>Finding</th><th class="num">Est. impact</th><th>Rule</th></tr></thead>
    <tbody>${[...findings]
      .sort(bySeverity)
      .map(
        (f) =>
          `<tr><td><span class="chip sev-${esc(f.severity)}">${esc(f.severity)}</span></td><td class="num">${Math.round(f.confidence * 100)}%</td><td>${esc(f.title)}</td><td class="num">${f.estimatedBytes ? fmt(f.estimatedBytes) : '—'}</td><td><code>${esc(f.ruleId)}</code></td></tr>`,
      )
      .join('')}</tbody>
  </table>`;
  };

  return `
<section>
  <h2>All findings</h2>
  ${group('Correlated (measured on device, cause identified in the project)', report.findings.correlated)}
  ${group('Runtime (measured on device)', report.findings.live)}
  ${FEATURES.projectAnalysis ? group('Static (predicted from the project)', report.findings.static) : ''}
</section>`;
}

function renderLimitations(report: AnalysisReport, isLead: boolean): string {
  if (isLead) {
    const caveats = report.verdict.confidence.caveats.slice(0, 5);
    if (caveats.length === 0) return '';
    return `
<section>
  <h2>What would make this more certain?</h2>
  <ul class="plain">${caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
</section>`;
  }

  const unique = [...new Set(report.limitations)];
  return `
<section>
  <h2>Limitations and how to read this report</h2>
  <p class="note">Static findings are predictions: they describe content and code patterns that commonly cause memory problems, with estimated sizes derived from import settings. Runtime findings are measurements from a real device. Where the two agree, the finding is reported as correlated and carries the highest confidence.</p>
  <ul class="plain">${unique.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
</section>`;
}

/**
 * Footer.
 *
 * Carries no internal references: this document is sent to people who have
 * never run the tool, so pointing at report.json or "the developer report"
 * would be a dead end for the reader.
 */
/**
 * The footer carries what the cover used to.
 *
 * Package, version, Unity and architecture led the report before. On a run that
 * profiles an installed app there is no APK to inspect, so all four read
 * "unknown" and the first thing a reader met was a table of absences. Here they
 * keep the report traceable without being the opening statement, and the ones
 * with no value are simply not printed.
 */
function renderFooter(report: AnalysisReport, _audience: ReportAudience): string {
  const s = report.subject;
  const facts: string[] = [];
  if (s.packageName) facts.push(esc(s.packageName));
  if (s.versionName) facts.push(`version ${esc(s.versionName)}`);
  if (s.unityVersion) facts.push(`Unity ${esc(s.unityVersion)}`);
  if (s.scriptingBackend) facts.push(esc(s.scriptingBackend));
  if (s.abis.length > 0) facts.push(esc(s.abis.join(', ')));

  return `
<footer>
  ${facts.length > 0 ? `<div>${facts.join(' \u00b7 ')}</div>` : ''}
  <div>Measured on device during real gameplay by GD-PerformanceShield ${esc(report.toolVersion)},
  ${esc(report.generatedAt.slice(0, 16).replace('T', ' '))}. Reference
  <code>${esc(report.analysisId)}</code>.</div>
</footer>`;
}

/**
 * A short primer for a reader who has never seen this tool.
 *
 * The report is written to be handed to a studio, so it has to explain its own
 * terms - what a predicted finding is versus a measured one, and why a
 * confidence score sits beside the risk score.
 */
function renderAbout(report: AnalysisReport, audience: ReportAudience): string {
  const ranLive = report.session !== null;

  const how = ranLive
    ? 'The game was analysed in two ways: its Unity project and build were read directly, and the game was then installed and played on real Android devices while memory was recorded.'
    : "The game's Unity project and build were read directly. The game was <strong>not</strong> run on a device for this report, so the findings are predictions that have not yet been confirmed on hardware.";

  const kinds =
    audience === 'lead'
      ? ''
      : `
  <ul class="plain">
    <li><strong>Predicted</strong> — found by reading the project. It describes a pattern that commonly causes memory problems, with an estimated size.</li>
    <li><strong>Measured</strong> — observed on a real device during play.</li>
    <li><strong>Confirmed</strong> — predicted and measured independently, and they agree. These carry the most weight.</li>
  </ul>`;

  return `
<section class="about">
  <h2>About this report</h2>
  <p>${how}</p>
  ${kinds}
  <p class="note">The risk score estimates how likely the game is to run out of memory on the devices it targets. The separate confidence score says how much of the intended checking actually happened — so a low risk score backed by low confidence means "not yet shown to be a problem", not "known to be fine".</p>
</section>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/** Verdict as a coloured chip that survives printing. */
function verdictChip(verdict: 'green' | 'yellow' | 'red'): string {
  return `<span class="chip verdict-${verdict}">${esc(VERDICT_LABEL[verdict])}</span>`;
}

function orDash(bytes: number | null | undefined): string {
  return bytes === null || bytes === undefined ? '—' : fmt(bytes);
}

function signed(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  const text = fmt(bytes);
  return bytes > 0 ? `<strong class="bad">+${text}</strong>` : text;
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

function bySeverity(a: Finding, b: Finding): number {
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

function sourceLabel(source: string): string {
  if (source === 'correlated') return 'measured on device, cause found in the project';
  if (source === 'live') return 'measured on device';
  return 'predicted from the project';
}

/**
 * Print stylesheet.
 *
 * The rules that matter for a readable PDF are the break controls: a finding or
 * a table row split across two pages is the difference between a report someone
 * reads and one they put down.
 */
const PRINT_CSS = `
/* ---- the summary page -------------------------------------------------- */
.summary { margin-bottom: 18px; }
.summary h1 { font-size: 22pt; margin: 0 0 2px; letter-spacing: -0.4pt; }
.eyebrow {
  font-size: 9pt; text-transform: uppercase; letter-spacing: .1em; color: #6a6a6a;
}
.lede { font-size: 11.5pt; line-height: 1.45; margin: 6px 0 15px; }
.blk-label {
  font-size: 9pt; text-transform: uppercase; letter-spacing: .08em; color: #6a6a6a;
  font-weight: 700; margin-bottom: 5px;
}

/* Risk and memory together: the two questions a reader opens with. */
.top { display: flex; gap: 13px; margin-bottom: 13px; align-items: stretch; }
.risk {
  /* A little wider than before: the label now names what the score is about. */
  flex: 0 0 188px; border: 1px solid #d8d8d8; border-left: 4px solid #6a6a6a;
  border-radius: 5px; padding: 10px 13px;
}
.risk.band-high, .risk.band-critical { border-left-color: #cf222e; }
.risk.band-high .band, .risk.band-critical .band { color: #cf222e; }
.risk.band-moderate { border-left-color: #9a6700; }
.risk.band-moderate .band { color: #9a6700; }
.risk.band-low { border-left-color: #1a7f37; }
.risk.band-low .band { color: #1a7f37; }
.risk .score { font-size: 38pt; font-weight: 700; line-height: 0.95; letter-spacing: -2pt; }
.risk .out-of { font-size: 12pt; color: #6a6a6a; font-weight: 400; letter-spacing: 0; }
.risk .band {
  font-size: 10pt; font-weight: 700; text-transform: uppercase; letter-spacing: .07em;
  margin-top: 2px;
}
.risk .conf { font-size: 8.5pt; color: #6a6a6a; margin-top: 6px; line-height: 1.4; }

.memory { flex: 1; border: 1px solid #d8d8d8; border-radius: 5px; padding: 10px 13px; }
.memory table { width: 100%; border-collapse: collapse; font-size: 10pt; margin: 0; }
.memory td { padding: 3px 0; border-bottom: 1px solid #f2f2f2; }
.memory tr:last-child td { border-bottom: none; }
.memory td.k { color: #4a4a4a; }
.memory td.v { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
.memory .headline td.v { font-size: 15pt; }
.memory .sub { font-size: 8.5pt; color: #6a6a6a; font-weight: 400; }

/* Session facts as one strip, so they cost a line rather than a section each. */
.strip { display: flex; gap: 10px; margin-bottom: 13px; }
.strip .cell { flex: 1; border: 1px solid #d8d8d8; border-radius: 5px; padding: 8px 12px; }
.strip .label {
  font-size: 8.5pt; text-transform: uppercase; letter-spacing: .06em; color: #6a6a6a;
}
.strip .value { font-size: 17pt; font-weight: 700; line-height: 1.15; }
.strip .value .unit { font-size: 9.5pt; font-weight: 400; color: #6a6a6a; margin-left: 3px; }
.strip .note { font-size: 8.5pt; color: #6a6a6a; }

/* Two figures of equal weight in one card, rather than one subordinate to the other. */
.strip .pairs { display: flex; gap: 16px; }
.strip .pair { line-height: 1.1; }
.strip .pair .value { font-size: 17pt; font-weight: 700; }
.strip .pair-label {
  font-size: 8pt; text-transform: uppercase; letter-spacing: .05em; color: #6a6a6a;
  margin-top: -1px;
}
.strip .unit-inline { text-transform: none; letter-spacing: 0; }

table.delta { width: 100%; border-collapse: collapse; font-size: 10pt; margin: 0 0 4px; }
table.delta th {
  text-align: left; font-size: 8.5pt; text-transform: uppercase; letter-spacing: .05em;
  color: #6a6a6a; padding: 4px 8px; border-bottom: 1.5px solid #1a1a1a;
}
table.delta td { padding: 5px 8px; border-bottom: 1px solid #eee; }
table.delta .num { text-align: right; font-variant-numeric: tabular-nums; }
table.delta .up { color: #cf222e; }
table.delta .down { color: #1a7f37; }
table.delta .flat { color: #8a8a8a; }

/* ---- frame rate, heat, battery ---------------------------------------- */
.stat-row { display: flex; gap: 10px; flex-wrap: wrap; margin: 10px 0; }
.stat-card {
  flex: 1 1 150px;
  border: 1px solid #d8d8d8;
  border-left: 3px solid #999;
  border-radius: 5px;
  padding: 9px 12px;
  break-inside: avoid;
}
.stat-card.ok { border-left-color: #1a7f37; }
.stat-card.warn { border-left-color: #9a6700; }
.stat-card.bad { border-left-color: #cf222e; }
.stat-label { font-size: 9.5pt; color: #5a5a5a; text-transform: uppercase; letter-spacing: .04em; }
.stat-value { font-size: 20pt; font-weight: 700; line-height: 1.15; margin: 2px 0; }
.stat-value .unit { font-size: 10pt; font-weight: 400; color: #5a5a5a; margin-left: 3px; }
.stat-note { font-size: 9pt; color: #5a5a5a; line-height: 1.45; }

/*
 * A remark is the judgement beside a number, and the judgement is usually what
 * the reader came for. Set as a tinted pill so it separates from the figures
 * without competing with the heading above them.
 */
.remark {
  display: inline-block;
  font-size: 8pt;
  font-weight: 600;
  line-height: 1.3;
  padding: 1.5px 6px;
  border-radius: 2px;
  white-space: nowrap;
  background: #f0f0f0;
  color: #5a5a5a;
}
.remark.r-good  { background: #e4f1ea; color: #1c6b48; }
.remark.r-watch { background: #f7eedd; color: #8a5a15; }
.remark.r-bad   { background: #f8e5e3; color: #97332b; }
.remark.r-flat  { background: #f0f1f3; color: #61666e; }

/*
 * A caption sits under its chart, separated by a rule, small and faded: it
 * explains the picture rather than competing with it for attention.
 */
.caption {
  margin: 7px 0 0;
  padding-top: 6px;
  border-top: 1px solid #e6e6e6;
  font-size: 8.5pt;
  line-height: 1.5;
  color: #7a7a7a;
}

/*
 * Ruled all the way round. An unbordered table of three columns reads as loose
 * text on a printed page, and a reader has to work out for themselves which
 * number belongs to which heading.
 */
table.bordered { border: 1px solid #c8c8c8; }
table.bordered th {
  background: #f2f2f2;
  border: 1px solid #c8c8c8;
  border-bottom-width: 1.5px;
}
table.bordered td { border: 1px solid #dcdcdc; }

/* ---- build check, bottleneck, diagnoses -------------------------------- */

/*
 * The gate carries its own left edge colour rather than the report's, because a
 * build can fail its performance thresholds on a game whose memory risk is low.
 * One block borrowing the other's colour would read as one verdict.
 */
.gate { border-left: 4px solid #6a6a6a; padding-left: 11px; }
.gate-pass { border-left-color: #1a7f37; }
.gate-warn { border-left-color: #9a6700; }
.gate-fail { border-left-color: #cf222e; }

.limit { border-left: 4px solid #6a6a6a; padding-left: 11px; }
.limit-head { font-size: 12.5pt; font-weight: 700; margin: 0 0 4pt; line-height: 1.3; }

/*
 * One diagnosis per block, ruled and kept whole.
 *
 * break-inside: avoid, because a diagnosis split across a page boundary
 * separates the symptom from the evidence that explains it, which is the one
 * arrangement that makes it useless.
 */
.diag {
  break-inside: avoid;
  border: 1px solid #e2e6ed;
  border-left: 3px solid #9aa3b2;
  border-radius: 4px;
  padding: 8pt 11pt 6pt;
  margin: 0 0 8pt;
}
.diag h3 { margin: 0 0 4pt; font-size: 10.5pt; }
.diag p { margin: 0 0 4pt; font-size: 9.5pt; line-height: 1.5; }
.diag.sev-critical, .diag.sev-high { border-left-color: #cf222e; }
.diag.sev-medium { border-left-color: #9a6700; }
.diag h4 { margin: 7pt 0 3pt; font-size: 9.5pt; }

/*
 * The letter that ties three places together.
 *
 * The badge on the frame-rate chart, the row in the event timeline and this
 * heading all carry the same character, which is what lets prose say "look at
 * B" and mean one moment. Set as a filled chip so it reads as a label rather
 * than as the first letter of the sentence after it.
 */
.diag-letter {
  display: inline-block; min-width: 13pt; margin-right: 5pt; padding: 0 3pt;
  border-radius: 2pt; background: #1a1a1a; color: #fff;
  font-size: 8.5pt; font-weight: 700; text-align: center; vertical-align: 1pt;
}

/* A two-column figure block: the label is a row header, quiet and narrow. */
table.facts { margin: 5pt 0 2pt; }
table.facts th[scope="row"] {
  width: 30%; text-align: left; font-weight: 600; color: #4a5160; white-space: nowrap;
}

/*
 * Tones for the event table.
 *
 * The delta table had these, scoped to itself. The event timeline needs the
 * same vocabulary - a column is only scannable if "rose" and "normal" do not
 * look alike - and "muted" is the fourth state the delta table never had: not
 * measured, which is a different claim from normal and must not read as a value.
 */
table.data td.up { color: #cf222e; font-weight: 600; }
table.data td.down { color: #cf222e; font-weight: 600; }
table.data td.flat { color: #6a7080; }
table.data td.muted, .muted { color: #8a8f9a; }

/*
 * A wide table scrolls inside its own box rather than pushing the page sideways.
 *
 * In print there is nothing to scroll, so the rule only narrows the type: a
 * clipped column on paper is worse than a small one.
 */
.scroll-x { overflow-x: auto; }
@media print {
  .scroll-x { overflow-x: visible; }
  .scroll-x table.data { font-size: 8pt; }
}

/* Small, faded, right-aligned figures need a quiet second column. */
table.data td.sub { color: #6a6a6a; font-size: 8.5pt; }

/* The phone a finding is about, named, so a role letter never stands alone. */
.device-context {
  font-size: 9.5pt;
  color: #4a4a4a;
  padding: 7px 11px;
  background: #f5f5f5;
  border-radius: 4px;
  margin: 0 0 10px;
}

/* ---- memory timeline --------------------------------------------------- */
.chart {
  margin: 10px 0 2px;
  border: 1px solid #d8d8d8;
  border-radius: 5px;
  overflow: hidden;
  break-inside: avoid;
}

/* A checkpoint badge, matching the lettered circles drawn on the chart. */
.cp {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 17px;
  height: 17px;
  border-radius: 50%;
  background: #1a1a1a;
  color: #fff;
  font-size: 9pt;
  font-weight: 700;
}

/* ---- memory jumps ------------------------------------------------------ */
.spike {
  border: 1px solid #d8d8d8;
  border-radius: 5px;
  padding: 9px 12px;
  margin: 9px 0;
  break-inside: avoid;
}
.spike-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 3px; }
.spike-head strong { font-size: 13pt; }
.spike-kind {
  font-size: 8.5pt;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .04em;
  background: #eee;
  padding: 1px 6px;
  border-radius: 3px;
}
.moved { margin-top: 7px; }
.moved-head {
  font-size: 9pt;
  text-transform: uppercase;
  letter-spacing: .05em;
  color: #5a5a5a;
  font-weight: 600;
  margin-bottom: 2px;
}
.moved ul { list-style: none; margin: 0; padding: 0; }
.moved li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 9.5pt;
  padding: 1px 0;
  border-bottom: 1px solid #f0f0f0;
}
.moved li:last-child { border-bottom: none; }
.moved-value { font-variant-numeric: tabular-nums; white-space: nowrap; }
.dim { color: #7a7a7a; font-weight: 400; }

@page { size: A4; margin: 16mm 14mm 18mm; }

* { box-sizing: border-box; }

body {
  margin: 0;
  background: #fff;
  color: #14181f;
  font: 10.5pt/1.5 "Segoe UI", -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

h1, h2, h3 { margin: 0; line-height: 1.2; }
h1 { font-size: 24pt; letter-spacing: -.4pt; }
h2 {
  font-size: 13pt;
  margin: 0 0 8pt;
  padding-bottom: 4pt;
  border-bottom: 1.5pt solid #14181f;
  break-after: avoid;
}
h3 {
  font-size: 11pt;
  margin: 12pt 0 5pt;
  break-after: avoid;
}
p { margin: 0 0 6pt; }
code { font-family: "Cascadia Mono", Consolas, monospace; font-size: 8.5pt; color: #2c3a52; }

section { margin: 0 0 16pt; break-inside: auto; }

/* ---- cover ---- */
.cover { margin-bottom: 18pt; padding-bottom: 12pt; border-bottom: 2.5pt solid #14181f; }
.eyebrow {
  font-size: 8pt; letter-spacing: 1.4pt; text-transform: uppercase;
  color: #5b667a; margin-bottom: 6pt;
}
.headline { font-size: 11.5pt; color: #2c3a52; margin: 8pt 0 12pt; max-width: 52em; }

table.meta { border-collapse: collapse; font-size: 9.5pt; }
table.meta th {
  text-align: left; font-weight: 600; color: #5b667a;
  padding: 2pt 14pt 2pt 0; vertical-align: top; white-space: nowrap;
}
table.meta td { padding: 2pt 0; vertical-align: top; }

/* ---- verdict (lead) ---- */
.verdict {
  border: 1pt solid #d3d9e2; border-left: 4pt solid #5b667a;
  padding: 12pt 14pt; break-inside: avoid;
}
.verdict .big { font-size: 34pt; font-weight: 700; line-height: 1; }
.verdict .of { font-size: 15pt; color: #5b667a; font-weight: 400; }
.verdict .band-label { font-size: 9pt; letter-spacing: 1.2pt; color: #5b667a; margin: 2pt 0 8pt; }
.verdict .conf { margin-top: 8pt; color: #2c3a52; }
.verdict.band-critical { border-left-color: #b42318; }
.verdict.band-high     { border-left-color: #b54708; }
.verdict.band-moderate { border-left-color: #a15c07; }
.verdict.band-low      { border-left-color: #067647; }

/* ---- tables ---- */
.scroll { overflow-x: auto; }
table.data { width: 100%; border-collapse: collapse; font-size: 9.5pt; margin: 6pt 0 10pt; }
table.data.compact { font-size: 8.5pt; }
table.data th {
  text-align: left; font-size: 8pt; letter-spacing: .5pt; text-transform: uppercase;
  color: #5b667a; font-weight: 600;
  border-bottom: 1pt solid #14181f; padding: 4pt 6pt 4pt 0;
}
table.data td { padding: 4pt 6pt 4pt 0; border-bottom: .5pt solid #e2e6ed; vertical-align: top; }
table.data .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
table.data th.num { text-align: right; }
table.data tr { break-inside: avoid; }
table.data .row-strong td { background: #f4f6f9; }
thead { display: table-header-group; }

/* ---- findings ---- */
article.finding {
  break-inside: avoid;
  margin: 0 0 12pt; padding: 10pt 12pt;
  border: .75pt solid #d3d9e2; border-radius: 3pt;
}
article.finding h3 { margin: 0 0 6pt; font-size: 11pt; }
article.finding .rank {
  display: inline-block; min-width: 15pt;
  color: #5b667a; font-weight: 700;
}
.tags { margin: 0 0 7pt; }
.chip {
  display: inline-block; font-size: 7.5pt; letter-spacing: .3pt;
  padding: 1pt 5pt; margin-right: 4pt; border-radius: 2pt;
  background: #eef1f6; color: #3d4757; text-transform: uppercase; font-weight: 600;
}
.chip.measured { background: #e6f3f1; color: #0d5f58; }
.chip.sev-critical { background: #fbe9e7; color: #a1241a; }
.chip.sev-high     { background: #fdf0e3; color: #94420a; }
.chip.sev-medium   { background: #eaeffb; color: #23478f; }
.chip.sev-low, .chip.sev-info { background: #eef1f6; color: #5b667a; }
.chip.band-critical { background: #fbe9e7; color: #a1241a; }
.chip.band-high     { background: #fdf0e3; color: #94420a; }
.chip.band-moderate { background: #eaeffb; color: #23478f; }
.chip.band-low      { background: #e6f3f1; color: #0d5f58; }
.chip.verdict-green  { background: #e6f3f1; color: #0d5f58; }
.chip.verdict-yellow { background: #fdf0e3; color: #94420a; }
.chip.verdict-red    { background: #fbe9e7; color: #a1241a; }

.fix { margin-top: 6pt; }
.evidence { margin-top: 8pt; padding-top: 6pt; border-top: .5pt solid #e2e6ed; }
.ev-head {
  font-size: 7.5pt; letter-spacing: .8pt; text-transform: uppercase;
  color: #5b667a; font-weight: 600; margin-bottom: 4pt;
}
.evidence ul { margin: 0; padding-left: 14pt; font-size: 9pt; }
.evidence li { margin-bottom: 3pt; }
.evidence pre {
  margin: 3pt 0 5pt; padding: 4pt 6pt; background: #f4f6f9;
  border-left: 2pt solid #d3d9e2; font-family: "Cascadia Mono", Consolas, monospace;
  font-size: 8pt; white-space: pre-wrap; word-break: break-word;
}

ul.plain { margin: 0; padding-left: 14pt; font-size: 9.5pt; }
ul.plain li { margin-bottom: 4pt; }

.note { color: #5b667a; font-size: 9pt; max-width: 54em; }
.dim { color: #8a93a3; }
.bad { color: #b42318; }

footer {
  margin-top: 18pt; padding-top: 8pt;
  border-top: .75pt solid #d3d9e2;
  font-size: 8pt; color: #5b667a;
}

/* ---- the rules that apply to every section --------------------------------
 *
 * Both come from the summary page, where they earned their place: a hairline
 * under every heading, and columns ruled the way rows already are. Kept last in
 * the stylesheet so they settle the question for the whole document rather than
 * being undone by whichever section-specific rule happens to come after them.
 */

/*
 * Every heading is ruled.
 *
 * The h2s already carried a rule and the rest did not, so a subheading and a
 * small-caps label read as the same weight as the text beneath them. A reader
 * scanning for a section had only size to go on.
 */
h3 {
  border-bottom: .75pt solid #e2e6ed;
  padding-bottom: 3pt;
}
.blk-label, .stat-label, .strip .label, .moved-head, .ev-head {
  display: block;
  border-bottom: .75pt solid #e2e6ed;
  padding-bottom: 2.5pt;
  margin-bottom: 4pt;
}

/*
 * Columns ruled like rows.
 *
 * A table of four columns where only the rows are ruled makes a reader track
 * horizontally across open space to keep a figure with its heading - and the
 * wider the table, the further they have to track. A hairline between columns
 * costs nothing on paper and removes the guesswork.
 */
table.data:not(.bordered) th, table.data:not(.bordered) td,
table.delta:not(.bordered) th, table.delta:not(.bordered) td {
  border-right: .5pt solid #e2e6ed;
  padding-right: 8pt;
}
table.data:not(.bordered) th:last-child, table.data:not(.bordered) td:last-child,
table.delta:not(.bordered) th:last-child, table.delta:not(.bordered) td:last-child {
  border-right: 0;
}
/* A gutter each side of every rule, so no column sits against its own line. */
table.data:not(.bordered) th + th, table.data:not(.bordered) td + td,
table.delta:not(.bordered) th + th, table.delta:not(.bordered) td + td {
  padding-left: 8pt;
}

/* The verdict column, at the right-hand end of the row where it belongs. */
td.remark-cell { white-space: nowrap; }
`;
