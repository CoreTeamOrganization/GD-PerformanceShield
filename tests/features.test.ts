/**
 * What a hidden feature must not leave behind.
 *
 * The Unity project folder is switched off by a single flag rather than deleted,
 * so the risk is not that it stops working - it is that the report keeps
 * *describing* it. A run with no project used to say the project was missing,
 * that causes could not be identified, and that two stages were skipped for
 * want of it: all true, and all about an input the operator was never offered.
 *
 * These pin the two halves that are easy to get wrong: the confidence score
 * must not be docked for an absence that is now by design, and the report must
 * not carry a static-risk figure that can only ever be zero.
 */
import { describe, expect, it } from 'vitest';

import { FEATURES } from '../src/core/features.js';
import { score } from '../src/analysis/scoring.js';

const CONTEXT = {
  hasRepository: false,
  hasApk: true,
  hasMetaFiles: false,
  liveSessionRan: true,
  deviceCount: 1,
  sessionDurationMs: 180_000,
  cycleCount: 1,
  markerCount: 4,
};

const EMPTY = { staticFindings: [], liveFindings: [], correlatedFindings: [] };

describe('the project folder while it is hidden', () => {
  it('is off, which is what every other case here assumes', () => {
    // Written as an assertion rather than a comment: if the flag is turned back
    // on, the expectations below become wrong and should fail loudly rather
    // than quietly testing the other branch.
    expect(FEATURES.projectAnalysis).toBe(false);
  });

  it('does not dock confidence for a project nobody was asked for', () => {
    const result = score({ ...EMPTY, context: CONTEXT });
    const names = result.confidence.factors.map((f) => f.name);

    expect(names).not.toContain('Unity project source analyzed');
    expect(names).not.toContain('Import settings (.meta) available');
  });

  it('still reports the confidence factors that have nothing to do with the project', () => {
    // The guard has to remove two factors, not the list.
    const result = score({ ...EMPTY, context: CONTEXT });
    expect(result.confidence.factors.length).toBeGreaterThan(0);
    expect(result.confidence.value).toBeGreaterThan(0);
  });

  it('does not explain the absence of the project in its caveats', () => {
    const result = score({ ...EMPTY, context: CONTEXT });
    const caveats = result.confidence.caveats.join(' ');

    expect(caveats).not.toMatch(/without the project/i);
    expect(caveats).not.toMatch(/causes cannot be identified/i);
  });

  it('reaches full confidence on the inputs it does ask for', () => {
    /*
     * The point of dropping the factors rather than marking them present: with
     * the project-side weights gone, a session that captured everything the
     * console offers should score as complete. Leaving them in as "missing"
     * capped every possible run at 0.7 and made a good session look partial.
     */
    const result = score({
      ...EMPTY,
      context: { ...CONTEXT, deviceCount: 2, cycleCount: 3, markerCount: 8 },
    });
    expect(result.confidence.value).toBeGreaterThan(0.9);
  });
});
