/**
 * The session comparison as a print-ready page.
 *
 * Same contract as the analysis report's printable HTML: always light, A4,
 * self-explanatory, and no reference to the tool's own internals - this leaves
 * the machine and is read by people who have never seen the console.
 *
 * The one rule that shapes it: a figure the comparison cannot stand behind is
 * printed as the reason it is missing, never as a number. A blocked comparison
 * prints no figures at all.
 */
import type { MetricChange, SessionComparison } from '../analysis/compareSessions.js';

const MB = 1024 * 1024;

function mb(bytes: number | null): string {
  if (bytes === null) return '—';
  const value = bytes / MB;
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} MB`;
}

function signedMb(bytes: number | null): string {
  if (bytes === null) return '—';
  return `${bytes > 0 ? '+' : ''}${mb(bytes)}`;
}

function num(value: number | null): string {
  if (value === null) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function signedNum(value: number | null): string {
  if (value === null) return '—';
  return `${value > 0 ? '+' : ''}${num(value)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * When a session ran, to the minute.
 *
 * A date alone cannot tell two runs apart, and two runs on the same afternoon is
 * the normal case: record a baseline, change something, record again. Formatted
 * by hand rather than through `toLocaleString`, so the document reads the same
 * wherever it is opened.
 */
function whenLabel(value: string | null): string {
  if (!value) return '—';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/*
 * A mark as well as a word.
 *
 * The colour alone is not enough: the report is read printed and forwarded, and
 * a red chip is indistinguishable from a green one in greyscale or to a reader
 * with red-green colour blindness. The tick and cross survive both.
 */
const CHIP: Record<string, { cls: string; mark: string; text: string }> = {
  improved: { cls: 'ok', mark: '✓', text: 'better' },
  regressed: { cls: 'bad', mark: '✕', text: 'worse' },
  unchanged: { cls: 'flat', mark: '', text: 'same' },
  inconclusive: { cls: 'flat', mark: '', text: 'within noise' },
  unknown: { cls: 'na', mark: '', text: 'not comparable' },
};

function chip(direction: string): string {
  const c = CHIP[direction] ?? CHIP.unknown!;
  return (
    `<span class="chip ${c.cls}">` +
    (c.mark ? `<span class="mark">${c.mark}</span>` : '') +
    `${c.text}</span>`
  );
}

/** Regressions first: the reader is looking for what got worse. */
const ORDER: Record<string, number> = {
  regressed: 0,
  improved: 1,
  unchanged: 2,
  inconclusive: 3,
  unknown: 4,
};

function sortRows(rows: MetricChange[]): MetricChange[] {
  return [...rows].sort(
    (a, b) =>
      (ORDER[a.direction] ?? 9) - (ORDER[b.direction] ?? 9) ||
      Math.abs(b.deltaBytes ?? 0) - Math.abs(a.deltaBytes ?? 0),
  );
}

export interface ComparisonHtmlOptions {
  autoPrint?: boolean;
}

export function renderComparisonHtml(
  c: SessionComparison,
  opts: ComparisonHtmlOptions = {},
): string {
  const title = `Session comparison — ${c.before.gameName}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>${PRINT_CSS}</style>
</head>
<body>
${renderCover(c)}
${c.blocked ? renderBlocked(c) : renderBody(c)}
${renderFooter()}
${opts.autoPrint ? '<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},250)})</script>' : ''}
</body>
</html>`;
}

function renderCover(c: SessionComparison): string {
  return `<section class="cover">
  <div class="eyebrow">Memory comparison of two play sessions</div>
  <h1>${esc(c.before.gameName)}</h1>
  <div class="versus">
    <div class="side">
      <div class="side-label">Earlier</div>
      <div class="side-build">${esc(c.before.versionName ?? 'unknown build')}</div>
      <div class="side-meta">${esc(whenLabel(c.before.startedAt ?? c.before.generatedAt))}</div>
    </div>
    <div class="arrow">→</div>
    <div class="side">
      <div class="side-label">Later</div>
      <div class="side-build">${esc(c.after.versionName ?? 'unknown build')}</div>
      <div class="side-meta">${esc(whenLabel(c.after.startedAt ?? c.after.generatedAt))}</div>
    </div>
  </div>
  <p class="headline">${esc(c.headline)}</p>
</section>`;
}

function renderBlocked(c: SessionComparison): string {
  const reasons = c.gates
    .filter((g) => g.level === 'block')
    .map((g) => `<li>${esc(g.message)}</li>`)
    .join('');

  return `<section class="block">
  <h2>These two sessions cannot be compared</h2>
  <ul class="reasons">${reasons}</ul>
  <p>No figures follow. Printing them would mean presenting two incompatible measurements as
  though one were a change in the other.</p>
</section>`;
}

function renderBody(c: SessionComparison): string {
  return [
    renderMethod(c),
    renderOutcome(c),
    renderRuntime(c),
    renderScreens(c),
    renderDevice(c),
    renderAbout(c),
  ].join('\n');
}

function renderMethod(c: SessionComparison): string {
  const warnings = c.gates
    .filter((g) => g.level === 'warn')
    .map((g) => `<li class="warn">${esc(g.message)}</li>`)
    .join('');
  const notes = c.gates
    .filter((g) => g.level === 'note')
    .map((g) => `<li>${esc(g.message)}</li>`)
    .join('');

  const { shared, beforeOnly, afterOnly } = c.markerOverlap;

  return `<section class="block">
  <h2>How these were compared</h2>
  <p>Two recorded gameplay sessions of the same app on the same hardware. The two runs are matched
  <strong>by the screens the tester marked</strong>, never by elapsed time — sixty seconds into one
  playthrough is a different point in the game from sixty seconds into another, so only named game
  states can be lined up.</p>

  ${warnings || notes ? `<ul class="gates">${warnings}${notes}</ul>` : ''}

  <div class="coverage">
    <strong>${shared} screen(s) visited in both runs</strong> and compared.
    ${beforeOnly} visited only earlier, ${afterOnly} only later.
    ${
      beforeOnly + afterOnly > 0
        ? 'Screens visited in only one run are listed but not compared.'
        : ''
    }
  </div>

  <h3>What counts as a real change</h3>
  ${
    c.noiseFloor
      ? `<p>Differences smaller than <strong>${mb(c.noiseFloor.bytes)}</strong> or
         <strong>${(c.noiseFloor.fraction * 100).toFixed(0)}%</strong> are marked as within noise
         rather than as change. ${esc(c.noiseFloor.source)}</p>`
      : `<p class="callout">No run-to-run variance has been measured for this device and build, so
         every difference below is shown at face value — including any that may be normal variation
         between two plays of the same build. Recording the same build twice and comparing those two
         runs establishes that threshold.</p>`
  }
</section>`;
}

function renderOutcome(c: SessionComparison): string {
  return `<section class="block">
  <h2>Outcome</h2>
  <table>
    <thead><tr><th>Measure</th><th class="num">Earlier</th><th class="num">Later</th>
    <th class="num">Change</th><th></th></tr></thead>
    <tbody>
      <tr><td>Times the system shut the app down</td>
        <td class="num">${c.kills.before ?? '—'}</td>
        <td class="num">${c.kills.after ?? '—'}</td>
        <td class="num">${signedNum(c.kills.deltaBytes)}</td>
        <td>${chip(c.kills.direction)}</td></tr>
      <tr><td>Memory budget verdict</td>
        <td class="num">${esc(c.budget.before ?? '—')}</td>
        <td class="num">${esc(c.budget.after ?? '—')}</td>
        <td class="num"></td>
        <td>${chip(c.budget.direction)}</td></tr>
      <tr><td>Highest memory reached</td>
        <td class="num">${mb(c.peak.before)}</td>
        <td class="num">${mb(c.peak.after)}</td>
        <td class="num">${signedMb(c.peak.deltaBytes)}</td>
        <td>${chip(c.peak.direction)}</td></tr>
    </tbody>
  </table>
  ${c.peak.note ? `<p class="note"><strong>Highest memory:</strong> ${esc(c.peak.note)}</p>` : ''}
</section>`;
}

function renderRuntime(c: SessionComparison): string {
  if (c.runtime.length === 0) return '';

  const rows = sortRows(c.runtime)
    .map(
      (r) =>
        `<tr><td>${esc(r.label)}</td>` +
        `<td class="num">${num(r.before)}</td>` +
        `<td class="num">${num(r.after)}</td>` +
        `<td class="num">${signedNum(r.deltaBytes)}</td>` +
        `<td>${chip(r.direction)}</td></tr>`,
    )
    .join('');

  const notes = c.runtime
    .filter((r) => r.note)
    .map((r) => `<li><strong>${esc(r.label)}</strong> — ${esc(r.note)}</li>`)
    .join('');

  return `<section class="block">
  <h2>Frame rate, heat and battery</h2>
  <p>Figures for each session as a whole. They compare the two builds only to the extent the two
  playthroughs were alike; the per-screen table that follows does not have that limitation.</p>
  ${c.runtimeCaveat ? `<p class="callout"><strong>${esc(c.runtimeCaveat)}</strong></p>` : ''}
  <table>
    <thead><tr><th>Measure</th><th class="num">Earlier</th><th class="num">Later</th>
    <th class="num">Change</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${notes ? `<ul class="notes">${notes}</ul>` : ''}
</section>`;
}

function renderScreens(c: SessionComparison): string {
  const rows = sortRows(c.screens)
    .map(
      (r) =>
        `<tr><td>${esc(r.label)}</td>` +
        `<td class="num">${mb(r.before)}</td>` +
        `<td class="num">${mb(r.after)}</td>` +
        `<td class="num">${signedMb(r.deltaBytes)}</td>` +
        `<td>${chip(r.direction)}</td></tr>`,
    )
    .join('');

  const notes = c.screens
    .filter((r) => r.note)
    .map((r) => `<li><strong>${esc(r.label)}</strong> — ${esc(r.note)}</li>`)
    .join('');

  const cycles =
    c.cycles.length > 0
      ? `<h3>Memory recovered per marked flow</h3>
         <p>The same measurement over a full loop through a flow rather than a single screen.</p>
         <table>
           <thead><tr><th>Flow</th><th class="num">Earlier</th><th class="num">Later</th>
           <th class="num">Change</th><th></th></tr></thead>
           <tbody>${sortRows(c.cycles)
             .map(
               (r) =>
                 `<tr><td>${esc(r.label)}</td><td class="num">${mb(r.before)}</td>` +
                 `<td class="num">${mb(r.after)}</td><td class="num">${signedMb(r.deltaBytes)}</td>` +
                 `<td>${chip(r.direction)}</td></tr>`,
             )
             .join('')}</tbody>
         </table>`
      : '';

  return `<section class="block">
  <h2>Memory left behind on each screen</h2>
  <p>How much memory was <em>not</em> given back after leaving a screen. This is the most dependable
  figure in the comparison, because it is a closed loop — enter the screen, reach its peak, leave —
  and so does not depend on what the tester did before or after. Going up means more was left
  behind than before.</p>
  <table>
    <thead><tr><th>Screen</th><th class="num">Earlier</th><th class="num">Later</th>
    <th class="num">Change</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${notes ? `<ul class="notes">${notes}</ul>` : ''}
  ${cycles}
</section>`;
}

function renderDevice(c: SessionComparison): string {
  return `<section class="block">
  <h2>Where these were recorded</h2>
  <table>
    <thead><tr><th></th><th>Earlier</th><th>Later</th></tr></thead>
    <tbody>
      <tr><td>Phone</td><td>${esc(c.before.device)}</td><td>${esc(c.after.device)}</td></tr>
      <tr><td>Memory fitted</td><td>${mb(c.before.deviceRamBytes)}</td>
        <td>${mb(c.after.deviceRamBytes)}</td></tr>
      <tr><td>Android</td><td>${esc(c.before.androidVersion)}</td>
        <td>${esc(c.after.androidVersion)}</td></tr>
      <tr><td>Processor type</td><td>${esc(c.before.abi ?? '—')}</td>
        <td>${esc(c.after.abi ?? '—')}</td></tr>
      <tr><td>Session ran</td><td>${esc(whenLabel(c.before.startedAt))}</td>
        <td>${esc(whenLabel(c.after.startedAt))}</td></tr>
      <tr><td>Report written</td><td>${esc(whenLabel(c.before.generatedAt))}</td>
        <td>${esc(whenLabel(c.after.generatedAt))}</td></tr>
      <tr><td>Played for</td><td>${Math.round(c.before.durationMs / 60_000)} min</td>
        <td>${Math.round(c.after.durationMs / 60_000)} min</td></tr>
      <tr><td>Points marked during play</td><td>${c.before.markerCount}</td>
        <td>${c.after.markerCount}</td></tr>
    </tbody>
  </table>
</section>`;
}

function renderAbout(c: SessionComparison): string {
  return `<section class="block about">
  <h2>About these figures</h2>
  <p><strong>Everything here was measured on a real phone while a person played the game.</strong>
  Nothing is estimated or modelled. Memory is read from the operating system's own accounting;
  frame rate is counted as frames actually presented to the screen, which is what a player sees.</p>

  <p><strong>Why screens rather than time.</strong> Two people playing the same game do not do the
  same things at the same moments, so comparing "one minute in" against "one minute in" would
  compare unrelated parts of the game. Marking each screen during play gives the two sessions
  something in common to line up.</p>

  <p><strong>What "left behind" means.</strong> A game loads assets for a screen and should release
  them on leaving. Memory still held afterwards accumulates every time a player revisits that
  screen, and is the clearest early sign that a game will eventually be shut down by the phone for
  using too much.</p>

  ${
    c.noiseFloor
      ? ''
      : `<p><strong>One caveat.</strong> Two recordings of the same unchanged build never produce
         identical numbers. Without having measured that normal variation, small differences in this
         document cannot be separated from it — treat the large movements as meaningful and the
         small ones as provisional.</p>`
  }
</section>`;
}

function renderFooter(): string {
  return `<footer>
  <p>Measured on device during real gameplay · generated ${new Date().toISOString().slice(0, 10)}</p>
</footer>`;
}

const PRINT_CSS = `
@page { size: A4; margin: 15mm 14mm; }
* { box-sizing: border-box; }
body {
  font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 10.5pt;
  line-height: 1.55;
  color: #1a1a1a;
  background: #fff;
  margin: 0;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
h1 { font-size: 24pt; margin: 0 0 4px; letter-spacing: -0.4pt; }
h2 { font-size: 14pt; margin: 0 0 8px; padding-bottom: 5px; border-bottom: 2px solid #1a1a1a; }
h3 { font-size: 11.5pt; margin: 14px 0 5px; }
p { margin: 0 0 8px; }
em { font-style: italic; }

.cover { margin-bottom: 22px; }
.eyebrow {
  font-size: 9pt; text-transform: uppercase; letter-spacing: .1em; color: #5a5a5a;
  margin-bottom: 3px;
}
.versus { display: flex; align-items: center; gap: 16px; margin: 14px 0; }
.side { flex: 1; border: 1px solid #d8d8d8; border-radius: 5px; padding: 9px 12px; }
.side-label {
  font-size: 8.5pt; text-transform: uppercase; letter-spacing: .07em; color: #5a5a5a;
}
.side-build { font-size: 15pt; font-weight: 700; line-height: 1.2; }
.side-meta { font-size: 9pt; color: #5a5a5a; }
.arrow { font-size: 18pt; color: #5a5a5a; }
.headline {
  font-size: 12pt; line-height: 1.5; padding: 10px 14px;
  border-left: 3px solid #1a1a1a; background: #f5f5f5; margin: 0;
}

.block { margin-bottom: 20px; break-inside: avoid-page; }
section { break-inside: avoid-page; }

table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 9.5pt; }
th {
  text-align: left; font-size: 8.5pt; text-transform: uppercase; letter-spacing: .05em;
  color: #5a5a5a; padding: 4px 7px; border-bottom: 1.5px solid #1a1a1a;
}
td { padding: 5px 7px; border-bottom: 1px solid #e6e6e6; }
.num { text-align: right; font-variant-numeric: tabular-nums; }

.chip {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 8pt; font-weight: 700; text-transform: uppercase;
  letter-spacing: .04em; padding: 1px 6px; border-radius: 3px; white-space: nowrap;
}
.chip .mark { font-size: 9.5pt; line-height: 1; }
.chip.ok { background: #1a7f37; color: #fff; }
.chip.bad { background: #cf222e; color: #fff; }
.chip.flat { background: #eaeaea; color: #4a4a4a; }
.chip.na { background: #fff; color: #7a7a7a; border: 1px solid #d8d8d8; }

.gates { list-style: none; padding: 0; margin: 8px 0; }
.gates li { font-size: 9.5pt; padding: 2px 0 2px 12px; position: relative; color: #4a4a4a; }
.gates li::before { content: "·"; position: absolute; left: 2px; }
.gates li.warn { color: #9a6700; font-weight: 600; }

.coverage {
  font-size: 9.5pt; padding: 8px 12px; background: #f5f5f5; border-radius: 4px; margin: 8px 0;
}
.callout {
  font-size: 9.5pt; padding: 9px 12px; border-left: 3px solid #9a6700; background: #fdf8ef;
}
.note { font-size: 9pt; color: #5a5a5a; }
.notes { list-style: none; padding: 0; margin: 6px 0; }
.notes li { font-size: 9pt; color: #5a5a5a; padding: 2px 0; line-height: 1.45; }
.reasons { margin: 8px 0 12px; }
.reasons li { font-weight: 600; margin-bottom: 4px; }

.about { border-top: 1px solid #d8d8d8; padding-top: 12px; }
.about p { font-size: 9.5pt; }

footer {
  border-top: 1px solid #d8d8d8; padding-top: 7px; margin-top: 18px;
  font-size: 8.5pt; color: #7a7a7a;
}
footer p { margin: 0; }
`;
