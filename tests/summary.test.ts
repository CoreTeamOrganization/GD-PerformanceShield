/**
 * The summary cut: a one-page performance snapshot.
 *
 * Two things are being protected here. The first is that the snapshot says what
 * the report says - every figure on it has to come from the report object and
 * from the tool's own thresholds, because a summary that rounds, re-rates or
 * invents is worse than no summary. The second is that it stays a snapshot: the
 * charts, the methodology and the technical detail belong in the complete cut,
 * and the moment they leak back in, the page stops being readable at a glance.
 */
import { describe, expect, it } from 'vitest';

import { buildSnapshot } from '../src/report/snapshot.js';
import { renderPrintableHtml } from '../src/report/html.js';
import { renderMarkdown } from '../src/report/markdown.js';
import type { AnalysisReport } from '../src/report/model.js';
import { liveSessionReport } from './fixtures/liveReport.js';

const MB = 1024 * 1024;

/** A game with nothing wrong with it: no findings, everything inside its rating. */
function healthyReport(): AnalysisReport {
  const report = liveSessionReport();
  report.priority = [];
  report.verdict.combinedRisk = { value: 4, band: 'low', contributors: [] };
  report.verdict.confidence.value = 0.85;
  report.devices[0]!.peakBytes = 410 * MB;
  report.devices[0]!.fps!.janks = 0;
  // A healthy game passes its build check too. Leaving the fixture's failing
  // gate in place would make this "a game with nothing wrong with it" that the
  // page still has to report a failure for.
  report.qualityGate = {
    ...report.qualityGate!,
    status: 'pass',
    passed: true,
    exitCode: 0,
    summary: { failed: 0, warned: 0, passed: 9, skipped: 0, failedChecks: [], skippedChecks: [] },
    devices: report.qualityGate!.devices.map((d) => ({
      ...d,
      status: 'pass' as const,
      checks: d.checks.map((c) => ({ ...c, status: 'pass' as const })),
    })),
  };
  return report;
}

describe('the snapshot model', () => {
  it('carries the four numbers a reader opens with, each with its own rating', () => {
    const snap = buildSnapshot(liveSessionReport());

    expect(snap.kpis.map((k) => k.key)).toEqual(['memory', 'fps', 'heat', 'stutter']);
    expect(snap.kpis.map((k) => k.value)).toEqual(['938.0 MB', '59 FPS', '32.2°C', '6']);
    expect(snap.kpis.map((k) => k.caption)).toEqual(['Peak', 'Average', 'Peak', 'Janks']);

    // The words come from the tool's existing verdicts and ratings: the budget
    // verdict for memory, `rateFps`, the thermal verdict, `rateJanks`.
    expect(snap.kpis.map((k) => k.status)).toEqual([
      'Within budget',
      'Very smooth',
      'Cool',
      'Good',
    ]);
    expect(snap.kpis.every((k) => k.tone === 'good')).toBe(true);
  });

  it('takes the risk score and the band from the report, unchanged', () => {
    const report = liveSessionReport();
    const snap = buildSnapshot(report);

    expect(snap.risk.value).toBe(report.verdict.combinedRisk.value);
    expect(snap.risk.band).toBe('moderate');
    expect(snap.risk.label).toBe('MODERATE RISK');
    expect(snap.risk.tone).toBe('watch');
  });

  it('keeps confidence apart from risk, so one is never read as the other', () => {
    const snap = buildSnapshot(liveSessionReport());

    expect(snap.confidence.percent).toBe(35);
    // Low confidence on a moderate risk: the two must not share a tone, or the
    // page would say "35% risky" to anyone reading it at a glance.
    expect(snap.confidence.tone).toBe('bad');
    expect(snap.risk.tone).toBe('watch');
    expect(snap.confidence.label).toBe('an early indication only');
  });

  it('names the biggest issue from the ranking the tool already made', () => {
    const report = liveSessionReport();
    const snap = buildSnapshot(report);
    const top = report.priority[0]!.finding;

    expect(snap.issue).not.toBeNull();
    expect(snap.issue!.headline).toBe('+505.1 MB');
    expect(snap.issue!.kind).toBe('Memory spike');
    // The window comes from the finding's own evidence, not from a recalculation.
    expect(snap.issue!.detail).toBe('in 9.2 seconds');
    expect(snap.issue!.priority).toBe(`${top.severity.toUpperCase()} PRIORITY`);
  });

  it('says so plainly rather than inventing an issue when there is none', () => {
    const snap = buildSnapshot(healthyReport());

    expect(snap.issue).toBeNull();
    expect(snap.bottomLine).toContain('No significant problems were measured');
  });

  it('reads gameplay from the frame-rate figures and the stutter rating', () => {
    const snap = buildSnapshot(liveSessionReport());

    expect(snap.experience).not.toBeNull();
    expect(snap.experience!.facts).toEqual(['59 FPS average', '6 janks', '60 Hz display']);
    expect(snap.experience!.verdict).toBe('SMOOTH');
  });

  it('lets the worse of frame rate and stutter decide how the game felt', () => {
    const report = liveSessionReport();
    // A steady average with a stall every few seconds is not a smooth game.
    report.devices[0]!.fps!.janks = 90;

    const snap = buildSnapshot(report);
    expect(snap.kpis[3]!.status).toBe('Frequent');
    expect(snap.experience!.verdict).toBe('CHOPPY');
  });

  it('states device and session compactly, from the measured values', () => {
    const snap = buildSnapshot(liveSessionReport());

    expect(snap.device).toBe('Samsung SM-A366B · 7.21 GB RAM');
    expect(snap.session).toBe('03:48 gameplay · 1 device tested');
  });

  it('shows no figure for a metric the run could not measure', () => {
    const report = liveSessionReport();
    report.devices[0]!.thermal = null;
    report.devices[0]!.fps = null;

    const snap = buildSnapshot(report);
    const byKey = Object.fromEntries(snap.kpis.map((k) => [k.key, k]));

    expect(byKey['fps']!.value).toBeNull();
    expect(byKey['heat']!.value).toBeNull();
    expect(byKey['fps']!.tone).toBe('unknown');
    expect(byKey['heat']!.status).toBe('Not measured');
    // Not measured is not the same as fine, so neither is counted as healthy.
    expect(snap.bottomLine).not.toContain('rendering');
    expect(snap.experience).toBeNull();
  });

  it('keeps the warnings that brevity would otherwise swallow', () => {
    const killed = liveSessionReport();
    killed.devices[0]!.processDeaths = 2;
    expect(buildSnapshot(killed).alerts[0]).toContain('killed the game 2 times');

    const unrun = liveSessionReport();
    unrun.session = null;
    unrun.devices = [];
    expect(buildSnapshot(unrun).alerts.join(' ')).toContain('never run on a device');
    expect(buildSnapshot(unrun).session).toBeNull();
  });

  it('names every failing area in the bottom line, in words anyone can read', () => {
    const report = liveSessionReport();
    report.devices[0]!.budget!.verdict = 'red';
    report.devices[0]!.thermal!.verdict = 'hot';
    report.devices[0]!.fps!.averageFps = 30;

    const bottom = buildSnapshot(report).bottomLine;
    expect(bottom).toContain('Memory is the main area requiring investigation.');
    expect(bottom).toContain('also need attention');
    expect(bottom).toContain('testing confidence is currently low');
    // Two sentences at most: this is the line a producer actually reads.
    expect(bottom.split('. ').length).toBeLessThanOrEqual(2);
  });

  it('carries all five subsystems, so one page shows which to open', () => {
    const snap = buildSnapshot(liveSessionReport());

    expect(snap.subsystems.map((s) => s.name)).toEqual([
      'GPU',
      'Rendering',
      'CPU',
      'Storage',
      'Audio',
    ]);

    const byName = Object.fromEntries(snap.subsystems.map((s) => [s.name, s]));
    // The figures and the verdicts both come from `performance.ts`, so the
    // summary and the complete report can never grade a subsystem differently.
    expect(byName['GPU']!.value).toBe('78.4% busy on average');
    expect(byName['GPU']!.status).toBe('Watch');
    expect(byName['Rendering']!.value).toBe('812 draw calls per frame');
    expect(byName['Rendering']!.status).toBe('OK');
    // A flagged row's figure says why it is flagged. "604 MB read" and "24
    // voices" beside an amber light leave a reader to guess which fact is the
    // problem, and the problem is never the size or the count.
    expect(byName['Storage']!.status).toBe('Watch');
    expect(byName['Storage']!.value).toBe('1 read cost frames');
    expect(byName['Audio']!.value).toBe('3 dropouts (0.8/min)');
  });

  it('keeps a subsystem it could not measure on the page, saying so', () => {
    const report = liveSessionReport();
    report.devices[0]!.gpu = null;
    report.devices[0]!.render = null;

    const byName = Object.fromEntries(
      buildSnapshot(report).subsystems.map((s) => [s.name, s]),
    );

    // Dropping the row would make a run that measured three subsystems look
    // like a run where five were fine.
    expect(byName['GPU']!.tone).toBe('unknown');
    expect(byName['GPU']!.value).toBeNull();
    expect(byName['GPU']!.status).toBe('Not measured');
    expect(byName['Rendering']!.status).toBe('Not measured');
  });

  it('states what limited the frame, and how much to trust the answer', () => {
    const snap = buildSnapshot(liveSessionReport());

    expect(snap.limit).not.toBeNull();
    expect(snap.limit!.headline).toBe('Frames are limited by the GPU.');
    // A verdict from the engine's own per-frame timings and one inferred from
    // five-second CPU samples deserve different trust, and the page has to say
    // which it is.
    expect(snap.limit!.basis).toContain('Measured from the engine');

    const inferred = liveSessionReport();
    inferred.devices[0]!.bottleneck!.basis = 'os-signals';
    expect(buildSnapshot(inferred).limit!.basis).toContain('Inferred');
  });

  it('leaves out the limit section rather than printing a shrug', () => {
    const report = liveSessionReport();
    report.devices[0]!.bottleneck = {
      ...report.devices[0]!.bottleneck!,
      kind: 'unknown',
      contributors: [],
    };
    expect(buildSnapshot(report).limit).toBeNull();
  });

  it('names the worst frame collapse and what coincided with it', () => {
    const snap = buildSnapshot(liveSessionReport());

    expect(snap.rootCause).not.toBeNull();
    expect(snap.rootCause!.at).toBe('1:16');
    expect(snap.rootCause!.symptom).toContain('18 fps');
    expect(snap.rootCause!.during).toBe('Riot starts');
    expect(snap.rootCause!.coincided).toContain('58.4 ms');
    expect(snap.rootCause!.fix).toContain('per-pixel cost');
    // Worst first, taken from the ranking the diagnostic engine already made
    // rather than re-ranked here into a second, competing judgement.
    expect(snap.rootCause!.tone).toBe('bad');
  });

  it('presents an unexplained collapse as unexplained', () => {
    const report = liveSessionReport();
    // Only the entry the engine could not explain remains.
    report.diagnostics = [report.diagnostics![1]!];

    const cause = buildSnapshot(report).rootCause!;
    expect(cause.coincided).toBeNull();
    expect(cause.symptom).toContain('34 fps');
    expect(cause.fix).toContain('reporter component');
  });

  it('answers pass or fail against this device class, and counts the gaps', () => {
    const snap = buildSnapshot(liveSessionReport());

    expect(snap.gate).not.toBeNull();
    expect(snap.gate!.status).toBe('FAIL');
    expect(snap.gate!.tone).toBe('bad');
    expect(snap.gate!.failed).toEqual(['Audio dropouts']);
    // A green gate with skipped checks is not a green build, so the count is
    // carried rather than quietly dropped.
    expect(snap.gate!.skipped).toBe(1);
    expect(snap.gate!.tier).toContain('high-end');
  });

  it('never reports a gate that measured nothing as a pass', () => {
    const report = liveSessionReport();
    const gate = report.qualityGate!;
    gate.status = 'pass';
    gate.summary = {
      failed: 0,
      warned: 0,
      passed: 0,
      skipped: 9,
      failedChecks: [],
      skippedChecks: [],
    };

    const snap = buildSnapshot(report);
    // The single most damaging thing this page could say is "PASS" about a run
    // that tested nothing.
    expect(snap.gate!.status).toBe('NOT CHECKED');
    expect(snap.gate!.tone).toBe('unknown');
    expect(snap.gate!.headline).toContain('None of the 9 checks');
  });

  it('names the build check it failed, rather than only counting it', () => {
    const snap = buildSnapshot(liveSessionReport());

    // A count on its own tells a reader they have a problem and not what it is,
    // which is the one thing this page must not do.
    expect(snap.gate?.failed).toEqual(['Audio dropouts']);
    expect(snap.bottomLine).toContain('failed the “Audio dropouts” check');
    expect(snap.bottomLine).not.toContain('1 performance check');
  });

  it('names the first failed check and counts the rest when several fail', () => {
    const report = liveSessionReport();
    const gate = report.qualityGate as unknown as {
      devices: Array<{ checks: Array<{ status: string }> }>;
    };
    gate.devices[0]!.checks = gate.devices[0]!.checks.map((c, i) =>
      i < 3 ? { ...c, status: 'fail' } : c,
    );

    const bottom = buildSnapshot(report).bottomLine;
    expect(bottom).toMatch(/failed the “[^”]+” check and \d+ others/);
    // Still two sentences: the card above carries the full list.
    expect(bottom.split('. ').length).toBeLessThanOrEqual(2);
  });

  it('never carries a file path into a summary', () => {
    const report = liveSessionReport();
    const finding = report.priority[0]!.finding;
    finding.source = 'static';
    finding.ruleId = 'UNITY.TEXTURE.OVERSIZED';
    finding.subject = 'Assets/Art/Characters/hero_atlas.png';
    finding.evidence = [];

    const snap = buildSnapshot(report);
    expect(snap.issue!.kind).toBe('Texture memory');
    expect(JSON.stringify(snap)).not.toContain('Assets/');
  });
});

describe('the printed summary', () => {
  const report = liveSessionReport();
  const html = renderPrintableHtml(report, 'lead');

  it('is a standalone one-page document with nothing fetched from outside', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<style>');
    expect(html).not.toContain('<link rel="stylesheet"');
    expect(html).not.toContain('src="http');
    // One page, not a flowing document: nothing may ask for a page break.
    expect(html).not.toContain('break-before');
  });

  it('leads with the status, the score and the four numbers', () => {
    expect(html).toContain('Performance Snapshot');
    expect(html).toContain('MODERATE RISK');
    expect(html).toContain('>41<');
    expect(html).toContain('35%');
    for (const value of ['938.0 MB', '59 FPS', '32.2°C', 'What is the biggest problem?', '+505.1 MB']) {
      expect(html).toContain(value);
    }
  });

  it('leaves the charts, the methodology and the diagnostics to the complete report', () => {
    const complete = renderPrintableHtml(report, 'complete');

    expect(html).not.toContain('<svg');
    expect(html).not.toContain('Largest memory jumps');
    expect(html).not.toContain('How the risk score breaks down');
    expect(html).not.toContain('What would make this more certain');
    expect(html).not.toContain('vsync');
    expect(html).not.toContain('Recommended fix');

    // All of it is still in the report, and the summary is a fraction of its size.
    expect(complete).toContain('Largest memory jumps');
    expect(html.length).toBeLessThan(complete.length / 3);
  });

  it('escapes the report’s own text, so a game name cannot break the page', () => {
    const hostile = liveSessionReport();
    hostile.subject.gameName = '<script>alert(1)</script> & "co"';

    const out = renderPrintableHtml(hostile, 'lead');
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('auto-prints only when the caller asks', () => {
    expect(html).not.toContain('window.print()');
    expect(renderPrintableHtml(report, 'lead', { autoPrint: true })).toContain('window.print()');
  });
});

describe('the Markdown summary', () => {
  it('says exactly what the printed one says, in the same order', () => {
    const report = liveSessionReport();
    const md = renderMarkdown(report, 'lead');

    expect(md.startsWith('# Prison Riot: Guard Simulator')).toBe(true);
    for (const value of ['MODERATE RISK — 41 / 100', '**Confidence: 35%**', '938.0 MB', '59 FPS', '32.2°C', '+505.1 MB', 'in 9.2 seconds', 'HIGH PRIORITY', 'Overall: SMOOTH', '03:48 gameplay']) {
      expect(md).toContain(value);
    }

    const order = [
      '## Build check',
      '## What is slowing it down?',
      '## Subsystem check',
      '## What is the biggest problem?',
      '## Why did it stutter?',
      '## How did it play?',
      '## Device and session',
      '## Bottom line',
    ];
    const positions = order.map((heading) => md.indexOf(heading));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions.every((p) => p > 0)).toBe(true);
  });

  it('puts the five subsystems, the limit and the root cause on the page', () => {
    const md = renderMarkdown(liveSessionReport(), 'lead');

    for (const value of [
      '🔴 FAIL',
      'Audio dropouts',
      'Frames are limited by the GPU.',
      '78.4% busy on average',
      '812 draw calls per frame',
      '3 dropouts (0.8/min)',
      '1 read cost frames',
      '18 fps',
      'Riot starts',
    ]) {
      expect(md).toContain(value);
    }

    // Every subsystem gets a row, measured or not.
    for (const name of ['GPU', 'Rendering', 'CPU', 'Storage', 'Audio']) {
      expect(md).toContain(`**${name}**`);
    }
  });

  it('says a coincidence is a coincidence, not a cause', () => {
    const md = renderMarkdown(liveSessionReport(), 'lead');
    expect(md).toContain('At the same moment:');
    expect(md).not.toContain('was caused by');
  });

  it('carries the verdict as text, so it survives a paste into a ticket', () => {
    const md = renderMarkdown(healthyReport(), 'lead');
    expect(md).toContain('🟢 LOW RISK');
    expect(md).toContain('No major performance issue detected.');
  });

  it('is far shorter than the complete cut', () => {
    const report = liveSessionReport();
    expect(renderMarkdown(report, 'lead').length).toBeLessThan(
      renderMarkdown(report, 'complete').length / 3,
    );
  });
});
