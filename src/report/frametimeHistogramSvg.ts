/**
 * Frame-time distribution, as an SVG a document can carry.
 *
 * The fps-over-time curve says when the game was slow; this says what the
 * frames themselves looked like - and it is the chart a performance engineer
 * asks for first, because a "20 fps median with a one-second tail" and a
 * "steady 18-22 fps" average to the same number while being entirely different
 * problems. The data is the same present2present histogram the jank counts are
 * derived from, so the chart and the counts can never disagree.
 *
 * Both axes are logarithmic: frame times span 16 ms to a second (two decades)
 * and counts span 1 to thousands. Bars are colored by the same thresholds the
 * jank table uses - within budget, over 83 ms (jank), over 125 ms (severe) -
 * with the thresholds drawn and labeled so the colors never stand alone.
 */

export interface FrametimeHistogramOptions {
  buckets: Array<{ ms: number; count: number }>;
  /** The panel's refresh rate; draws the one-refresh guide when known. */
  displayHz?: number | null;
  width?: number;
  height?: number;
  forPrint?: boolean;
}

const JANK_MS = 83;
const BIG_JANK_MS = 125;

export function renderFrametimeHistogramSvg(opts: FrametimeHistogramOptions): string {
  const buckets = (opts.buckets ?? [])
    .filter((b) => b.count > 0 && b.ms > 0)
    .sort((a, b) => a.ms - b.ms);
  if (buckets.length < 2) return '';

  const width = opts.width ?? 720;
  const height = opts.height ?? 190;
  const pad = { top: 16, right: 30, bottom: 30, left: 42 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const ink = opts.forPrint ? '#1a1a1a' : '#e6edf3';
  const muted = opts.forPrint ? '#6a6a6a' : '#8b949e';
  const grid = opts.forPrint ? '#e6e6e6' : '#30363d';
  const ground = opts.forPrint ? '#ffffff' : '#0e1116';
  const fine = '#4f9cf9';
  const jank = '#d29922';
  const severe = '#cf222e';

  const minMs = buckets[0]!.ms;
  const maxMs = Math.max(buckets[buckets.length - 1]!.ms, BIG_JANK_MS * 1.4);
  const maxCount = Math.max(...buckets.map((b) => b.count));

  const logX = (ms: number) =>
    pad.left + ((Math.log10(ms) - Math.log10(minMs)) / (Math.log10(maxMs) - Math.log10(minMs))) * plotW;
  // Log counts, floored so a single frame still draws a visible bar.
  const barH = (count: number) =>
    Math.max(3, (Math.log10(count + 1) / Math.log10(maxCount + 1)) * plotH);

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" ` +
      `role="img" aria-label="Frame time distribution" ` +
      `style="max-width:${width}px;font-family:system-ui,-apple-system,sans-serif">`,
  );
  out.push(`<rect width="${width}" height="${height}" fill="${ground}"/>`);

  // ---- count gridlines at 1, 10, 100, 1000 -------------------------------
  for (const value of [1, 10, 100, 1000]) {
    if (value > maxCount) break;
    const yy = (pad.top + plotH - barH(value)).toFixed(1);
    out.push(
      `<line x1="${pad.left}" y1="${yy}" x2="${width - pad.right}" y2="${yy}" stroke="${grid}" stroke-width="1"/>`,
    );
    out.push(
      `<text x="${pad.left - 6}" y="${Number(yy) + 3}" text-anchor="end" font-size="9" fill="${muted}">${value}</text>`,
    );
  }

  // ---- threshold guides, labeled so the bar colors never stand alone ------
  const guides: Array<{ ms: number; label: string; color: string }> = [];
  if (opts.displayHz && opts.displayHz > 0) {
    guides.push({ ms: 1000 / opts.displayHz, label: 'refresh', color: muted });
  }
  guides.push({ ms: JANK_MS, label: 'jank 83ms', color: jank });
  guides.push({ ms: BIG_JANK_MS, label: 'severe 125ms', color: severe });
  for (const g of guides) {
    if (g.ms <= minMs || g.ms >= maxMs) continue;
    const xx = logX(g.ms).toFixed(1);
    out.push(
      `<line x1="${xx}" y1="${pad.top}" x2="${xx}" y2="${pad.top + plotH}" ` +
        `stroke="${g.color}" stroke-width="1" stroke-dasharray="3 3"/>`,
    );
    out.push(
      `<text x="${Number(xx) + 3}" y="${pad.top + 8}" font-size="9" fill="${g.color}">${g.label}</text>`,
    );
  }

  // ---- bars, one per histogram bucket -------------------------------------
  for (const bucket of buckets) {
    const h = barH(bucket.count);
    const xx = logX(bucket.ms);
    const color = bucket.ms > BIG_JANK_MS ? severe : bucket.ms > JANK_MS ? jank : fine;
    out.push(
      `<rect x="${(xx - 3).toFixed(1)}" y="${(pad.top + plotH - h).toFixed(1)}" width="6" ` +
        `height="${h.toFixed(1)}" rx="2" fill="${color}">` +
        `<title>${bucket.ms} ms × ${bucket.count} frame${bucket.count === 1 ? '' : 's'}</title></rect>`,
    );
  }

  // ---- x labels at round frame times --------------------------------------
  for (const ms of [16, 33, 66, 125, 250, 500, 1000]) {
    if (ms < minMs || ms > maxMs) continue;
    out.push(
      `<text x="${logX(ms).toFixed(1)}" y="${height - 8}" text-anchor="middle" ` +
        `font-size="9" fill="${muted}">${ms}ms</text>`,
    );
  }
  // Axis note in the top-left corner, clear of the first x label.
  out.push(
    `<text x="${pad.left}" y="${pad.top - 5}" font-size="9" fill="${muted}">frames (log)</text>`,
  );

  out.push('</svg>');
  return out.join('');
}
