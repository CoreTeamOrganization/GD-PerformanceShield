/**
 * Unity engine allocation tests.
 *
 * These figures end up in a report sent to a studio, so the properties that
 * matter are that a malformed line yields nothing rather than half a breakdown,
 * and that a counter the engine did not expose is reported as absent rather than
 * as zero — a zero reads as "no textures", which is the wrong conclusion.
 */
import { describe, expect, it } from 'vitest';

import {
  EngineMemoryTracker,
  largestEngineMover,
  parseEngineMemoryLine,
} from '../src/telemetry/engineMetrics.js';
import {
  parseConnectionBanner,
  parseForwardList,
  parseUnitySockets,
} from '../src/devices/playerConnection.js';

const MB = 1024 * 1024;

describe('parseEngineMemoryLine', () => {
  it('reads the four buckets a developer can act on', () => {
    const line =
      'PerformanceShield: OOMI/MEM {"ms":12034,"tex":99614720,"mesh":12582912,"audio":8388608,"shader":4194304}';

    expect(parseEngineMemoryLine(line)).toEqual({
      engineMs: 12034,
      textures: 95 * MB,
      meshes: 12 * MB,
      audio: 8 * MB,
      shaders: 4 * MB,
    });
  });

  it('survives the logcat prefix the device actually adds', () => {
    const line =
      '08-31 10:11:12.345  9241  9270 I Unity   : OOMI/MEM {"ms":500,"tex":1048576}';
    expect(parseEngineMemoryLine(line)?.textures).toBe(1 * MB);
  });

  it('reports counters the engine version did not expose', () => {
    // Absent, not zero. A zero would read as "this build has no audio".
    const line = 'OOMI/MEM {"ms":1,"tex":1048576,"na":["Audio Total Memory","Mesh Memory"]}';
    const reading = parseEngineMemoryLine(line)!;

    expect(reading.audio).toBeUndefined();
    expect(reading.meshes).toBeUndefined();
    expect(reading.unavailable).toEqual(['Audio Total Memory', 'Mesh Memory']);
  });

  it('returns nothing rather than a partial reading for a truncated line', () => {
    // logcat truncates long lines; a half-parsed breakdown must not reach the UI.
    expect(parseEngineMemoryLine('OOMI/MEM {"ms":1,"tex":104857')).toBeNull();
    expect(parseEngineMemoryLine('OOMI/MEM not json at all')).toBeNull();
  });

  it('ignores a line carrying no counter at all', () => {
    expect(parseEngineMemoryLine('OOMI/MEM {"ms":1}')).toBeNull();
    expect(parseEngineMemoryLine('OOMI/MEM/INIT {"counters":0}')).toBeNull();
  });

  it('ignores every ordinary log line', () => {
    expect(parseEngineMemoryLine('I/ActivityManager: Killing 9241:com.game/u0a12')).toBeNull();
    expect(parseEngineMemoryLine('')).toBeNull();
  });

  it('rejects a negative byte count', () => {
    // Nothing legitimate produces one, and it would render as a negative bar.
    expect(parseEngineMemoryLine('OOMI/MEM {"tex":-5}')).toBeNull();
  });
});

describe('EngineMemoryTracker', () => {
  it('keeps the most recent reading and ignores everything else', () => {
    const tracker = new EngineMemoryTracker();

    expect(tracker.current()).toBeNull();
    expect(tracker.ingest('D/Unity: some ordinary message')).toBeNull();
    expect(tracker.current()).toBeNull();

    tracker.ingest('OOMI/MEM {"ms":1000,"tex":10485760}');
    tracker.ingest('I/ActivityManager: nothing to do with us');
    tracker.ingest('OOMI/MEM {"ms":2000,"tex":20971520}');

    expect(tracker.current()?.textures).toBe(20 * MB);
    expect(tracker.seen).toBe(2);
  });
});

describe('largestEngineMover', () => {
  it('names the bucket that moved most', () => {
    const before = { textures: 20 * MB, meshes: 10 * MB, audio: 5 * MB };
    const after = { textures: 100 * MB, meshes: 12 * MB, audio: 5 * MB };

    expect(largestEngineMover(before, after)).toEqual({ field: 'textures', delta: 80 * MB });
  });

  it('reports a release as readily as a growth', () => {
    const before = { textures: 100 * MB, meshes: 10 * MB };
    const after = { textures: 20 * MB, meshes: 10 * MB };

    expect(largestEngineMover(before, after)).toEqual({ field: 'textures', delta: -80 * MB });
  });

  it('says nothing when a bucket is missing from either end', () => {
    // Comparing a reading that has textures against one that does not would
    // report the whole figure as growth.
    expect(largestEngineMover({ meshes: 1 }, { textures: 100 * MB })).toBeNull();
    expect(largestEngineMover(null, { textures: 100 * MB })).toBeNull();
  });

  it('says nothing when nothing moved', () => {
    expect(largestEngineMover({ textures: 5 * MB }, { textures: 5 * MB })).toBeNull();
  });
});

describe('Unity PlayerConnection discovery', () => {
  it('finds the abstract socket a development build opens', () => {
    // Real /proc/net/unix shape: abstract sockets carry a leading '@'.
    const procNetUnix = [
      'Num       RefCount Protocol Flags    Type St Inode Path',
      'ffff8f0a: 00000002 00000000 00010000 0001 01 24680 /dev/socket/logdw',
      'ffff8f0b: 00000003 00000000 00000000 0001 03 24681 @Unity-com.gdm.prison.guard',
      'ffff8f0c: 00000002 00000000 00010000 0001 01 24682 @android:debuggerd',
      'ffff8f0d: 00000003 00000000 00000000 0001 03 24683 @Unity-com.other.game',
    ].join('\n');

    expect(parseUnitySockets(procNetUnix)).toEqual([
      'Unity-com.gdm.prison.guard',
      'Unity-com.other.game',
    ]);
  });

  it('finds nothing for a release build, which opens no socket', () => {
    const procNetUnix = [
      'Num       RefCount Protocol Flags    Type St Inode Path',
      'ffff8f0a: 00000002 00000000 00010000 0001 01 24680 /dev/socket/logdw',
    ].join('\n');

    expect(parseUnitySockets(procNetUnix)).toEqual([]);
  });

  it('reads the port out of the connection banner', () => {
    const log =
      'PlayerConnection initialized network socket : 0.0.0.0 55000\n' +
      'Multi-casting "[IP] 10.0.2.15 [Port] 55000 [Flags] 2 [Guid] 1899502210 [EditorId] 0 ' +
      '[Version] 1048832 [Id] AndroidPlayer [Debug] 1" to [225.0.0.222:54997]...';

    expect(parseConnectionBanner(log)).toEqual({ port: 55000, guid: '1899502210' });
  });

  it('returns nothing for a log with no banner in it', () => {
    expect(parseConnectionBanner('nothing of interest here')).toEqual({ port: null, guid: null });
  });

  it('recognises a forward it already owns, for this device only', () => {
    // Two devices can both be running a development build; attaching to the
    // wrong one would be silent and wrong.
    const list = [
      'OTHERDEVICE tcp:34999 localabstract:Unity-com.gdm.prison.guard',
      'R5CT10ABCD tcp:34998 localabstract:Unity-com.gdm.prison.guard',
      'R5CT10ABCD tcp:8080 tcp:8080',
    ].join('\n');

    expect(parseForwardList(list, 'R5CT10ABCD', 'Unity-com.gdm.prison.guard')).toBe(34998);
    expect(parseForwardList(list, 'R5CT10ABCD', 'Unity-com.absent')).toBeNull();
    expect(parseForwardList('', 'R5CT10ABCD', 'Unity-com.gdm.prison.guard')).toBeNull();
  });
});
