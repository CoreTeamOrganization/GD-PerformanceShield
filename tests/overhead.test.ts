/**
 * Measurement must not create what it measures.
 *
 * These tests exist because the tool was reporting stutter it had caused. On a
 * vivo V2111 running a Unity game at ~46 fps, a minute left completely alone
 * produced 0 janks and 2765 frames; the same minute while the tool polled
 * produced 8 janks, a 250 ms "longest frame" and 12.4% fewer frames. Two probes
 * were also returning nothing at all without ever reporting a failure. After the
 * fixes below the same minute measured 0 janks, a 34 ms longest frame - matching
 * the undisturbed baseline exactly - and no measurable frame loss.
 */
import { describe, expect, it } from 'vitest';

import type { AdbDevice } from '../src/devices/adb.js';
import { FpsSampler, summarizeFrames } from '../src/telemetry/fps.js';
import { DumpsysMeminfoProbe, ProcStatusProbe, parseMeminfo } from '../src/telemetry/probes.js';
import { summarizeFps, summarizeThermal } from '../src/telemetry/deviceHealth.js';
import { buildDeviceTimeline } from '../src/analysis/timeline.js';
import type { MemorySample } from '../src/telemetry/types.js';

const MB = 1024 * 1024;

/**
 * A device that records what was asked and replies from a script.
 *
 * `script` is modelled the way adb really behaves: it hands one string to the
 * device's shell. `shell` joins its argv with spaces, which is also what adb
 * does - and is exactly why `shell(['sh', '-c', script])` used to fail.
 */
function recordingDevice(answers: Array<(cmd: string) => string | null>) {
  const asked: string[] = [];
  let turn = 0;
  const reply = (cmd: string) => {
    asked.push(cmd);
    for (const answer of answers) {
      const out = answer(cmd);
      if (out !== null) return { code: 0, stdout: out, stderr: '' };
    }
    return { code: 1, stdout: '', stderr: '' };
  };
  const device = {
    serial: 'TEST',
    async shell(command: string[]) {
      turn++;
      return reply(command.join(' '));
    },
    async script(text: string) {
      turn++;
      return reply(text);
    },
  } as unknown as AdbDevice;
  return { device, asked, turns: () => turn };
}

/** A layer section with a cumulative frame count and one histogram. */
function timeStatsDump(totalFrames: number, buckets: Record<number, number>): string {
  const all = Object.entries(buckets)
    .map(([ms, count]) => `${ms}ms=${count}`)
    .join(' ');
  return [
    'SurfaceFlinger TimeStats:',
    'displayConfigStats is as below:',
    '60.00fps=10000ms',
    'layerName = SurfaceView[com.example.game/com.unity3d.player.UnityPlayerActivity](BLAST)#0',
    `totalFrames = ${totalFrames}`,
    'droppedFrames = 0',
    'averageFPS = 60.000',
    'present2present histogram is as below:',
    all,
  ].join('\n');
}

describe('the fast tier actually returns a reading', () => {
  it('reads /proc/<pid>/status through one script, not through sh -c', async () => {
    // `shell(['sh', '-c', 'cat FILE; echo ---; cat OTHER'])` reaches the device
    // as `sh -c cat FILE; echo ---; cat OTHER`, because adb joins argv with
    // spaces before the device shell parses it. That runs `cat` with no
    // arguments: it reads stdin, gets EOF, and prints nothing. The probe saw an
    // empty file rather than an error, so VmRSS never parsed and every sample
    // returned null - silently, for the whole session.
    const status = [
      'Name:\tunity.game',
      'VmRSS:\t  501064 kB',
      'RssAnon:\t  373716 kB',
      'VmSwap:\t   12116 kB',
    ].join('\n');

    const { device, asked } = recordingDevice([
      (cmd) => (cmd.includes('/proc/4242/status') ? `${status}\n---\n0\n` : null),
    ]);

    const reading = await new ProcStatusProbe().sample(device, 4242);

    expect(reading).not.toBeNull();
    expect(reading?.rssBytes).toBe(501064 * 1024);
    expect(reading?.swapPssBytes).toBe(12116 * 1024);
    // One round trip, and no `sh -c` in it.
    expect(asked).toHaveLength(1);
    expect(asked[0]).not.toContain('sh -c');
  });
});

describe('the deep tier does not stop the game to measure it', () => {
  it('asks for a local dump, so dumpsys never calls into the app', async () => {
    // Without `--local`, dumpsys makes a binder call into the game and waits for
    // it to report its own Java heap. That took 780 ms of device work on a
    // five-second cadence - 15% of the session with the game stopped - and it
    // was manufacturing about eight janks a minute.
    const { device, asked } = recordingDevice([() => ' App Summary\n  TOTAL PSS:  1000\n']);
    await new DumpsysMeminfoProbe().sample(device, 4242);
    expect(asked[0]).toBe('dumpsys meminfo --local 4242');
  });

  it('reads a local dump even though it has no Objects block to stop at', () => {
    // A local dump ends after the summary. The parser used `Objects` to know
    // where the summary finished, so the absence of it must not lose the rows.
    const local = [
      ' App Summary',
      '                       Pss(KB)                        Rss(KB)',
      '                        ------                         ------',
      '           Java Heap:    27116                          44352',
      '         Native Heap:    54312                          55828',
      '            Graphics:   238422                         238422',
      '           TOTAL PSS:   625679            TOTAL RSS:   718822       TOTAL SWAP PSS:    27741',
    ].join('\n');

    const reading = parseMeminfo(local);

    expect(reading?.pssBytes).toBe(625679 * 1024);
    expect(reading?.summary?.javaHeap).toBe(27116 * 1024);
    expect(reading?.summary?.graphics).toBe(238422 * 1024);
  });
});

describe('a frame window is a difference, not a reset', () => {
  it('reports only the frames drawn since the previous read', async () => {
    // Clearing TimeStats every second cost a second SurfaceFlinger call per
    // sample and threw away every frame that landed between the dump and the
    // clear. Diffing the cumulative counters needs one call and drops nothing.
    const dumps = [
      timeStatsDump(100, { 16: 100 }), // prepare: baseline
      timeStatsDump(160, { 16: 150, 33: 10 }), // +60 frames
      timeStatsDump(230, { 16: 210, 33: 20 }), // +70 frames
    ];
    let i = 0;
    const { device, asked } = recordingDevice([
      (cmd) => (cmd.includes('-dump') ? (dumps[Math.min(i++, dumps.length - 1)] ?? '') : ''),
    ]);

    const sampler = new FpsSampler(device, 'com.example.game');
    expect(await sampler.prepare()).toBe('timestats');

    const first = await sampler.sample();
    expect(first?.frameCount).toBe(60);
    // 50 more at 16 ms and 10 at 33 ms - the buckets are differences too, so a
    // window's jank count is its own and not the session's running total.
    expect(first?.frames?.frameCount).toBe(60);

    const second = await sampler.sample();
    expect(second?.frameCount).toBe(70);
    expect(second?.frames?.frameCount).toBe(70);

    // Never cleared after the initial baseline: one call per window.
    expect(asked.filter((c) => c.includes('-clear'))).toHaveLength(1);
  });

  it('skips a window rather than reporting nonsense when the counters reset', async () => {
    // SurfaceFlinger resets its stats, and a layer is recreated on an
    // orientation change or when the game reloads its surface. Subtracting
    // across that would give a negative frame count.
    const dumps = [
      timeStatsDump(100, { 16: 100 }),
      timeStatsDump(160, { 16: 160 }),
      timeStatsDump(12, { 16: 12 }), // reset
      timeStatsDump(70, { 16: 70 }),
    ];
    let i = 0;
    const { device } = recordingDevice([
      (cmd) => (cmd.includes('-dump') ? (dumps[Math.min(i++, dumps.length - 1)] ?? '') : ''),
    ]);

    const sampler = new FpsSampler(device, 'com.example.game');
    await sampler.prepare();

    expect((await sampler.sample())?.frameCount).toBe(60);
    // The reset itself reports nothing rather than -148 frames.
    expect(await sampler.sample()).toBeNull();
    // And counting picks up again from the new baseline.
    expect((await sampler.sample())?.frameCount).toBe(58);
  });

  it('does not count the frames drawn before the first window', async () => {
    // TimeStats counts from whenever it was enabled. Without a baseline at
    // prepare time the first sample would report every frame since then as
    // though it belonged to one second.
    const dumps = [timeStatsDump(5000, { 16: 5000 }), timeStatsDump(5050, { 16: 5050 })];
    let i = 0;
    const { device } = recordingDevice([
      (cmd) => (cmd.includes('-dump') ? (dumps[Math.min(i++, dumps.length - 1)] ?? '') : ''),
    ]);

    const sampler = new FpsSampler(device, 'com.example.game');
    await sampler.prepare();

    expect((await sampler.sample())?.frameCount).toBe(50);
  });
});

describe('the two tiers do not contaminate each other', () => {
  it('keeps deep-tier RSS out of the high-resolution series', () => {
    // Both tiers report an `rssBytes`, but they are not the same measurement:
    // the fast tier reads VmRSS from /proc/<pid>/status, and the deep tier takes
    // TOTAL RSS from dumpsys meminfo, which counts graphics the kernel does not
    // attribute to the process. Measured together on one handset: 501 MB and
    // 723 MB at the same instant. This only became reachable when the fast tier
    // started returning readings at all - before that the series was pure deep
    // tier and self-consistent by accident.
    const samples: MemorySample[] = [
      { t: 0, elapsedMs: 0, serial: 'S', role: 'A', tier: 'deep', pssBytes: 626 * MB, rssBytes: 723 * MB, swapPssBytes: null },
      { t: 1000, elapsedMs: 1000, serial: 'S', role: 'A', tier: 'fast', pssBytes: null, rssBytes: 501 * MB, swapPssBytes: null },
      { t: 2000, elapsedMs: 2000, serial: 'S', role: 'A', tier: 'fast', pssBytes: null, rssBytes: 503 * MB, swapPssBytes: null },
    ];

    const timeline = buildDeviceTimeline('S', 'A', samples);

    // Only the two fast readings, so the series cannot sawtooth by 220 MB.
    expect(timeline.rss.map((p) => p.value)).toEqual([501 * MB, 503 * MB]);
    expect(timeline.pss.map((p) => p.value)).toEqual([626 * MB]);
  });

  it('still prefers PSS when it has the resolution to describe the shape', () => {
    const samples: MemorySample[] = Array.from({ length: 6 }, (_, i) => ({
      t: i * 5000,
      elapsedMs: i * 5000,
      serial: 'S',
      role: 'A',
      tier: 'deep' as const,
      pssBytes: (600 + i) * MB,
      rssBytes: (720 + i) * MB,
      swapPssBytes: null,
    }));

    const timeline = buildDeviceTimeline('S', 'A', samples);

    expect(timeline.primaryMetric).toBe('pss');
    // No fast samples at all, so the high-resolution series is simply empty
    // rather than quietly filled with the other tier's numbers.
    expect(timeline.rss).toEqual([]);
  });
});

describe('a missed refresh means a dropped frame, not bucket jitter', () => {
  // The real distribution from a 177-second session on a 60 Hz vivo V2111:
  // cleanly quantised to the vsync, with nothing between 17 ms and 33 ms.
  const REAL_SESSION = [
    { ms: 16, count: 2203 },
    { ms: 17, count: 1521 },
    { ms: 33, count: 1615 },
    { ms: 34, count: 928 },
    { ms: 50, count: 108 },
    { ms: 54, count: 21 },
    { ms: 66, count: 4 },
    { ms: 86, count: 43 },
    { ms: 1000, count: 3 },
  ];

  it('does not count a frame that hit its vsync', () => {
    // A 60 Hz vsync is 16.67 ms and the buckets are whole milliseconds, so an
    // on-time frame lands at 16 or 17 depending on jitter. Both are on vsync.
    const stats = summarizeFrames(REAL_SESSION, 60);
    const onVsync = 2203 + 1521;
    const total = REAL_SESSION.reduce((a, b) => a + b.count, 0);

    expect(stats.smallJanks).toBe(total - onVsync);
    // Not 4284, which is what comparing against 16.67 reported - 55% high, and
    // it would tell a game holding 60 fps that it missed a third of its
    // refreshes.
    expect(stats.smallJanks).toBeLessThan(4284);
  });

  it('still counts a frame that took two refreshes', () => {
    const stats = summarizeFrames([{ ms: 16, count: 100 }, { ms: 33, count: 10 }], 60);
    expect(stats.smallJanks).toBe(10);
  });

  it('scales the margin with the panel, not with 60 Hz', () => {
    // At 120 Hz the budget is 8.3 ms, so a 16 ms frame has genuinely missed one.
    expect(summarizeFrames([{ ms: 16, count: 50 }], 120).smallJanks).toBe(50);
    expect(summarizeFrames([{ ms: 16, count: 50 }], 60).smallJanks).toBe(0);
  });
});

describe('judging a session against the right numbers', () => {
  it('takes the refresh rate the session mostly ran at', () => {
    // A Galaxy A36 reported 30 Hz for the first four windows while the game was
    // starting, then 60 Hz for the remaining 138. Taking the first reading
    // judged every frame against a 33 ms budget instead of 17 ms, and a game
    // holding a solid 60 fps was told it had missed almost no refreshes.
    const window = (fps: number, displayHz: number) => ({
      fps,
      displayHz,
      matchesDisplayRate: null,
      frames: summarizeFrames([{ ms: 16, count: 60 }], displayHz),
      frameCount: 60,
      windowMs: 1000,
      jankPercent: null,
      worstFrameMs: null,
      source: 'timestats',
    });

    const summary = summarizeFps(
      [...Array.from({ length: 4 }, () => window(30, 30)),
       ...Array.from({ length: 138 }, () => window(60, 60))],
      142_000,
    );

    expect(summary.displayHz).toBe(60);
  });

  it('reports the battery temperature, not the hottest chip', () => {
    // Both are real, but a CPU die at 62 °C is ordinary and a phone at 62 °C is
    // not - and the battery sensor is the only one that means the same thing on
    // every handset, so it is the only one comparable between runs or tools.
    const summary = summarizeThermal([
      { elapsedMs: 0, battery: { temperatureC: 34.5, levelPercent: 80, isCharging: true }, thermal: { maxZoneC: 62.3, maxZoneName: 'cpu-0-0', status: 'none', throttling: false } },
      { elapsedMs: 60_000, battery: { temperatureC: 35, levelPercent: 78, isCharging: true }, thermal: { maxZoneC: 48, maxZoneName: 'cpu-0-0', status: 'none', throttling: false } },
    ] as never);

    expect(summary.startC).toBe(34.5);
    expect(summary.endC).toBe(35);
    expect(summary.peakC).toBe(35);
    // A half-degree rise over a minute of play is not a hot phone.
    expect(summary.verdict).toBe('cool');
    // The chip is still reported, just not as the device's temperature.
    expect(summary.hottestZone).toBe('cpu-0-0');
  });
});

describe('the percentile ladder, as the in-game recorder defines it', () => {
  const sample = (fps: number) => ({
    fps,
    displayHz: 60,
    matchesDisplayRate: null,
    frameCount: Math.round(fps),
    windowMs: 1000,
    jankPercent: null,
    worstFrameMs: null,
    source: 'timestats',
  });

  it('reports a rate the game actually ran at, never one between two samples', () => {
    /*
     * GDPerfTracker indexes the sorted samples rather than interpolating:
     *
     *     index = Clamp(RoundToInt((count - 1) * p), 0, count - 1)
     *
     * so every published figure is a second that happened, which is the point.
     * This test used to assert a nearest-rank index and its comment claimed
     * that was the recorder's formula - it is not, and the two pick a different
     * sample for about half of all sample counts. See tests/fpsPercentile.test.ts,
     * which pins the tool to the transcribed C# across 1..400 samples.
     *
     * On 100 samples of 1..100 the recorder's indices are 1, 50 and 98.
     */
    const summary = summarizeFps(
      Array.from({ length: 100 }, (_, i) => sample(i + 1)),
      100_000,
    );

    expect(summary.percentiles).not.toBeNull();
    expect(summary.percentiles!.p01).toBe(2);
    expect(summary.percentiles!.p50).toBe(51);
    // Not 100 - "best sustained" still excludes the single best second.
    expect(summary.percentiles!.p99).toBe(99);
  });

  it('separates the 1% low of seconds from the 1% low of frames', () => {
    // Both are called "1% low" and they are not the same measurement. On one
    // real session the worst 1% of frames averaged 5.2 fps while the 1st
    // percentile of seconds was 20 - a single 700 ms freeze against a whole
    // second of slow play. Reporting one as the other reads as a discrepancy
    // between tools where there is none.
    const summary = summarizeFps(
      [
        ...Array.from({ length: 99 }, () => sample(60)),
        { ...sample(20), frames: summarizeFrames([{ ms: 16, count: 19 }, { ms: 700, count: 1 }], 60) },
      ],
      100_000,
    );

    /*
     * 100 samples, 99 of them at 60 fps and the single bad second at 20. The
     * recorder's p01 index is RoundToInt(99 * 0.01) = 1, which on the sorted
     * list is the second-worst second - so the ladder reads 60 and the one bad
     * second does not appear in it at all.
     *
     * That is not a bug being enshrined: it is what the in-game recorder
     * reports for this data, and the two agreeing is the whole point of this
     * ladder. The figure that does see a single bad moment is the frame-based
     * one below, which is why both are published.
     */
    expect(summary.percentiles!.p01).toBe(60);
    // The frame-based figure sees the 700 ms frame; the second-based one cannot.
    expect(summary.low1PercentFps).toBeLessThan(60);
  });

  it('holds the ladder in order', () => {
    const summary = summarizeFps(
      Array.from({ length: 50 }, (_, i) => sample(10 + i)),
      50_000,
    );
    const p = summary.percentiles!;
    expect(p.p01).toBeLessThanOrEqual(p.p05);
    expect(p.p05).toBeLessThanOrEqual(p.p25);
    expect(p.p25).toBeLessThanOrEqual(p.p50);
    expect(p.p50).toBeLessThanOrEqual(p.p75);
    expect(p.p75).toBeLessThanOrEqual(p.p95);
    expect(p.p95).toBeLessThanOrEqual(p.p99);
  });

  it('reports nothing rather than zero when nothing was sampled', () => {
    expect(summarizeFps([], 0).percentiles).toBeNull();
  });
});
