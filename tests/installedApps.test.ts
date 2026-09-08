/**
 * Parser tests for installed-app enumeration.
 *
 * These pin the adb output formats the tool depends on. No device is involved:
 * the fixtures below are captured-shape output from `pm list packages -f -3`,
 * `dumpsys package packages` and `cmd package resolve-activity`, covering the
 * Android version differences that actually bite (randomised APK directories
 * containing `=`, `flags=` vs `pkgFlags=`, and shorthand activity names).
 */
import { describe, expect, it } from 'vitest';

import {
  parseLauncherFromDump,
  parsePackageDump,
  parsePackageList,
  parseResolveActivity,
} from '../src/devices/installedApps.js';

// ---------------------------------------------------------------------------
// pm list packages -f -3
// ---------------------------------------------------------------------------

const PM_LIST = `package:/data/app/~~kR3nQx9AbC==/com.studio.cosmicracer-Xy7ZpL2Q==/base.apk=com.studio.cosmicracer
package:/data/app/~~aB1cD2eF==/com.studio.puzzlequest-Gh3IjK4L==/base.apk=com.studio.puzzlequest
package:/data/app/com.legacy.game-1/base.apk=com.legacy.game
package:com.noPathReported
`;

describe('pm list packages parsing', () => {
  it('separates the package name from a path containing "="', () => {
    const apps = parsePackageList(PM_LIST);
    expect(apps).toHaveLength(4);

    const racer = apps[0]!;
    expect(racer.packageName).toBe('com.studio.cosmicracer');
    expect(racer.apkPath).toBe(
      '/data/app/~~kR3nQx9AbC==/com.studio.cosmicracer-Xy7ZpL2Q==/base.apk',
    );
  });

  it('handles the older non-randomised path layout', () => {
    const legacy = parsePackageList(PM_LIST).find((a) => a.packageName === 'com.legacy.game');
    expect(legacy?.apkPath).toBe('/data/app/com.legacy.game-1/base.apk');
  });

  it('still yields the name when no path was reported', () => {
    const bare = parsePackageList(PM_LIST).find((a) => a.packageName === 'com.noPathReported');
    expect(bare).toBeDefined();
    expect(bare?.apkPath).toBeNull();
  });

  it('ignores noise and blank lines', () => {
    expect(parsePackageList('\n\nsome unrelated output\n\n')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// dumpsys package packages
// ---------------------------------------------------------------------------

const DUMPSYS = `Packages:
  Package [com.studio.cosmicracer] (7f3a9b1):
    userId=10231
    pkg=Package{4c1d2e3 com.studio.cosmicracer}
    codePath=/data/app/~~kR3nQx9AbC==/com.studio.cosmicracer-Xy7ZpL2Q==
    primaryCpuAbi=arm64-v8a
    versionCode=4213 minSdk=24 targetSdk=34
    versionName=1.4.2
    splits=[base]
    apkSigningVersion=3
    flags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ALLOW_BACKUP ]
    firstInstallTime=2026-08-20 09:14:33
    lastUpdateTime=2026-08-30 17:02:11
    nonLocalizedLabel=null

  Package [com.studio.puzzlequest] (2b8c4d5):
    userId=10232
    primaryCpuAbi=armeabi-v7a
    versionCode=88 minSdk=21 targetSdk=33
    versionName=2.0.1-beta
    pkgFlags=[ DEBUGGABLE HAS_CODE ]
    firstInstallTime=2026-07-01 08:00:00
    lastUpdateTime=2026-08-31 06:30:00
    nonLocalizedLabel=Puzzle Quest

  Package [com.android.systemthing] (9e9e9e9):
    userId=1000
    versionCode=34 minSdk=34 targetSdk=34
    versionName=14
    flags=[ SYSTEM HAS_CODE ]
    firstInstallTime=2009-01-01 00:00:00
    lastUpdateTime=2009-01-01 00:00:00
`;

describe('dumpsys package parsing', () => {
  it('reads one detail block per package', () => {
    const details = parsePackageDump(DUMPSYS);
    expect([...details.keys()]).toEqual([
      'com.studio.cosmicracer',
      'com.studio.puzzlequest',
      'com.android.systemthing',
    ]);
  });

  it('extracts version, sdk levels and abi', () => {
    const d = parsePackageDump(DUMPSYS).get('com.studio.cosmicracer')!;
    expect(d.versionName).toBe('1.4.2');
    expect(d.versionCode).toBe(4213);
    expect(d.minSdk).toBe(24);
    expect(d.targetSdk).toBe(34);
    expect(d.primaryAbi).toBe('arm64-v8a');
  });

  it('reads install and update times, which order the list', () => {
    const d = parsePackageDump(DUMPSYS).get('com.studio.cosmicracer')!;
    expect(d.firstInstallTime).toBe('2026-08-20 09:14:33');
    expect(d.lastUpdateTime).toBe('2026-08-30 17:02:11');
  });

  it('treats a literal label as a name and a resource-backed one as absent', () => {
    const details = parsePackageDump(DUMPSYS);
    // nonLocalizedLabel=null means the real label is a string resource, which
    // needs resources.arsc — so the UI must fall back to the package name.
    expect(details.get('com.studio.cosmicracer')!.label).toBeNull();
    expect(details.get('com.studio.puzzlequest')!.label).toBe('Puzzle Quest');
  });

  it('reads DEBUGGABLE and SYSTEM from either flags spelling', () => {
    const details = parsePackageDump(DUMPSYS);
    // flags=[...]
    expect(details.get('com.studio.cosmicracer')!.debuggable).toBe(false);
    expect(details.get('com.studio.cosmicracer')!.isSystem).toBe(false);
    // pkgFlags=[...]
    expect(details.get('com.studio.puzzlequest')!.debuggable).toBe(true);
    // SYSTEM
    expect(details.get('com.android.systemthing')!.isSystem).toBe(true);
  });

  it('returns an empty map rather than throwing on unrecognised output', () => {
    expect(parsePackageDump('nothing useful here').size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// launch component resolution
// ---------------------------------------------------------------------------

describe('launch component resolution', () => {
  it('takes the component from resolve-activity --brief', () => {
    const output = `priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false
com.studio.cosmicracer/com.unity3d.player.UnityPlayerActivity`;
    expect(parseResolveActivity(output, 'com.studio.cosmicracer')).toBe(
      'com.studio.cosmicracer/com.unity3d.player.UnityPlayerActivity',
    );
  });

  it('expands the shorthand activity form', () => {
    const output = 'com.studio.cosmicracer/.MainActivity';
    expect(parseResolveActivity(output, 'com.studio.cosmicracer')).toBe(
      'com.studio.cosmicracer/com.studio.cosmicracer.MainActivity',
    );
  });

  it('returns null when nothing resolved', () => {
    expect(parseResolveActivity('No activity found', 'com.studio.cosmicracer')).toBeNull();
    expect(parseResolveActivity('', 'com.studio.cosmicracer')).toBeNull();
  });

  it('falls back to the launcher activity in a package dump', () => {
    const dump = `  Activity Resolver Table:
    Non-Data Actions:
      android.intent.action.MAIN:
        5f3a1b2 com.studio.cosmicracer/com.unity3d.player.UnityPlayerActivity filter 9c8d7e6
          Action: "android.intent.action.MAIN"
          Category: "android.intent.category.LAUNCHER"`;
    expect(parseLauncherFromDump(dump, 'com.studio.cosmicracer')).toBe(
      'com.studio.cosmicracer/com.unity3d.player.UnityPlayerActivity',
    );
  });

  it('prefers the activity nearest the LAUNCHER category over other activities', () => {
    const dump = `  8a1 com.studio.cosmicracer/.SettingsActivity filter 111
          Action: "android.intent.action.VIEW"
    9b2 com.studio.cosmicracer/.MainActivity filter 222
          Category: "android.intent.category.LAUNCHER"`;
    expect(parseLauncherFromDump(dump, 'com.studio.cosmicracer')).toBe(
      'com.studio.cosmicracer/com.studio.cosmicracer.MainActivity',
    );
  });

  it('returns null when the dump mentions no activity for the package', () => {
    expect(parseLauncherFromDump('unrelated dump text', 'com.studio.cosmicracer')).toBeNull();
  });
});
