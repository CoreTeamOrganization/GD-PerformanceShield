/**
 * The memory timeline, as an SVG a document can carry.
 *
 * SVG rather than a raster image for three reasons: it needs no rendering
 * dependency, it stays sharp in a PDF at any zoom, and it is text - so a report
 * committed to a repository diffs sensibly instead of turning into a binary blob.
 *
 * Drawn as a stacked area, the same shape and the same category order the live
 * console uses. A reader who watched the session should recognise the picture;
 * a different chart of the same data would make them wonder which was right.
 */
const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Category order and colour, matching the console's stack bottom-to-top. */
const CATEGORIES = [
  { key: 'nativeHeap', label: 'Native Heap', color: '#4f9cf9' },
  { key: 'graphics', label: 'Graphics', color: '#e8863c' },
  { key: 'code', label: 'Code', color: '#a672e0' },
  { key: 'javaHeap', label: 'Java Heap', color: '#3fb950' },
  { key: 'stack', label: 'Stack', color: '#e05c8a' },
  { key: 'privateOther', label: 'Private Other', color: '#8b949e' },
  { key: 'system', label: 'System', color: '#6e7681' },
] as const;

export interface TimelinePoint {
  elapsedMs: number;
  totalBytes: number;
  categories: Record<string, number>;
}

export interface TimelineSvgOptions {
  points: TimelinePoint[];
  /**
   * Lettered peaks, matching the rows in the report's table of memory jumps.
   * The letter is the whole point: it lets prose say "look at B" and mean the
   * same place on the chart and in the table.
   */
  checkpoints?: Array<{ elapsedMs: number; letter: string }>;
  /** Marker lines, so a shape can be tied to what the tester was doing. */
  markers?: Array<{ elapsedMs: number; label: string }>;
  /** Budget lines, which are what the curve is actually judged against. */
  targetBytes?: number | null;
  limitBytes?: number | null;
  width?: number;
  height?: number;
  /** Print-friendly: light ground, darker text, no glow. */
  forPrint?: boolean;
}

function fmt(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function clock(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render the stacked timeline.
 *
 * Returns an empty string when there is nothing to draw, so a caller can treat
 * "no chart" and "no session" the same way rather than embedding an empty frame
 * that looks like a measurement of zero.
 */
export function renderTimelineSvg(opts: TimelineSvgOptions): string {
  const points = opts.points ?? [];
  if (points.length < 2) return '';

  const width = opts.width ?? 720;
  const height = opts.height ?? 260;
  const pad = { top: 14, right: 12, bottom: 26, left: 62 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const ink = opts.forPrint ? '#1a1a1a' : '#e6edf3';
  const muted = opts.forPrint ? '#6a6a6a' : '#8b949e';
  const grid = opts.forPrint ? '#e2e2e2' : '#30363d';
  const ground = opts.forPrint ? '#ffffff' : '#0e1116';

  const maxT = points[points.length - 1]!.elapsedMs || 1;
  const peak = Math.max(...points.map((p) => p.totalBytes));

  // Headroom above the peak, and enough to keep the limit line on the chart -
  // a budget line drawn off the top would be worse than none.
  const ceilingCandidates = [peak * 1.12];
  if (opts.limitBytes) ceilingCandidates.push(opts.limitBytes * 1.04);
  const maxV = Math.max(...ceilingCandidates) || 1;

  const x = (ms: number) => pad.left + (ms / maxT) * plotW;
  const y = (bytes: number) => pad.top + plotH - (bytes / maxV) * plotH;

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
      `width="100%" role="img" aria-label="Memory over the session" ` +
      `style="max-width:${width}px;font-family:system-ui,-apple-system,sans-serif">`,
  );
  out.push(`<rect width="${width}" height="${height}" fill="${ground}"/>`);

  // ---- horizontal grid and value labels ---------------------------------
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const value = (maxV / steps) * i;
    const yy = y(value).toFixed(1);
    out.push(
      `<line x1="${pad.left}" y1="${yy}" x2="${width - pad.right}" y2="${yy}" ` +
        `stroke="${grid}" stroke-width="1"/>`,
    );
    out.push(
      `<text x="${pad.left - 7}" y="${yy}" fill="${muted}" font-size="9.5" ` +
        `text-anchor="end" dominant-baseline="middle">${fmt(value)}</text>`,
    );
  }

  // ---- stacked areas, bottom-up -----------------------------------------
  // Accumulated per point so each band sits on the one below it, which is what
  // makes the top edge the true total rather than seven overlapping shapes.
  const baseline = new Array(points.length).fill(0) as number[];

  for (const category of CATEGORIES) {
    const top = points.map((p, i) => baseline[i]! + (p.categories[category.key] ?? 0));

    const upper = top.map((v, i) => `${x(points[i]!.elapsedMs).toFixed(1)},${y(v).toFixed(1)}`);
    const lower = baseline
      .map((v, i) => `${x(points[i]!.elapsedMs).toFixed(1)},${y(v).toFixed(1)}`)
      .reverse();

    out.push(
      `<polygon points="${[...upper, ...lower].join(' ')}" fill="${category.color}" ` +
        `fill-opacity="${opts.forPrint ? 0.85 : 0.9}"/>`,
    );

    for (let i = 0; i < top.length; i++) baseline[i] = top[i]!;
  }

  // ---- budget lines ------------------------------------------------------
  const budgetLine = (bytes: number, label: string, color: string, dash: string) => {
    if (bytes > maxV) return;
    const yy = y(bytes).toFixed(1);
    out.push(
      `<line x1="${pad.left}" y1="${yy}" x2="${width - pad.right}" y2="${yy}" ` +
        `stroke="${color}" stroke-width="1.5" stroke-dasharray="${dash}"/>`,
    );
    out.push(
      `<text x="${width - pad.right - 4}" y="${Number(yy) - 4}" fill="${color}" ` +
        `font-size="9.5" text-anchor="end">${esc(label)}</text>`,
    );
  };

  if (opts.targetBytes) budgetLine(opts.targetBytes, `target ${fmt(opts.targetBytes)}`, '#d29922', '5 4');
  if (opts.limitBytes) budgetLine(opts.limitBytes, `OS kills near ${fmt(opts.limitBytes)}`, '#f85149', '2 3');

  // ---- operator markers --------------------------------------------------
  for (const marker of opts.markers ?? []) {
    if (marker.elapsedMs > maxT) continue;
    const xx = x(marker.elapsedMs).toFixed(1);
    out.push(
      `<line x1="${xx}" y1="${pad.top}" x2="${xx}" y2="${pad.top + plotH}" ` +
        `stroke="${muted}" stroke-width="1" stroke-dasharray="2 3" opacity="0.75"/>`,
    );
    out.push(
      `<text x="${Number(xx) + 3}" y="${pad.top + 4}" fill="${muted}" font-size="8.5" ` +
        `transform="rotate(90 ${Number(xx) + 3} ${pad.top + 4})">` +
        `${esc(marker.label.slice(0, 22))}</text>`,
    );
  }

  // ---- lettered checkpoints ----------------------------------------------
  // Drawn last so a badge is never hidden behind a band or a marker line, and
  // clamped into the plot so a peak at the very end still shows its letter.
  for (const checkpoint of opts.checkpoints ?? []) {
    if (!checkpoint.letter) continue;
    if (checkpoint.elapsedMs > maxT) continue;

    const cx = Math.min(width - pad.right - 9, Math.max(pad.left + 9, x(checkpoint.elapsedMs)));
    const point =
      points.find((p) => p.elapsedMs === checkpoint.elapsedMs) ??
      points.reduce((best, p) =>
        Math.abs(p.elapsedMs - checkpoint.elapsedMs) < Math.abs(best.elapsedMs - checkpoint.elapsedMs)
          ? p
          : best,
      );
    const cy = Math.max(pad.top + 9, y(Math.min(point.totalBytes, maxV)) - 13);

    out.push(
      `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="8.5" fill="${ink}" ` +
        `stroke="${ground}" stroke-width="1.5"/>`,
    );
    out.push(
      `<text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" fill="${ground}" font-size="10" ` +
        `font-weight="700" text-anchor="middle" dominant-baseline="central">` +
        `${esc(checkpoint.letter)}</text>`,
    );
  }

  // ---- axes --------------------------------------------------------------
  out.push(
    `<line x1="${pad.left}" y1="${pad.top + plotH}" x2="${width - pad.right}" ` +
      `y2="${pad.top + plotH}" stroke="${grid}" stroke-width="1"/>`,
  );
  out.push(
    `<text x="${pad.left}" y="${height - 8}" fill="${muted}" font-size="9.5">00:00</text>`,
  );
  out.push(
    `<text x="${width - pad.right}" y="${height - 8}" fill="${muted}" font-size="9.5" ` +
      `text-anchor="end">${clock(maxT)}</text>`,
  );
  out.push(
    `<text x="${(pad.left + width - pad.right) / 2}" y="${height - 8}" fill="${ink}" ` +
      `font-size="9.5" text-anchor="middle">peak ${fmt(peak)}</text>`,
  );

  out.push('</svg>');
  return out.join('');
}

/** The legend, as its own block so a caller can place it where it fits. */
export function renderTimelineLegend(forPrint = false): string {
  const muted = forPrint ? '#4a4a4a' : '#8b949e';
  const items = CATEGORIES.map(
    (c) =>
      `<span style="display:inline-flex;align-items:center;gap:5px;margin-right:14px;font-size:11px;color:${muted}">` +
      `<span style="width:9px;height:9px;border-radius:2px;background:${c.color};display:inline-block"></span>` +
      `${c.label}</span>`,
  ).join('');

  return `<div style="margin-top:6px;line-height:1.9">${items}</div>`;
}
