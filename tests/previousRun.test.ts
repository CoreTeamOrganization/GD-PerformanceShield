/**
 * The auto-attached previous-run comparison.
 *
 * The rule under test is the contract the report block makes: given an earlier
 * completed analysis of the same game in the workspace, the fresh report gains
 * headline delta rows; given none (first run, other games, unreadable runs),
 * the report is untouched and the run never fails because of the lookup.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, resetConfig } from '../src/core/config.js';
import { attachPreviousRun } from '../src/report/previousRun.js';
import { liveSessionReport } from './fixtures/liveReport.js';

const ROOT = join(tmpdir(), `gdps-prevrun-test-${process.pid}`);

function writeRun(analysisId: string, createdAt: string, report: object): void {
  const dir = join(ROOT, 'prison-riot', analysisId);
  mkdirSync(join(dir, 'metadata'), { recursive: true });
  mkdirSync(join(dir, 'reports'), { recursive: true });
  writeFileSync(
    join(dir, 'metadata', 'job.json'),
    JSON.stringify({
      analysisId,
      gameId: 'prison-riot',
      createdAt,
      updatedAt: createdAt,
      status: 'completed',
      input: { gameName: 'Prison Riot' },
      stages: [],
      toolVersion: '0.1.0',
    }),
  );
  writeFileSync(join(dir, 'reports', 'report.json'), JSON.stringify(report));
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  process.env['GDPS_WORKSPACE_ROOT'] = ROOT;
  resetConfig();
});

afterEach(() => {
  delete process.env['GDPS_WORKSPACE_ROOT'];
  rmSync(ROOT, { recursive: true, force: true });
  resetConfig();
});

describe('attachPreviousRun', () => {
  it('attaches headline rows against the most recent earlier run of the same game', () => {
    const older = liveSessionReport();
    older.analysisId = 'prison-riot_20260901-100000_old001';
    writeRun(older.analysisId, '2026-09-01T10:00:00.000Z', older);

    const current = liveSessionReport();
    current.analysisId = 'prison-riot_20260903-141200_ab12cd';
    writeRun(current.analysisId, '2026-09-03T14:12:00.000Z', current);

    attachPreviousRun(current, loadConfig());

    expect(current.previousRun).toBeDefined();
    expect(current.previousRun!.analysisId).toBe(older.analysisId);
    expect(current.previousRun!.rows.length).toBeGreaterThan(0);
    // Identical sessions must not be called better or worse.
    for (const row of current.previousRun!.rows) {
      expect(['unchanged', 'inconclusive', 'unknown']).toContain(row.direction);
    }
  });

  it('attaches nothing on a first run, and nothing from other games', () => {
    const stranger = liveSessionReport();
    stranger.analysisId = 'other-game_20260901-100000_zz9999';
    stranger.gameId = 'other-game';
    const dir = join(ROOT, 'other-game', stranger.analysisId);
    mkdirSync(join(dir, 'metadata'), { recursive: true });
    mkdirSync(join(dir, 'reports'), { recursive: true });
    writeFileSync(
      join(dir, 'metadata', 'job.json'),
      JSON.stringify({
        analysisId: stranger.analysisId,
        gameId: 'other-game',
        createdAt: '2026-09-01T10:00:00.000Z',
        updatedAt: '2026-09-01T10:00:00.000Z',
        status: 'completed',
        input: { gameName: 'Other Game' },
        stages: [],
        toolVersion: '0.1.0',
      }),
    );
    writeFileSync(join(dir, 'reports', 'report.json'), JSON.stringify(stranger));

    const current = liveSessionReport();
    attachPreviousRun(current, loadConfig());
    expect(current.previousRun).toBeUndefined();
  });

  it('walks past an earlier run whose report is unreadable', () => {
    writeRun('prison-riot_20260830-090000_broken', '2026-08-30T09:00:00.000Z', { nonsense: true });
    const older = liveSessionReport();
    older.analysisId = 'prison-riot_20260829-090000_good01';
    writeRun(older.analysisId, '2026-08-29T09:00:00.000Z', older);

    const current = liveSessionReport();
    attachPreviousRun(current, loadConfig());
    expect(current.previousRun?.analysisId).toBe(older.analysisId);
  });
});
