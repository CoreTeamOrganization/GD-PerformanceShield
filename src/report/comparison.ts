/**
 * Rendering a session comparison.
 *
 * Written for someone who did not watch either session, so every number says
 * what it measures and every omission says why it is omitted. The hard rule is
 * that a figure the comparison cannot stand behind is not printed as a figure -
 * it is printed as the reason it is missing.
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
  const sign = bytes > 0 ? '+' : '';
  return `${sign}${mb(bytes)}`;
}

/*
 * A tick or a cross, not only a colour. The report is read printed, forwarded
 * and pasted into tickets, and a coloured dot survives none of those as well as
 * a mark does.
 */
const DIRECTION_MARK: Record<string, string> = {
  improved: '✅ better',
  regressed: '❌ worse',
  unchanged: '⚪ same',
  inconclusive: '⚪ within noise',
  unknown: '– not comparable',
};

/** A plain number for a non-byte metric: fps, degrees, percent, a risk score. */
function round(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)} min`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * When a session ran, to the minute.
 *
 * A date alone cannot tell two runs apart, and two runs on the same afternoon is
 * the normal case: record a baseline, change something, record again. Without
 * the time the comparison header describes both runs identically.
 *
 * Formatted by hand rather than through `toLocaleString`, so the same report
 * reads the same wherever it is opened.
 */
function whenLabel(value: string | null): string {
  if (!value) return '\u2014';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function renderComparisonMarkdown(c: SessionComparison): string {
  const out: string[] = [];

  out.push(`# Session comparison — ${c.before.gameName}`);
  out.push('');
  out.push(
    `**${c.before.versionName ?? 'earlier run'}** → **${c.after.versionName ?? 'later run'}** ` +
      `on ${c.after.device} (Android ${c.after.androidVersion})`,
  );
  out.push('');
  out.push(`> ${c.headline}`);
  out.push('');

  // ---- what this compares, before any numbers ----------------------------
  out.push('## What this compares');
  out.push('');
  out.push(
    'Two recorded gameplay sessions of the same app on the same hardware. The comparison joins ' +
      'them **by marked screen**, never by elapsed time: sixty seconds into one playthrough is a ' +
      'different point in the game from sixty seconds into another, so only named game states can ' +
      'be lined up.',
  );
  out.push('');
  out.push('| | Earlier | Later |');
  out.push('| --- | --- | --- |');
  out.push(`| Build | ${c.before.versionName ?? '?'} | ${c.after.versionName ?? '?'} |`);
  // Down to the minute: two runs on the same afternoon is the normal case, and a
  // date alone would describe both identically.
  out.push(
    `| Session ran | ${whenLabel(c.before.startedAt ?? c.before.generatedAt)} | ` +
      `${whenLabel(c.after.startedAt ?? c.after.generatedAt)} |`,
  );
  out.push(
    `| Report written | ${whenLabel(c.before.generatedAt)} | ${whenLabel(c.after.generatedAt)} |`,
  );
  out.push(`| Session length | ${minutes(c.before.durationMs)} | ${minutes(c.after.durationMs)} |`);
  out.push(`| Markers pressed | ${c.before.markerCount} | ${c.after.markerCount} |`);
  out.push('');

  // ---- gates -------------------------------------------------------------
  const blocking = c.gates.filter((g) => g.level === 'block');
  const warnings = c.gates.filter((g) => g.level === 'warn');
  const notes = c.gates.filter((g) => g.level === 'note');

  if (blocking.length > 0) {
    out.push('## These runs cannot be compared');
    out.push('');
    for (const gate of blocking) out.push(`- **${gate.message}**`);
    out.push('');
    out.push(
      'No figures follow. Producing them would mean presenting two incompatible measurements as ' +
        'though one were a change in the other.',
    );
    out.push('');
    return out.join('\n');
  }

  if (warnings.length > 0) {
    out.push('### Read these first');
    out.push('');
    for (const gate of warnings) out.push(`- ⚠️ ${gate.message}`);
    out.push('');
  }
  if (notes.length > 0) {
    for (const gate of notes) out.push(`- ${gate.message}`);
    out.push('');
  }

  // ---- coverage ----------------------------------------------------------
  const { shared, beforeOnly, afterOnly } = c.markerOverlap;
  out.push('### Coverage');
  out.push('');
  out.push(
    `**${shared} screen(s) were visited in both runs** and can be compared. ` +
      `${beforeOnly} were visited only in the earlier run, ${afterOnly} only in the later one.`,
  );
  if (beforeOnly + afterOnly > 0) {
    out.push('');
    out.push(
      'Screens visited in only one run are listed but not compared. To remove the gap, use repeat ' +
        'mode: it replays the earlier session’s marker list as a checklist so both runs cover the ' +
        'same route.',
    );
  }
  out.push('');

  // ---- noise floor -------------------------------------------------------
  out.push('### What counts as a real change');
  out.push('');
  if (c.noiseFloor) {
    out.push(
      `Changes below **${mb(c.noiseFloor.bytes)}** or ` +
        `**${(c.noiseFloor.fraction * 100).toFixed(0)}%** are reported as noise rather than as ` +
        'change. ' +
        c.noiseFloor.source,
    );
  } else {
    out.push(
      '**No noise floor has been established for this device and build.** Every difference is ' +
        'reported at face value, including ones that may be run-to-run variance. To establish one, ' +
        'record the same build twice on this device and compare those two runs — whatever they ' +
        'disagree about is variance by definition.',
    );
  }
  out.push('');

  // ---- the headline outcomes --------------------------------------------
  out.push('## Outcome');
  out.push('');
  out.push('| Measure | Earlier | Later | Change | |');
  out.push('| --- | ---: | ---: | ---: | --- |');
  out.push(
    `| Process kills | ${c.kills.before ?? '—'} | ${c.kills.after ?? '—'} | ` +
      `${c.kills.deltaBytes === null ? '—' : c.kills.deltaBytes > 0 ? `+${c.kills.deltaBytes}` : String(c.kills.deltaBytes)} | ` +
      `${DIRECTION_MARK[c.kills.direction]} |`,
  );
  out.push(
    `| Budget verdict | ${c.budget.before ?? '—'} | ${c.budget.after ?? '—'} | | ` +
      `${DIRECTION_MARK[c.budget.direction]} |`,
  );
  out.push(
    `| Session peak | ${mb(c.peak.before)} | ${mb(c.peak.after)} | ${signedMb(c.peak.deltaBytes)} | ` +
      `${DIRECTION_MARK[c.peak.direction]} |`,
  );
  out.push('');
  if (c.peak.note) out.push(`*Session peak:* ${c.peak.note}`);
  out.push('');

  // ---- runtime: fps, heat, battery, risk ---------------------------------
  if (c.runtime.length > 0) {
    out.push('## Frame rate, heat, battery and risk');
    out.push('');
    out.push(
      'Whole-session figures, so they compare builds only to the extent the two playthroughs were ' +
        'alike. The per-screen table below does not have that limitation.',
    );
    out.push('');
    if (c.runtimeCaveat) {
      out.push(`⚠️ **${c.runtimeCaveat}**`);
      out.push('');
    }
    out.push('| Measure | Earlier | Later | Change | |');
    out.push('| --- | ---: | ---: | ---: | --- |');
    for (const row of c.runtime) {
      const delta =
        row.deltaBytes === null
          ? '—'
          : `${row.deltaBytes > 0 ? '+' : ''}${round(row.deltaBytes)}`;
      out.push(
        `| ${row.label} | ${row.before ?? '—'} | ${row.after ?? '—'} | ${delta} | ` +
          `${DIRECTION_MARK[row.direction]} |`,
      );
    }
    out.push('');

    const noted = c.runtime.filter((r) => r.note);
    for (const row of noted) out.push(`- **${row.label}** — ${row.note}`);
    if (noted.length > 0) out.push('');
  }

  // ---- device -------------------------------------------------------------
  out.push('### Device');
  out.push('');
  out.push('| | Earlier | Later |');
  out.push('| --- | --- | --- |');
  out.push(`| Hardware | ${c.before.device} | ${c.after.device} |`);
  out.push(
    `| RAM | ${c.before.deviceRamBytes !== null ? mb(c.before.deviceRamBytes) : '—'} | ` +
      `${c.after.deviceRamBytes !== null ? mb(c.after.deviceRamBytes) : '—'} |`,
  );
  out.push(`| Android | ${c.before.androidVersion} | ${c.after.androidVersion} |`);
  out.push(`| ABI | ${c.before.abi ?? '—'} | ${c.after.abi ?? '—'} |`);
  out.push(
    `| Session started | ${whenLabel(c.before.startedAt)} | ${whenLabel(c.after.startedAt)} |`,
  );
  out.push('');

  // ---- per screen --------------------------------------------------------
  out.push('## Memory retained per screen');
  out.push('');
  out.push(
    'Retention is what did **not** come back after leaving a screen. It is the most reliable ' +
      'figure here because it is a closed loop — enter, peak, leave — so it does not depend on ' +
      'what the tester did before or after. Retention going up is a regression.',
  );
  out.push('');
  out.push(renderRows(c.screens, 'Screen'));
  out.push('');

  if (c.cycles.length > 0) {
    out.push('## Memory recovered per marked flow');
    out.push('');
    out.push(
      'The same measurement over a marked cycle rather than a single screen — a full loop through ' +
        'a flow and back out.',
    );
    out.push('');
    out.push(renderRows(c.cycles, 'Flow'));
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push(
    '*Every figure is measured on the device by the operating system during real gameplay. ' +
      'Nothing here is estimated or modelled.*',
  );
  out.push('');

  return out.join('\n');
}

function renderRows(rows: MetricChange[], header: string): string {
  if (rows.length === 0) return `*No ${header.toLowerCase()} data in either run.*`;

  const lines = [`| ${header} | Earlier | Later | Change | |`, '| --- | ---: | ---: | ---: | --- |'];

  // Regressions first: the reader is looking for what got worse.
  const order = { regressed: 0, improved: 1, unchanged: 2, inconclusive: 3, unknown: 4 };
  const sorted = [...rows].sort(
    (a, b) =>
      order[a.direction] - order[b.direction] ||
      Math.abs(b.deltaBytes ?? 0) - Math.abs(a.deltaBytes ?? 0),
  );

  for (const row of sorted) {
    lines.push(
      `| ${row.label} | ${mb(row.before)} | ${mb(row.after)} | ${signedMb(row.deltaBytes)} | ` +
        `${DIRECTION_MARK[row.direction]} |`,
    );
  }

  const unmatched = sorted.filter((r) => r.note);
  if (unmatched.length > 0) {
    lines.push('');
    for (const row of unmatched) lines.push(`- **${row.label}** — ${row.note}`);
  }

  return lines.join('\n');
}
