/**
 * How sure the tool is, in words a reader can act on.
 *
 * Everything downstream of the correlation engine carries a confidence figure
 * between 0 and 1. A bare number is a poor thing to put in a report - 0.72 reads
 * as a measurement when it is a judgement - so it is presented as one of five
 * named levels, and the level is what a reader is asked to weigh.
 *
 * The important rule is the top of the ladder. `confirmed` is reserved for
 * things the tool *observed*, never for anything it inferred: the process was
 * killed, the log carried an out-of-memory line, the frame rate was measured.
 * A coincidence between two timelines, however tight, cannot reach it. Every
 * diagnosis produced by correlation therefore tops out at `high`, which is the
 * honest ceiling for "these two things moved together" - and it keeps the word
 * "confirmed" meaning something when it does appear.
 */

export type ConfidenceLevel = 'confirmed' | 'high' | 'medium' | 'possible' | 'insufficient';

/** What a reader sees. Wording chosen so no level overstates its evidence. */
export const CONFIDENCE_LABEL: Record<ConfidenceLevel, string> = {
  confirmed: 'Confirmed',
  high: 'High confidence',
  medium: 'Medium confidence',
  possible: 'Possible',
  insufficient: 'Insufficient data',
};

/** A one-line gloss, for a footnote or a tooltip. */
export const CONFIDENCE_MEANING: Record<ConfidenceLevel, string> = {
  confirmed: 'Directly observed, not inferred - the event itself was recorded.',
  high: 'Several independent measurements moved together at this moment.',
  medium: 'One strong coincidence, or several weak ones.',
  possible: 'Something lined up, but not enough to rule out chance.',
  insufficient: 'A real symptom, but nothing in the data explains it.',
};

/**
 * Tone for a badge, so the level reads at a glance.
 *
 * `possible` and `insufficient` are neutral rather than alarming: they describe
 * the tool's knowledge, not the severity of the problem, and colouring them red
 * would make weak evidence look like a serious fault.
 */
export const CONFIDENCE_TONE: Record<ConfidenceLevel, 'good' | 'watch' | 'flat'> = {
  confirmed: 'good',
  high: 'good',
  medium: 'watch',
  possible: 'flat',
  insufficient: 'flat',
};

/**
 * Map a 0..1 confidence onto the ladder.
 *
 * The bands are deliberately generous at the bottom and unreachable at the top.
 * `confirmed` is never returned - it cannot be earned by a number, only asserted
 * by a caller that watched the thing happen, via `observed()`.
 */
export function confidenceLevel(value: number): ConfidenceLevel {
  if (!Number.isFinite(value)) return 'insufficient';
  if (value >= 0.85) return 'high';
  if (value >= 0.65) return 'medium';
  if (value >= 0.4) return 'possible';
  return 'insufficient';
}

/** The level for something the tool watched happen rather than inferred. */
export function observed(): ConfidenceLevel {
  return 'confirmed';
}

/** Label straight from a 0..1 figure, for callers that only need the words. */
export function confidenceText(value: number): string {
  return CONFIDENCE_LABEL[confidenceLevel(value)];
}
