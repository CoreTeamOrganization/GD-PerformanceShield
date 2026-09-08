/**
 * Following the surface that is actually drawing.
 *
 * A Unity game does not keep one surface for a whole session: showing an
 * interstitial, or leaving the splash screen, destroys the SurfaceView and
 * creates another with a new id. The old layer stays in the TimeStats dump with
 * its counters frozen at whatever they reached.
 *
 * The sampler used to pin the first layer it saw. `prepare()` normally runs
 * before the game has drawn anything - the process has only just started - so
 * the pin landed on an early surface, and after the swap every window was a
 * zero difference against a dead layer. Observed on a real three-minute
 * session: the frame rate read null the whole way through while the game ran
 * visibly at 60 fps, and the only clue was a diagnostic still claiming it was
 * waiting for the game to draw.
 */
import { describe, expect, it } from 'vitest';

import { FpsSampler } from '../src/telemetry/fps.js';
import type { AdbDevice } from '../src/devices/adb.js';

const PKG = 'com.studio.game';

/** One layer's TimeStats block, in the shape Android 14+ prints. */
function layerBlock(id: string, totalFrames: number, present: Array<[number, number]>): string {
  return [
    `layerName = abc${id} SurfaceView[${PKG}/com.unity3d.player.UnityPlayerActivity]@0(BLAST)#${id}`,
    'packageName = ',
    'gameMode = standard',
    `totalFrames = ${totalFrames}`,
    'droppedFrames = 0',
    'lateAcquireFrames = 0',
    'badDesiredPresentFrames = 0',
    'averageFPS = 60.000',
    'present2present histogram is as below:',
    present.map(([ms, count]) => `${ms}ms=${count}`).join(' ') || '16ms=0',
  ].join('\n');
}

function dumpOf(...blocks: string[]): string {
  return [
    'SurfaceFlinger TimeStats:',
    'Legacy stats are as follows:',
    'displayRefreshRate = 60 fps',
    'renderRate = 60 fps',
    ...blocks,
  ].join('\n');
}

/**
 * A device that returns each queued dump in turn.
 *
 * Only the TimeStats calls matter; everything else answers success with empty
 * output, which is enough for the sampler to select TimeStats and stay there.
 */
function deviceReturning(dumps: string[]): AdbDevice {
  let i = 0;
  return {
    serial: 'TEST',
    async shell(command: string[]) {
      const key = command.join(' ');
      if (key.includes('--timestats') && key.includes('-dump')) {
        const out = dumps[Math.min(i, dumps.length - 1)] ?? '';
        i++;
        return { code: 0, stdout: out, stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  } as unknown as AdbDevice;
}

describe('a surface swap mid-session', () => {
  it('keeps measuring after the game replaces its SurfaceView', async () => {
    /*
     * The exact failing sequence:
     *   prepare  - no layer at all, the game has not drawn
     *   read 1   - the early surface exists; taken as a baseline
     *   read 2   - the early surface has gone quiet, a new one is drawing
     *   read 3   - the new surface is still drawing
     */
    const early = (frames: number) => layerBlock('111', frames, [[16, frames]]);
    const fresh = (frames: number) => layerBlock('222', frames, [[16, frames]]);

    const device = deviceReturning([
      dumpOf(), // prepare: no layers
      dumpOf(early(100)), // read 1: baseline on the early surface
      dumpOf(early(100), fresh(60)), // read 2: early frozen, new one appears
      dumpOf(early(100), fresh(120)), // read 3: 60 more frames on the new one
    ]);

    const sampler = new FpsSampler(device, PKG);
    expect(await sampler.prepare()).toBe('timestats');

    // Nothing yet: a first sighting is a baseline, not a measurement.
    expect(await sampler.sample()).toBeNull();
    // The new surface is also only a baseline on the read that finds it, and
    // the frozen one contributes nothing - so still null rather than a wrong
    // number derived from a dead layer.
    expect(await sampler.sample()).toBeNull();

    const reading = await sampler.sample();
    expect(reading).not.toBeNull();
    expect(reading!.frameCount).toBe(60);
    expect(reading!.fps).toBeGreaterThan(0);
  });

  it('ignores a frozen layer that still has the highest total', async () => {
    // The old surface drew far more over its lifetime, so picking by total
    // frames would keep choosing it and keep reporting a zero window.
    const device = deviceReturning([
      dumpOf(layerBlock('111', 9000, [[16, 9000]]), layerBlock('222', 30, [[16, 30]])),
      dumpOf(layerBlock('111', 9000, [[16, 9000]]), layerBlock('222', 90, [[16, 90]])),
    ]);

    const sampler = new FpsSampler(device, PKG);
    await sampler.prepare();
    const reading = await sampler.sample();

    expect(reading).not.toBeNull();
    // 60 new frames on the live surface, not 0 from the frozen one.
    expect(reading!.frameCount).toBe(60);
  });

  it('reports nothing, rather than a wrong figure, while no surface is drawing', async () => {
    const device = deviceReturning([
      dumpOf(layerBlock('111', 500, [[16, 500]])),
      dumpOf(layerBlock('111', 500, [[16, 500]])),
      dumpOf(layerBlock('111', 500, [[16, 500]])),
    ]);

    const sampler = new FpsSampler(device, PKG);
    await sampler.prepare();
    expect(await sampler.sample()).toBeNull();
    expect(await sampler.sample()).toBeNull();
  });

  it('does not attribute another app’s surface to the game', async () => {
    const other = [
      'layerName = def999 SurfaceView[com.other.app/com.unity3d.player.UnityPlayerActivity]@0(BLAST)#999',
      'totalFrames = 4000',
      'droppedFrames = 0',
      'present2present histogram is as below:',
      '16ms=4000',
    ].join('\n');

    const device = deviceReturning([dumpOf(other), dumpOf(other), dumpOf(other)]);
    const sampler = new FpsSampler(device, PKG);
    await sampler.prepare();

    expect(await sampler.sample()).toBeNull();
    expect(await sampler.sample()).toBeNull();
  });
});
