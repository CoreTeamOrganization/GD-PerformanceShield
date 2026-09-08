/**
 * Fresh-start tests.
 *
 * The dangerous failure here is not measuring badly, it is leaving the tester
 * with an unusable phone. Force-stopping the launcher gives them a black screen
 * and force-stopping the keyboard means they cannot type, so most of these
 * assert that those are protected — resolved from the system rather than guessed
 * from a hard-coded list, because the launcher on a Samsung is not the launcher
 * on a Pixel.
 */
import { describe, expect, it } from 'vitest';

import {
  prepareFreshStart,
  resolveInputMethods,
  resolveLauncher,
  runningThirdPartyPackages,
} from '../src/devices/freshStart.js';
import type { AdbDevice } from '../src/devices/adb.js';

/** An AdbDevice that answers one canned reply per command. */
function fakeDevice(replies: Record<string, { code?: number; stdout: string }>): AdbDevice {
  return {
    serial: 'TEST',
    async shell(command: string[]) {
      const key = command.join(' ');
      const hit = Object.entries(replies).find(([prefix]) => key.startsWith(prefix));
      return {
        code: hit?.[1].code ?? (hit ? 0 : 1),
        stdout: hit?.[1].stdout ?? '',
        stderr: '',
      };
    },
  } as unknown as AdbDevice;
}

describe('protecting what the device needs', () => {
  it('resolves the launcher from the system, not from a list of guesses', () => {
    // Real output from a Samsung SM-A366B: a priority line, then the component.
    const listing = [
      'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true',
      'com.sec.android.app.launcher/.activities.LauncherActivity',
    ].join('\n');

    const device = fakeDevice({ 'cmd package resolve-activity': { stdout: listing } });
    return expect(resolveLauncher(device)).resolves.toBe('com.sec.android.app.launcher');
  });

  it('resolves every keyboard, not only the active one', async () => {
    // A tester can switch keyboard mid-session; stopping an inactive one would
    // break that.
    const device = fakeDevice({
      'ime list': {
        stdout: [
          'com.samsung.android.honeyboard/.service.HoneyBoardService',
          'com.google.android.tts/com.google.android.apps.speech.tts.googletts.settings.asr.voiceime.VoiceInputMethodService',
        ].join('\n'),
      },
    });

    await expect(resolveInputMethods(device)).resolves.toEqual([
      'com.samsung.android.honeyboard',
      'com.google.android.tts',
    ]);
  });

  it('returns nothing rather than a guess when the launcher cannot be resolved', async () => {
    // Better to stop nothing than to stop the wrong thing.
    await expect(resolveLauncher(fakeDevice({}))).resolves.toBeNull();
    await expect(resolveInputMethods(fakeDevice({}))).resolves.toEqual([]);
  });
});

describe('finding what is actually resident', () => {
  const installed = [
    'com.gdm.prison.guard',
    'com.sled.surfers.game',
    'com.facebook.katana',
    'com.never.launched',
  ];

  it('reports the third-party apps holding a process', async () => {
    const ps = [
      'NAME',
      'init',
      '[kthreadd]',
      'com.android.systemui',
      'com.gdm.prison.guard',
      'com.facebook.katana',
    ].join('\n');

    const device = fakeDevice({ 'ps -A': { stdout: ps } });
    const running = await runningThirdPartyPackages(device, installed);

    expect(running.sort()).toEqual(['com.facebook.katana', 'com.gdm.prison.guard']);
    // Installed but not running, so nothing to stop.
    expect(running).not.toContain('com.never.launched');
  });

  it('resolves a service process back to its own package', async () => {
    // A `:remote` or `:sandboxed` process is the same app and must not be
    // reported as an unknown package.
    const ps = ['NAME', 'com.facebook.katana:providers', 'com.sled.surfers.game:unity'].join('\n');

    const running = await runningThirdPartyPackages(fakeDevice({ 'ps -A': { stdout: ps } }), installed);
    expect(running.sort()).toEqual(['com.facebook.katana', 'com.sled.surfers.game']);
  });

  it('never reports a system process', async () => {
    // Only packages in the installed third-party list can be returned, so a
    // system process cannot be stopped even by accident.
    const ps = ['NAME', 'system_server', 'com.android.phone', 'com.sec.android.app.launcher'].join('\n');
    await expect(
      runningThirdPartyPackages(fakeDevice({ 'ps -A': { stdout: ps } }), installed),
    ).resolves.toEqual([]);
  });

  it('reports nothing when ps cannot be read', async () => {
    await expect(runningThirdPartyPackages(fakeDevice({}), installed)).resolves.toEqual([]);
  });
});

/**
 * The app in front is the one `am kill-all` cannot touch.
 *
 * These exist because of a real session: "Close other apps first" was selected,
 * the stage ran and reported 431 MB freed, and the game the tester had been
 * playing was still running. `am kill-all` reclaims *background* processes and
 * spares whatever holds the foreground, so the one app most likely to distort
 * the measurement was also the one guaranteed to survive.
 */
describe('clearing the app that holds the foreground', () => {
  const TARGET = 'com.studio.game';
  const OTHER = 'com.other.game';
  const LAUNCHER = 'com.sec.android.app.launcher';

  /** A device whose `ps` and window manager disagree, as they do mid-transition. */
  function deviceWithForeground(foreground: string, running: string[]) {
    const stopped: string[] = [];
    const device = {
      serial: 'TEST',
      async shell(command: string[]) {
        const key = command.join(' ');
        if (key.startsWith('cat /proc/meminfo')) {
          return { code: 0, stdout: 'MemAvailable:    2000000 kB\n', stderr: '' };
        }
        if (key.startsWith('am kill-all')) return { code: 0, stdout: '', stderr: '' };
        if (key.startsWith('am force-stop')) {
          stopped.push(command[command.length - 1]!);
          return { code: 0, stdout: '', stderr: '' };
        }
        if (key.startsWith('cmd package resolve-activity')) {
          return { code: 0, stdout: `${LAUNCHER}/com.android.launcher.Home\n`, stderr: '' };
        }
        if (key.startsWith('ime list')) {
          return { code: 0, stdout: 'com.samsung.android.honeyboard/.Service\n', stderr: '' };
        }
        if (key.startsWith('ps -A')) {
          return { code: 0, stdout: `NAME\n${running.join('\n')}\n`, stderr: '' };
        }
        return { code: 1, stdout: '', stderr: '' };
      },
      async foregroundPackage() {
        return foreground;
      },
    } as unknown as AdbDevice;

    return { device, stopped };
  }

  it('stops the foreground app even when `ps` has not listed it yet', async () => {
    // The gap this closes: the process list and the window manager disagree for
    // a moment, and the app that matters most must not fall through it.
    const { device, stopped } = deviceWithForeground(OTHER, []);

    const result = await prepareFreshStart({
      device,
      targetPackage: TARGET,
      installedThirdParty: [TARGET, OTHER],
    });

    expect(stopped).toContain(OTHER);
    expect(result.stopped).toContain(OTHER);
    expect(result.foregroundBefore).toBe(OTHER);
  });

  it('never stops the game being profiled, even when it is in front', async () => {
    const { device, stopped } = deviceWithForeground(TARGET, [TARGET]);

    const result = await prepareFreshStart({
      device,
      targetPackage: TARGET,
      installedThirdParty: [TARGET, OTHER],
    });

    expect(stopped).not.toContain(TARGET);
    // Null rather than the package name: the target holding the foreground is
    // the desired state, not something for a reader to investigate.
    expect(result.foregroundBefore).toBeNull();
  });

  it('leaves the launcher alone when it is what is in front', async () => {
    // The normal case - the tester is on the home screen - and force-stopping
    // it would hand them a black screen.
    const { device, stopped } = deviceWithForeground(LAUNCHER, [LAUNCHER]);

    await prepareFreshStart({
      device,
      targetPackage: TARGET,
      installedThirdParty: [TARGET, OTHER],
    });

    expect(stopped).not.toContain(LAUNCHER);
  });

  it('does not try to stop a system app that happens to be in front', async () => {
    // Not in the third-party list, so not ours to kill.
    const { device, stopped } = deviceWithForeground('com.android.settings', []);

    await prepareFreshStart({
      device,
      targetPackage: TARGET,
      installedThirdParty: [TARGET, OTHER],
    });

    expect(stopped).toEqual([]);
  });
});
