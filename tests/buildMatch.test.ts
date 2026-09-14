/**
 * Same-build check.
 *
 * A correlated finding says "measured on a real device, and the project
 * contains a matching cause" and then names a file. That sentence is only true
 * when the project is the source of the build on the phone, and the pipeline
 * cannot see the commit, so these pin the two things it can see - identifier
 * and version - and the one verdict that has to stop the correlation.
 */
import { describe, expect, it } from 'vitest';

import { assessBuildMatch } from '../src/intake/buildMatch.js';

const PROJECT = { bundleIdentifier: 'com.gd.puzzle', bundleVersion: '2.3.0' };

describe('assessBuildMatch', () => {
  it('confirms identifier and version when both agree, and still says the commit is unverified', () => {
    const m = assessBuildMatch(PROJECT, { packageName: 'com.gd.puzzle', versionName: '2.3.0' });

    expect(m.verdict).toBe('match');
    expect(m.correlationSafe).toBe(true);
    // Necessary, never sufficient: the operator must not read "match" as proof.
    expect(m.message).toMatch(/commit/i);
  });

  it('refuses to correlate across a different package', () => {
    // The one case where a correlation would be fiction rather than a guess:
    // a leak on one game traced to a texture in another game's project.
    const m = assessBuildMatch(PROJECT, { packageName: 'com.gd.racer', versionName: '2.3.0' });

    expect(m.verdict).toBe('identifier_differs');
    expect(m.correlationSafe).toBe(false);
    expect(m.message).toContain('com.gd.puzzle');
    expect(m.message).toContain('com.gd.racer');
  });

  it('warns, but still correlates, when only the version differs', () => {
    // Same project three commits on is the common field case and mostly still
    // right, so it is a caveat in the report rather than a skipped stage.
    const m = assessBuildMatch(PROJECT, { packageName: 'com.gd.puzzle', versionName: '2.2.1' });

    expect(m.verdict).toBe('version_differs');
    expect(m.correlationSafe).toBe(true);
    expect(m.message).toContain('2.3.0');
    expect(m.message).toContain('2.2.1');
  });

  it('does not call a missing version a mismatch', () => {
    // No APK was inspected, so the installed version is unknown: that is an
    // absent comparison, not a failed one.
    const m = assessBuildMatch(PROJECT, { packageName: 'com.gd.puzzle', versionName: null });

    expect(m.verdict).toBe('match');
  });

  it('says it could not check when the project states no identifier', () => {
    const m = assessBuildMatch(
      { bundleIdentifier: null, bundleVersion: null },
      { packageName: 'com.gd.puzzle', versionName: '1.0' },
    );

    expect(m.verdict).toBe('unknown');
    expect(m.correlationSafe).toBe(true);
    expect(m.message).toMatch(/could not be checked/);
  });

  it('ignores surrounding whitespace, which Unity YAML sometimes leaves', () => {
    const m = assessBuildMatch(
      { bundleIdentifier: ' com.gd.puzzle ', bundleVersion: '2.3.0 ' },
      { packageName: 'com.gd.puzzle', versionName: '2.3.0' },
    );

    expect(m.verdict).toBe('match');
  });
});
