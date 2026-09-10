/**
 * Frame rate over time, as an SVG a document can carry.
 *
 * Why a chart and not just an average: a session that held 60 fps and collapsed
 * to 8 twice reads very differently from one that sat at 45 throughout, and both
 * average to about the same number. The shape is the finding.
 *
 * Janks are marked where they happened rather than only totalled, because a
 * stutter that lines up with a memory spike on the timeline above it is one
 * event with two symptoms - which is the whole reason this tool measures both.
 */
const MONO = 'ui-monospace, SFMono-Regular, Consolas, monospace';

export interface FpsPoint {
  elapsedMs: number;
  fps: number;
  janks: number;
}

/**
 * A lettered moment worth pointing at.
 *
 * The letter is the whole point: it lets the prose under the chart say "look at
 * B" and mean the same event as row B of the timeline table and heading B of the
 * detail section. Exactly the device the memory timeline already uses.
 */
export interface FpsChartEvent {
  elapsedMs: number;
  letter: string;
  /**
   * A drop is a fault and is marked as one; a step is context. A `context`
   * event is a labeled moment from outside the curve - an ad opening, leaving
   * for home, coming back - drawn as a guide line rather than a badge, because
   * it is not a finding, it is what explains one.
   */
  kind: 'drop' | 'step' | 'context';
  /** Label for context lines; letters do that job for drops and steps. */
  label?: string;
}

export interface FpsChartOptions {
  points: FpsPoint[];
  /** What the build was aiming for, drawn as the line to judge against. */
  targetFps?: number | null;
  /** The panel's refresh rate, which is the ceiling the hardware allows. */
  displayHz?: number | null;
  /** Lettered drops and level changes, badged on the curve. */
  events?: FpsChartEvent[];
  width?: number;
  height?: number;
  forPrint?: boolean;
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clock(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Render the frame-rate curve.
 *
 * Returns an empty string when there is nothing to draw, so a caller can treat
 * "no chart" and "no measurement" the same way rather than printing an empty
 * frame that reads as a measurement of zero.
 */
export function renderFpsChartSvg(opts: FpsChartOptions): string {
  const points = (opts.points ?? []).filter((p) => Number.isFinite(p.fps));
  if (points.length < 2) return '';

  const width = opts.width ?? 720;
  const height = opts.height ?? 190;
  const pad = { top: 12, right: 12, bottom: 24, left: 42 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const ink = opts.forPrint ? '#1a1a1a' : '#e6edf3';
  const muted = opts.forPrint ? '#6a6a6a' : '#8b949e';
  const grid = opts.forPrint ? '#e6e6e6' : '#30363d';
  const ground = opts.forPrint ? '#ffffff' : '#0e1116';
  const line = '#4f9cf9';
  const bad = '#cf222e';
  const target = '#d29922';

  const maxT = points[points.length - 1]!.elapsedMs || 1;

  // Scale to the ceiling the hardware allows where it is known, so a 30 fps game
  // on a 60 Hz panel visibly sits at half height rather than filling the chart
  // and looking maxed out.
  const observed = Math.max(...points.map((p) => p.fps));
  const ceiling = Math.max(opts.displayHz ?? 0, opts.targetFps ?? 0, observed) * 1.08;
  const maxV = ceiling > 0 ? ceiling : 60;

  const x = (ms: number) => pad.left + (ms / maxT) * plotW;
  const y = (fps: number) => pad.top + plotH - (Math.min(fps, maxV) / maxV) * plotH;

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" ` +
      `role="img" aria-label="Frame rate over the session" ` +
      `style="max-width:${width}px;font-family:system-ui,-apple-system,sans-serif">`,
  );
  out.push(`<rect width="${width}" height="${height}" fill="${ground}"/>`);

  // ---- grid and labels ---------------------------------------------------
  const steps = 3;
  for (let i = 0; i <= steps; i++) {
    const value = (maxV / steps) * i;
    const yy = y(value).toFixed(1);
    out.push(
      `<line x1="${pad.left}" y1="${yy}" x2="${width - pad.right}" y2="${yy}" ` +
        `stroke="${grid}" stroke-width="1"/>`,
    );
    out.push(
      `<text x="${pad.left - 6}" y="${yy}" fill="${muted}" font-size="9" text-anchor="end" ` +
        `dominant-baseline="middle">${Math.round(value)}</text>`,
    );
  }

  // ---- reference lines ---------------------------------------------------
  const reference = (fps: number, label: string, colour: string, dash: string) => {
    if (fps <= 0 || fps > maxV) return;
    const yy = y(fps).toFixed(1);
    out.push(
      `<line x1="${pad.left}" y1="${yy}" x2="${width - pad.right}" y2="${yy}" ` +
        `stroke="${colour}" stroke-width="1.5" stroke-dasharray="${dash}"/>`,
    );
    out.push(
      `<text x="${width - pad.right - 3}" y="${Number(yy) - 3}" fill="${colour}" font-size="9" ` +
        `text-anchor="end">${esc(label)}</text>`,
    );
  };

  if (opts.targetFps) reference(opts.targetFps, `target ${opts.targetFps} fps`, target, '5 4');
  else if (opts.displayHz) reference(opts.displayHz, `screen ${opts.displayHz} Hz`, muted, '3 4');

  // ---- the curve ---------------------------------------------------------
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.elapsedMs).toFixed(1)},${y(p.fps).toFixed(1)}`)
    .join(' ');

  // Filled beneath, so the eye reads height as "how much frame rate there was"
  // rather than having to follow a thin line.
  out.push(
    `<path d="${path} L${x(maxT).toFixed(1)},${(pad.top + plotH).toFixed(1)} ` +
      `L${x(points[0]!.elapsedMs).toFixed(1)},${(pad.top + plotH).toFixed(1)} Z" ` +
      `fill="${line}" fill-opacity="0.18"/>`,
  );
  out.push(`<path d="${path}" fill="none" stroke="${line}" stroke-width="1.6"/>`);

  // ---- janks, where they happened ---------------------------------------
  for (const point of points) {
    if (point.janks <= 0) continue;
    const px = x(point.elapsedMs);
    out.push(
      `<line x1="${px.toFixed(1)}" y1="${pad.top + plotH}" x2="${px.toFixed(1)}" ` +
        `y2="${(pad.top + plotH - 7).toFixed(1)}" stroke="${bad}" stroke-width="2"/>`,
    );
  }

  /*
   * ---- lettered events ---------------------------------------------------
   *
   * Drawn after the curve and the jank ticks so a badge is never hidden behind
   * either, and clamped into the plot so an event in the first or last second
   * still shows its letter rather than half of it.
   *
   * A drop is filled in the warning colour because it is a fault; a step is
   * outlined in the ink colour because it is context - usually the display
   * switching refresh rate, which is not the game's doing. Colouring both the
   * same would put a display setting in the same visual class as a freeze.
   */
  // Context lines first, under the badges: dashed verticals with a small label
  // at the top. Labels alternate between two rows so adjacent events (an ad
  // opening and the return seconds later) do not overwrite each other.
  let contextRow = 0;
  for (const event of opts.events ?? []) {
    if (event.kind !== 'context' || event.elapsedMs > maxT) continue;
    const cx = Math.min(width - pad.right, Math.max(pad.left, x(event.elapsedMs)));
    out.push(
      `<line x1="${cx.toFixed(1)}" y1="${pad.top}" x2="${cx.toFixed(1)}" ` +
        `y2="${pad.top + plotH}" stroke="${muted}" stroke-width="1" stroke-dasharray="2 4"/>`,
    );
    if (event.label) {
      const short = event.label.length > 22 ? `${event.label.slice(0, 21)}…` : event.label;
      const ty = pad.top + 8 + (contextRow % 2) * 10;
      contextRow++;
      const anchor = cx > width - pad.right - 90 ? 'end' : 'start';
      const tx = anchor === 'end' ? cx - 3 : cx + 3;
      out.push(
        `<text x="${tx.toFixed(1)}" y="${ty}" fill="${muted}" font-size="8.5" ` +
          `text-anchor="${anchor}">${esc(short)}</text>`,
      );
    }
  }

  for (const event of opts.events ?? []) {
    if (event.kind === 'context') continue;
    if (!event.letter || event.elapsedMs > maxT) continue;

    const cx = Math.min(width - pad.right - 9, Math.max(pad.left + 9, x(event.elapsedMs)));
    const nearest = points.reduce((best, p) =>
      Math.abs(p.elapsedMs - event.elapsedMs) < Math.abs(best.elapsedMs - event.elapsedMs) ? p : best,
    );
    const cy = Math.max(pad.top + 9, y(nearest.fps) - 13);

    const isDrop = event.kind === 'drop';
    out.push(
      `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="8.5" ` +
        `fill="${isDrop ? bad : ground}" stroke="${isDrop ? ground : ink}" stroke-width="1.5"/>`,
    );
    out.push(
      `<text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" fill="${isDrop ? ground : ink}" ` +
        `font-size="10" font-weight="700" text-anchor="middle" dominant-baseline="central">` +
        `${esc(event.letter)}</text>`,
    );
  }

  // ---- axis --------------------------------------------------------------
  out.push(
    `<line x1="${pad.left}" y1="${pad.top + plotH}" x2="${width - pad.right}" ` +
      `y2="${pad.top + plotH}" stroke="${grid}" stroke-width="1"/>`,
  );
  out.push(`<text x="${pad.left}" y="${height - 7}" fill="${muted}" font-size="9">0:00</text>`);
  out.push(
    `<text x="${width - pad.right}" y="${height - 7}" fill="${muted}" font-size="9" ` +
      `text-anchor="end">${clock(maxT)}</text>`,
  );

  const totalJanks = points.reduce((sum, p) => sum + p.janks, 0);
  out.push(
    `<text x="${(pad.left + width - pad.right) / 2}" y="${height - 7}" fill="${ink}" ` +
      `font-size="9" text-anchor="middle" font-family="${MONO}">` +
      `frames per second${totalJanks > 0 ? ` · red marks = stutter (${totalJanks})` : ''}</text>`,
  );

  out.push('</svg>');
  return out.join('');
}
