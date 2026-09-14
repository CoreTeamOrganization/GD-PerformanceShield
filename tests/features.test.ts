/**
 * What turning the project folder back on must restore.
 *
 * The feature was switched off by one flag rather than deleted, and while it
 * was off the report had to stop *describing* it: no docked confidence for a
 * project nobody was asked for, no static-risk figure that could only be zero.
 * Now that it is on, the mirror image has to hold - the report asks for the
 * project again and says plainly when it was not given - and the console's
 * copy of the flag has to agree, or the field is hidden while the report
 * complains about its absence.
 */
import { readFileSync } from 'node:fs';
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

describe('the project folder while it is on', () => {
  it('is on, which is what every other case here assumes', () => {
    // Written as an assertion rather than a comment: if the flag is turned off
    // again, the expectations below become wrong and should fail loudly rather
    // than quietly testing the other branch.
    expect(FEATURES.projectAnalysis).toBe(true);
  });

  it('is on in the console too, which has its own copy of the flag', () => {
    // app.js is plain browser JavaScript and cannot import features.ts, so the
    // value is duplicated. Flipping one and not the other gives a report that
    // complains about a missing project next to a console that never offered
    // the field.
    const appJs = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
    const mirror = /const FEATURES = \{\s*projectAnalysis:\s*(true|false)/.exec(appJs);

    expect(mirror?.[1]).toBe(String(FEATURES.projectAnalysis));
  });

  it('docks confidence for a project that was asked for and not given', () => {
    const result = score({ ...EMPTY, context: CONTEXT });
    const names = result.confidence.factors.map((f) => f.name);

    expect(names).toContain('Unity project source analyzed');
    expect(names).toContain('Import settings (.meta) available');
    expect(result.confidence.value).toBeLessThan(0.9);
  });

  it('explains the absence of the project in its caveats', () => {
    const result = score({ ...EMPTY, context: CONTEXT });
    const caveats = result.confidence.caveats.join(' ');

    expect(caveats).toMatch(/without the project/i);
  });

  it('reaches full confidence when the project is supplied alongside everything else', () => {
    const result = score({
      ...EMPTY,
      context: {
        ...CONTEXT,
        hasRepository: true,
        hasMetaFiles: true,
        deviceCount: 2,
        cycleCount: 3,
        markerCount: 8,
      },
    });
    expect(result.confidence.value).toBeGreaterThan(0.9);
  });
});
