/**
 * Formatting shared by every rendering of a report.
 *
 * Bytes, durations and sentence trimming live here rather than in one renderer
 * that the others import from, because a figure has to read the same in the
 * Markdown cut, the printed page and the summary snapshot. A second copy of
 * `fmt` is a second set of rounding rules, and two documents from one report
 * disagreeing about a number is the one failure a report cannot survive.
 */
import { MB } from '../core/types.js';

/**
 * First N sentences, for the lead cut where full paragraphs are too much.
 *
 * A naive split on `.` mangles this text badly, because it is full of decimals
 * ("85.3 MB"), file names ("hero_atlas.png") and dotted identifiers
 * ("Addressables.Release"). A sentence boundary therefore requires the
 * punctuation to be followed by whitespace and a capital, or by end of text.
 */
export function firstSentences(text: string, count: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();

  // Find where sentences *end* rather than trying to match their bodies: a
  // pattern like `[^.!?]+[.!?]` can never span "85.3", so it would silently
  // start mid-number.
  const boundary = /[.!?]+(?=\s+[A-Z("']|\s*$)/g;
  const ends: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(normalized)) !== null) {
    ends.push(match.index + match[0].length);
  }

  if (ends.length === 0) return normalized;
  const cut = ends[Math.min(count, ends.length) - 1] ?? normalized.length;
  return normalized.slice(0, cut).trim();
}

export function fmt(bytes: number): string {
  const abs = Math.abs(bytes);
  if (abs >= 1024 * MB) return `${(bytes / (1024 * MB)).toFixed(2)} GB`;
  if (abs >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/**
 * Bytes with two decimals, for figures whose whole point is a small change.
 *
 * `fmt` rounds MB to one decimal, which is right for a peak of 867.3 MB and
 * wrong for a start-to-end difference: a session that grew 40 KB and one that
 * grew nothing both render as "0.0 MB". Two decimals resolve to about 10 KB.
 */
export function fmtPrecise(bytes: number): string {
  const abs = Math.abs(bytes);
  if (abs >= 1024 * MB) return `${(bytes / (1024 * MB)).toFixed(3)} GB`;
  if (abs >= MB) return `${(bytes / MB).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
