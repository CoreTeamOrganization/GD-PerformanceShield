/**
 * Features that are built but not currently exposed.
 *
 * A flag rather than deleted code, and a flag in one place rather than a
 * scattering of commented-out blocks, because the point of switching something
 * off temporarily is being able to switch it back on without archaeology.
 * Everything behind a flag here still compiles and is still covered by tests.
 */

export const FEATURES = {
  /**
   * Reading the Unity project alongside the device measurement.
   *
   * On since 2026-09-14 to trial the memory side on real GD games: a measured
   * leak or load spike is traced to the texture, scene or script behind it.
   * Frame-rate drops are not yet linked to code (they are timeline events, not
   * findings, so the correlation step never sees them) - that is the next
   * step, once the memory links have been judged on a few real sessions. It
   * was off before that, at the studio's request, pending a decision about
   * whether the project-side analysis is worth the setup it asks of an
   * operator. Turning it off again is this one value.
   *
   * The setup it asks for is one thing and it is strict: the project must be
   * the code the profiled build came from. The console and the pipeline check
   * the application identifier and version against the installed app (see
   * src/intake/buildMatch.ts) and refuse to correlate across a different
   * package, because a correlation into the wrong project would carry the
   * same confidence as a right one.
   *
   * What it gates:
   *
   *  - the project-folder input and the "analyze code and assets" block
   *  - the static-risk row in the risk breakdown, which is always 0 without a
   *    project and reads as a real score rather than an absent one
   *  - the static findings group
   *  - the caveats and limitations that exist to explain a *missing* project.
   *    Those are the reason the flag reaches the report at all: with the field
   *    hidden there is no project to miss, so telling a reader that causes
   *    "cannot be identified" without it would be reporting the absence of
   *    something the tool never offered them.
   *
   * The pipeline still accepts a `projectPath` when one is passed directly -
   * the CLI takes one, and the analysis behind it is unchanged. This only
   * decides what the console asks for and what the report claims.
   */
  projectAnalysis: true,
} as const;
