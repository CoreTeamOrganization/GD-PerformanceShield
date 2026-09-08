/**
 * The summary as a one-page performance snapshot.
 *
 * A separate document from the complete report rather than a filtered version of
 * it. The complete report is a document to be read: sections, charts, methodology
 * and evidence, in an order that explains itself. The summary is a dashboard to
 * be looked at - a producer opens it, and within a few seconds knows whether the
 * game is in trouble, how sure the tool is, what the four numbers are and what the
 * single biggest problem is. Those are different jobs, and the old summary did the
 * second one badly by being a shortened version of the first.
 *
 * One rule governs everything here: it must fit on one page. A snapshot that runs
 * to a second page is a report again, so every block is fixed-height, nothing
 * wraps beyond two lines, and anything that needs a paragraph to explain it lives
 * in the complete report.
 *
 * Deliberately absent: memory and frame-rate charts, the spike breakdown, the
 * methodology, the vSync and battery caveats, the remediation steps, the
 * confidence factor table. All of them are in the complete report, none of them
 * are answers to the questions this page exists to answer.
 */
import { buildSnapshot, type Snapshot, type SnapshotKpi } from './snapshot.js';
import type { AnalysisReport } from './model.js';

export function renderSnapshotHtml(
  report: AnalysisReport,
  opts: { autoPrint?: boolean } = {},
): string {
  const snap = buildSnapshot(report);
  const title = `${report.subject.gameName} — Performance Snapshot`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>${SNAPSHOT_CSS}</style>
</head>
<body>
<div class="page">
  ${renderHeader(snap)}
  ${renderHero(snap)}
  ${renderAlerts(snap)}
  ${renderKpis(snap)}
  ${renderPerformance(snap)}
  <div class="split">
    ${renderIssue(snap)}
    ${renderExperience(snap)}
  </div>
  ${renderRootCause(snap)}
  ${renderContext(snap)}
  ${renderBottomLine(snap)}
  ${renderFoot(report)}
</div>
${
  opts.autoPrint
    ? '<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},250)})</script>'
    : ''
}
</body>
</html>`;
}

/* -------------------------------------------------------------------------- */

function renderHeader(snap: Snapshot): string {
  return `<header class="head">
  <h1>${esc(snap.gameName)}</h1>
  <div class="eyebrow">${esc(snap.eyebrow)}</div>
</header>`;
}

/**
 * The hero.
 *
 * Risk and confidence answer different questions and are set apart on purpose:
 * a reader who reads 35% confidence as "35% risky" has been misled by the layout,
 * so the score keeps the large type and the colour, and confidence sits to the
 * side in a plain box that never borrows the band's colour.
 */
function renderHero(snap: Snapshot): string {
  return `<section class="hero tone-${esc(snap.risk.tone)}">
  <div class="hero-main">
    <div class="status"><span class="dot"></span>${esc(snap.risk.label)}</div>
    <div class="concern">${esc(snap.concern)}</div>
    <div class="score-block">
      <div class="score-label">OOM Risk</div>
      <div class="score">${snap.risk.value}<span class="of"> / 100</span></div>
    </div>
  </div>
  <div class="hero-conf">
    <div class="conf-label">Confidence</div>
    <div class="conf-value">${snap.confidence.percent}%</div>
    <div class="conf-bar"><span style="width:${clampPercent(snap.confidence.percent)}%"></span></div>
    <div class="conf-note">${esc(snap.confidence.label)}</div>
  </div>
  ${renderGate(snap)}
</section>`;
}

/**
 * The build check, beside the risk score.
 *
 * Here rather than in a section of its own because it answers the same kind of
 * question as the score - is this build acceptable - and because the page has
 * no room for a section that says one word. It carries its own tone rather than
 * the hero's: a build can fail its performance thresholds while its memory risk
 * is low, and the two verdicts must not be allowed to colour each other.
 */
function renderGate(snap: Snapshot): string {
  if (!snap.gate) return '';
  const g = snap.gate;

  return `<div class="hero-gate tone-${esc(g.tone)}">
  <div class="conf-label">Build check</div>
  <div class="gate-status"><span class="dot"></span>${esc(g.status)}</div>
  <div class="conf-note">${esc(g.headline)}</div>
  ${
    g.failed.length > 0
      ? `<ul class="gate-failed">${g.failed.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`
      : ''
  }
  ${
    g.skipped > 0
      ? `<div class="gate-skipped">${g.skipped} check${g.skipped === 1 ? '' : 's'} could not be run</div>`
      : ''
  }
</div>`;
}

/**
 * What limited the frame, and the five subsystems on one strip.
 *
 * The strip is the only place on the page where GPU, rendering, CPU, storage
 * and audio appear together, which is what lets a reader tell in one glance
 * which one to open. Chips rather than a table: five short figures read across
 * far better than they read down, and a table of five rows would cost twice the
 * height for the same information.
 *
 * A subsystem that could not be measured keeps its chip and shows a dash.
 * Dropping it would make a run that measured two subsystems look like a run
 * where three were fine.
 */
function renderPerformance(snap: Snapshot): string {
  if (!snap.limit && snap.subsystems.length === 0) return '';

  const limit = snap.limit
    ? `<div class="limit tone-${esc(snap.limit.tone)}">
  <div class="limit-head"><span class="dot"></span>${esc(snap.limit.headline)}</div>
  <div class="limit-basis">${esc(snap.limit.basis)}</div>
</div>`
    : '';

  const chips =
    snap.subsystems.length > 0
      ? `<div class="subs">${snap.subsystems
          .map(
            (s) => `<div class="sub tone-${esc(s.tone)}">
  <div class="sub-name">${esc(s.name)}</div>
  <div class="sub-value${s.value ? '' : ' none'}">${s.value ? esc(s.value) : '—'}</div>
  <div class="sub-status"><span class="dot"></span>${esc(s.status)}</div>
</div>`,
          )
          .join('')}</div>`
      : '';

  return `<section class="perf">
  <h2>What is slowing it down?</h2>
  ${limit}
  ${chips}
</section>`;
}

/**
 * The worst frame collapse, with what coincided with it.
 *
 * One entry, and worded as coincidence rather than cause - "at the same
 * moment", never "because of". That is all a correlation across subsystems can
 * support, and a page this short has no room for the paragraph that would be
 * needed to walk a reader back from an overclaim.
 */
function renderRootCause(snap: Snapshot): string {
  const r = snap.rootCause;
  if (!r) return '';

  return `<section class="cause tone-${esc(r.tone)}">
  <h2>Why did it stutter?</h2>
  <div class="cause-symptom"><span class="dot"></span>${
    r.letter ? `<span class="cause-letter">${esc(r.letter)}</span>` : ''
  }${esc(r.symptom)}${r.during ? ` <em>during ${esc(r.during)}</em>` : ''}</div>
  ${
    // The size of the fall and how sure the tool is. Without both, a lead
    // cannot tell a freeze from a slow game, or a finding from a guess.
    r.magnitude
      ? `<div class="cause-size">Fell ${esc(r.magnitude)} at ${esc(r.at)} · ` +
        `<strong>${esc(r.confidence)}</strong></div>`
      : ''
  }
  ${r.coincided ? `<div class="cause-with">At the same moment: ${esc(r.coincided)}</div>` : ''}
  <div class="cause-fix"><strong>What to do:</strong> ${esc(r.fix)}</div>
</section>`;
}

function renderAlerts(snap: Snapshot): string {
  if (snap.alerts.length === 0) return '';
  return `<div class="alerts">${snap.alerts
    .map((a) => `<div class="alert">${esc(a)}</div>`)
    .join('')}</div>`;
}

function renderKpis(snap: Snapshot): string {
  return `<section class="kpis">${snap.kpis.map(renderKpi).join('')}</section>`;
}

function renderKpi(kpi: SnapshotKpi): string {
  // A metric that was not measured says so, and shows no number. A dash where a
  // figure belongs reads as zero, and a fabricated figure is worse than both.
  const value = kpi.value
    ? `<div class="kpi-value">${esc(kpi.value)}</div><div class="kpi-caption">${esc(kpi.caption)}</div>`
    : '<div class="kpi-value none">—</div><div class="kpi-caption">Not measured</div>';

  return `<article class="kpi tone-${esc(kpi.tone)}">
  <div class="kpi-label">${esc(kpi.label)}</div>
  ${value}
  <div class="kpi-status"><span class="dot"></span>${esc(kpi.status)}</div>
</article>`;
}

function renderIssue(snap: Snapshot): string {
  if (!snap.issue) {
    return `<section class="block issue tone-good">
  <h2>What is the biggest problem?</h2>
  <div class="issue-none">No major performance issue detected</div>
</section>`;
  }

  const i = snap.issue;
  return `<section class="block issue tone-${esc(i.tone)}">
  <h2>What is the biggest problem?</h2>
  ${i.headline ? `<div class="issue-headline">${esc(i.headline)}</div>` : ''}
  <div class="issue-kind">${esc(i.kind)}</div>
  ${i.detail ? `<div class="issue-detail">${esc(i.detail)}</div>` : ''}
  <div class="issue-priority">${esc(i.priority)}</div>
</section>`;
}

function renderExperience(snap: Snapshot): string {
  if (!snap.experience) {
    return `<section class="block exp tone-unknown">
  <h2>How did it play?</h2>
  <div class="exp-none">Frame rate was not measured in this session</div>
</section>`;
  }

  const e = snap.experience;
  return `<section class="block exp tone-${esc(e.tone)}">
  <h2>How did it play?</h2>
  <ul class="exp-facts">${e.facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
  <div class="exp-verdict"><span class="dot"></span>Overall: <strong>${esc(e.verdict)}</strong></div>
</section>`;
}

/** Device and session: needed to read the numbers above, secondary to all of them. */
function renderContext(snap: Snapshot): string {
  const cells = [
    snap.device ? `<div class="ctx"><span class="ctx-label">Device</span>${esc(snap.device)}</div>` : '',
    snap.session
      ? `<div class="ctx"><span class="ctx-label">Session</span>${esc(snap.session)}</div>`
      : '<div class="ctx"><span class="ctx-label">Session</span>No device session captured</div>',
  ].filter(Boolean);

  return `<section class="context">${cells.join('')}</section>`;
}

function renderBottomLine(snap: Snapshot): string {
  return `<section class="bottom">
  <div class="bottom-label">Bottom line</div>
  <p>${esc(snap.bottomLine)}</p>
</section>`;
}

/**
 * The footer.
 *
 * Carries the one distinction the page cannot afford to have misread - risk is
 * not confidence - and enough identity to trace the run. Set at the smallest
 * size on the page, because it is the only text here meant to be read rather
 * than seen.
 */
function renderFoot(report: AnalysisReport): string {
  return `<footer class="foot">
  <div><strong>Risk</strong> is how likely this game is to run out of memory.
  <strong>Confidence</strong> is how much of the intended testing actually happened — a low score
  with low confidence means “not yet shown to be a problem”, not “known to be fine”.
  The complete report carries the charts, the methodology and the technical detail behind every
  figure on this page.</div>
  <div class="trace">GD-PerformanceShield ${esc(report.toolVersion)} ·
  ${esc(report.generatedAt.slice(0, 16).replace('T', ' '))} ·
  ${esc(report.analysisId)}</div>
</footer>`;
}

/* -------------------------------------------------------------------------- */

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function esc(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/**
 * The snapshot stylesheet.
 *
 * Its own, not the report's: the report's print styles are built for flowing
 * sections and page breaks, and this page has neither. Sizes are in points and
 * the blocks are fixed-height, because the one thing that must be true of this
 * document on every result is that it ends on page one.
 */
const SNAPSHOT_CSS = `
@page { size: A4; margin: 12mm 12mm 10mm; }

:root {
  --ink: #14181f;
  --muted: #6b7280;
  --line: #dfe3e9;
  --panel: #f7f8fa;

  --good: #0f7a4d;
  --good-soft: #e7f3ec;
  --watch: #a35c07;
  --watch-soft: #fbf0dd;
  --bad: #b42318;
  --bad-soft: #fbe9e7;
  --unknown: #7b8493;
  --unknown-soft: #f1f2f4;
}

* { box-sizing: border-box; }

/*
 * On screen the page has no paper to sit on, so it makes its own: the same
 * width it prints at, centred, with a margin. The console serves this document
 * as a web page as well as printing it, and edge-to-edge content in a browser
 * window reads as a broken layout rather than a page.
 */
@media screen {
  body { padding: 22px 18px 40px; }
  .page { max-width: 186mm; margin: 0 auto; }
}

body {
  margin: 0;
  background: #fff;
  color: var(--ink);
  font: 10pt/1.45 "Segoe UI", -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

.page { display: flex; flex-direction: column; gap: 9pt; }

/* Tone is one class, set on the block; every child colour reads from it. */
.tone-good    { --tone: var(--good);    --tone-soft: var(--good-soft); }
.tone-watch   { --tone: var(--watch);   --tone-soft: var(--watch-soft); }
.tone-bad     { --tone: var(--bad);     --tone-soft: var(--bad-soft); }
.tone-unknown { --tone: var(--unknown); --tone-soft: var(--unknown-soft); }

.dot {
  display: inline-block; width: 8pt; height: 8pt; border-radius: 50%;
  background: var(--tone, var(--unknown)); margin-right: 5pt; vertical-align: -0.5pt;
}

/* ---- header ---- */
.head { border-bottom: 1.5pt solid var(--ink); padding-bottom: 6pt; }
.head h1 {
  margin: 0; font-size: 21pt; line-height: 1.1; letter-spacing: -.5pt; font-weight: 700;
}
.eyebrow {
  margin-top: 3pt; font-size: 8.5pt; letter-spacing: 1.1pt; text-transform: uppercase;
  color: var(--muted);
}

/* ---- hero ---- */
.hero {
  display: flex; gap: 14pt; align-items: stretch;
  border: 1pt solid var(--line); border-left: 5pt solid var(--tone);
  border-radius: 4pt; background: var(--tone-soft);
  padding: 11pt 14pt;
}
.hero-main { flex: 1; }
.status {
  font-size: 16pt; font-weight: 700; letter-spacing: -.2pt; color: var(--tone);
  line-height: 1.1;
}
.status .dot { width: 10pt; height: 10pt; }
.concern { font-size: 10.5pt; color: var(--ink); margin-top: 3pt; }
.score-block { margin-top: 9pt; }
.score-label {
  font-size: 8pt; letter-spacing: 1.1pt; text-transform: uppercase; color: var(--muted);
  font-weight: 700;
}
.score {
  font-size: 40pt; font-weight: 700; line-height: .95; letter-spacing: -2pt;
  font-variant-numeric: tabular-nums;
}
.score .of { font-size: 13pt; font-weight: 400; color: var(--muted); letter-spacing: 0; }

/*
 * Confidence, kept plain.
 *
 * White ground and grey type whatever the band is: the moment this box borrows
 * the risk colour, a low confidence starts reading as a low risk.
 */
.hero-conf {
  flex: 0 0 122pt; background: #fff; border: 1pt solid var(--line); border-radius: 3pt;
  padding: 9pt 11pt; align-self: center;
}
.conf-label {
  font-size: 8pt; letter-spacing: 1.1pt; text-transform: uppercase; color: var(--muted);
  font-weight: 700;
}
.conf-value {
  font-size: 22pt; font-weight: 700; line-height: 1.1; letter-spacing: -1pt;
  font-variant-numeric: tabular-nums;
}
.conf-bar { height: 4pt; background: #e8eaee; border-radius: 2pt; margin: 4pt 0 5pt; }
.conf-bar span { display: block; height: 100%; background: #4b5563; border-radius: 2pt; }
.conf-note { font-size: 7.5pt; line-height: 1.35; color: var(--muted); }

/* ---- alerts ---- */
.alerts { display: flex; flex-direction: column; gap: 4pt; }
.alert {
  font-size: 9pt; font-weight: 600; color: var(--bad);
  background: var(--bad-soft); border-left: 3pt solid var(--bad);
  border-radius: 2pt; padding: 5pt 9pt;
}

/* ---- the four numbers ---- */
.kpis { display: flex; gap: 8pt; }
.kpi {
  flex: 1 1 0; border: 1pt solid var(--line); border-top: 3pt solid var(--tone);
  border-radius: 4pt; padding: 8pt 10pt 9pt; min-height: 74pt;
}
.kpi-label {
  font-size: 8pt; letter-spacing: 1.1pt; text-transform: uppercase; color: var(--muted);
  font-weight: 700;
}
.kpi-value {
  font-size: 23pt; font-weight: 700; line-height: 1.15; letter-spacing: -1pt;
  margin-top: 2pt; font-variant-numeric: tabular-nums; white-space: nowrap;
}
.kpi-value.none { color: var(--unknown); }
.kpi-caption { font-size: 8.5pt; color: var(--muted); }
.kpi-status {
  margin-top: 6pt; font-size: 8.5pt; font-weight: 600; color: var(--tone);
}
.kpi-status .dot { width: 6.5pt; height: 6.5pt; margin-right: 4pt; }

/*
 * ---- build check ----
 *
 * Its own tone, deliberately not the hero's. A build can fail its performance
 * thresholds on a game whose memory risk is low, and if this box borrowed the
 * hero's colour the two verdicts would read as one.
 */
.hero-gate {
  flex: 0 0 138pt; background: #fff; border: 1pt solid var(--line);
  border-left: 4pt solid var(--tone); border-radius: 3pt; padding: 9pt 11pt; align-self: center;
}
.gate-status {
  font-size: 15pt; font-weight: 700; line-height: 1.1; color: var(--tone); margin: 1pt 0 3pt;
}
.gate-status .dot { width: 8.5pt; height: 8.5pt; }
.gate-failed { margin: 4pt 0 0; padding-left: 11pt; font-size: 7.5pt; color: var(--tone); }
.gate-failed li { line-height: 1.35; }
.gate-skipped { margin-top: 3pt; font-size: 7pt; color: var(--muted); }

/* ---- what is limiting it, and the five subsystems ---- */
.perf { border: 1pt solid var(--line); border-radius: 4pt; padding: 8pt 10pt 9pt; }
.perf h2 {
  margin: 0 0 6pt; font-size: 8pt; letter-spacing: 1.1pt; text-transform: uppercase;
  color: var(--muted); font-weight: 700;
}
.limit { border-left: 4pt solid var(--tone); background: var(--tone-soft); padding: 5pt 9pt; border-radius: 2pt; }
.limit-head { font-size: 11pt; font-weight: 600; line-height: 1.25; color: var(--tone); }
.limit-basis { font-size: 7.5pt; color: var(--muted); margin-top: 1pt; }

/* Five across, because five short figures read better than five rows. */
.subs { display: flex; gap: 6pt; margin-top: 7pt; }
.sub {
  flex: 1 1 0; border: .5pt solid var(--line); border-top: 2.5pt solid var(--tone);
  border-radius: 3pt; padding: 5pt 7pt 6pt; min-width: 0;
}
.sub-name {
  font-size: 7pt; letter-spacing: .9pt; text-transform: uppercase; color: var(--muted);
  font-weight: 700;
}
.sub-value {
  font-size: 9pt; font-weight: 600; line-height: 1.25; margin-top: 1pt;
  /* Two lines at most: this is a chip, and a third line breaks the strip. */
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.sub-value.none { color: var(--unknown); font-weight: 400; }
.sub-status { margin-top: 4pt; font-size: 7.5pt; font-weight: 600; color: var(--tone); }
.sub-status .dot { width: 5.5pt; height: 5.5pt; margin-right: 3pt; }

/* ---- why it stuttered ---- */
.cause {
  border: 1pt solid var(--line); border-left: 5pt solid var(--tone);
  background: var(--tone-soft); border-radius: 4pt; padding: 8pt 11pt 9pt;
}
.cause h2 {
  margin: 0 0 4pt; font-size: 8pt; letter-spacing: 1.1pt; text-transform: uppercase;
  color: var(--muted); font-weight: 700;
}
.cause-symptom { font-size: 11pt; font-weight: 600; line-height: 1.3; color: var(--tone); }
.cause-symptom em { font-style: normal; color: var(--muted); font-weight: 400; }
/* The letter that ties this to the badge on the frame-rate chart. */
.cause-letter {
  display: inline-block; min-width: 13pt; margin-right: 4pt; padding: 0 3pt;
  border-radius: 2pt; background: #1a1a1a; color: #fff;
  font-size: 8pt; font-weight: 700; text-align: center;
}
/* The figures, set apart from the prose so the eye finds them first. */
.cause-size { font-size: 8.5pt; color: #1f2530; margin-top: 3pt; font-variant-numeric: tabular-nums; }
.cause-with { font-size: 8.5pt; color: #3f4652; margin-top: 3pt; line-height: 1.4; }
.cause-fix { font-size: 8.5pt; color: #3f4652; margin-top: 4pt; line-height: 1.4; }

/* ---- the two panels ---- */
.split { display: flex; gap: 8pt; align-items: stretch; }
.block {
  border: 1pt solid var(--line); border-radius: 4pt; padding: 9pt 12pt 10pt;
  background: #fff;
}
.block h2 {
  margin: 0 0 6pt; font-size: 8pt; letter-spacing: 1.1pt; text-transform: uppercase;
  color: var(--muted); font-weight: 700;
}
.issue { flex: 1.35 1 0; border-left: 5pt solid var(--tone); background: var(--tone-soft); }
.issue-headline {
  font-size: 26pt; font-weight: 700; line-height: 1; letter-spacing: -1.4pt; color: var(--tone);
}
.issue-kind { font-size: 12pt; font-weight: 600; margin-top: 3pt; line-height: 1.2; }
.issue-detail { font-size: 9.5pt; color: var(--muted); margin-top: 1pt; }
.issue-priority {
  display: inline-block; margin-top: 7pt;
  font-size: 8pt; font-weight: 700; letter-spacing: .9pt;
  background: var(--tone); color: #fff; border-radius: 2pt; padding: 2.5pt 7pt;
}
.issue-none, .exp-none { font-size: 12pt; font-weight: 600; color: var(--tone); }

.exp { flex: 1 1 0; }
.exp-facts { margin: 0; padding: 0; list-style: none; }
.exp-facts li {
  font-size: 11pt; font-weight: 600; line-height: 1.5;
  border-bottom: .5pt solid #eef0f3; padding-bottom: 1pt; margin-bottom: 2pt;
}
.exp-facts li:last-child { border-bottom: 0; }
.exp-verdict { margin-top: 6pt; font-size: 10pt; color: var(--tone); }
.exp-verdict strong { font-size: 11pt; letter-spacing: .4pt; }

/* ---- device and session ---- */
.context { display: flex; gap: 8pt; }
.ctx {
  flex: 1; background: var(--panel); border-radius: 3pt; padding: 6pt 10pt;
  font-size: 9pt; color: #3f4652;
}
.ctx-label {
  display: block; font-size: 7.5pt; letter-spacing: 1pt; text-transform: uppercase;
  color: var(--muted); font-weight: 700;
}

/* ---- bottom line ---- */
.bottom { border-top: 1.5pt solid var(--ink); padding-top: 7pt; }
.bottom-label {
  font-size: 8pt; letter-spacing: 1.1pt; text-transform: uppercase; color: var(--muted);
  font-weight: 700; margin-bottom: 2pt;
}
.bottom p { margin: 0; font-size: 11pt; line-height: 1.4; font-weight: 600; max-width: 46em; }

/* ---- footer ---- */
.foot {
  margin-top: 2pt; border-top: .5pt solid var(--line); padding-top: 5pt;
  font-size: 7.5pt; line-height: 1.4; color: var(--muted);
}
.foot strong { color: #3f4652; }
.trace { margin-top: 3pt; }
/*
 * Every heading is ruled.
 *
 * The page is a grid of small blocks, and small-caps grey type on its own is a
 * weak enough signal that a reader has to look twice to see where one block
 * ends and the next begins. A hairline under each heading separates the label
 * from the figure it introduces, and repeated across the page it is what makes
 * the whole thing scan as a dashboard rather than as a list of numbers.
 */
.score-label, .conf-label, .kpi-label, .ctx-label, .bottom-label, .sub-name,
.perf h2, .cause h2, .block h2 {
  display: block;
  border-bottom: .75pt solid var(--line);
  padding-bottom: 2.5pt;
  margin-bottom: 4pt;
}
`;
