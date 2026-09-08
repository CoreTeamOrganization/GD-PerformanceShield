/**
 * Clearing memory before a run.
 *
 * A peak measured on a phone with nine other games resident is not the same
 * result as one measured on a quiet device: Android's low-memory killer decides
 * what to reclaim based on everything running, so the same build can survive on
 * a fresh device and be killed on a busy one. Being able to say which condition
 * was measured is the point.
 *
 * What this deliberately does *not* do is kill everything it can. Force-stopping
 * the launcher leaves the tester looking at a black screen; force-stopping the
 * keyboard means they cannot type. Those are excluded by asking the system which
 * packages hold those roles rather than by guessing from a hard-coded list.
 */
import type { AdbDevice } from './adb.js';
import type { Logger } from '../core/logger.js';

export interface FreshStartResult {
  /** Device-wide available memory before and after, so the effect is auditable. */
  availableBeforeBytes: number | null;
  availableAfterBytes: number | null;
  freedBytes: number | null;
  /** Packages that were stopped. */
  stopped: string[];
  /**
   * Packages left alone, with the reason. Recorded because "we cleared memory"
   * is a weaker claim than "we cleared memory except the launcher and the
   * keyboard, which the device needs".
   */
  skipped: Array<{ packageName: string; reason: string }>;
  /** True when `am kill-all` was accepted by the device. */
  killAllRan: boolean;
  /**
   * What held the foreground before the run, when it was not the target.
   *
   * Recorded because this is the app `am kill-all` is guaranteed *not* to
   * touch - it reclaims background processes and spares whatever is in front -
   * so it is both the most important one to stop and the one a reader will
   * want to know about if the run still looks contaminated.
   */
  foregroundBefore: string | null;
}

/** Available memory in bytes, from /proc/meminfo. */
export async function readAvailableBytes(device: AdbDevice): Promise<number | null> {
  const res = await device.shell(['cat', '/proc/meminfo'], 10_000);
  if (res.code !== 0) return null;
  const kb = /MemAvailable:\s+(\d+)\s*kB/.exec(res.stdout)?.[1];
  return kb ? Number(kb) * 1024 : null;
}

/**
 * Which package is the home screen.
 *
 * Killing it is the difference between a clean device and one the tester cannot
 * use, so it is resolved from the system rather than assumed.
 */
export async function resolveLauncher(device: AdbDevice): Promise<string | null> {
  const res = await device.shell(
    ['cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.HOME'],
    15_000,
  );
  if (res.code !== 0) return null;

  // Output is a component name on its own line: com.pkg/.SomeActivity
  const match = /^([A-Za-z0-9_.]+)\//m.exec(res.stdout.trim());
  return match?.[1] ?? null;
}

/** Packages providing input methods, which a tester needs to type. */
export async function resolveInputMethods(device: AdbDevice): Promise<string[]> {
  const res = await device.shell(['ime', 'list', '-s'], 15_000);
  if (res.code !== 0) return [];

  return [
    ...new Set(
      res.stdout
        .split('\n')
        .map((line) => /^([A-Za-z0-9_.]+)\//.exec(line.trim())?.[1])
        .filter((p): p is string => Boolean(p)),
    ),
  ];
}

/**
 * Third-party packages with a live process right now.
 *
 * Read from `ps` rather than from the package manager, because what matters is
 * what is resident, not what is installed. Process names are matched against the
 * installed third-party list so a `:remote` service process resolves back to its
 * own package.
 */
export async function runningThirdPartyPackages(
  device: AdbDevice,
  installed: string[],
): Promise<string[]> {
  const res = await device.shell(['ps', '-A', '-o', 'NAME'], 20_000);
  if (res.code !== 0) return [];

  const known = new Set(installed);
  const running = new Set<string>();

  for (const raw of res.stdout.split('\n')) {
    // A process name is the package, optionally with a `:suffix`.
    const name = raw.trim().split(':')[0];
    if (name && known.has(name)) running.add(name);
  }

  return [...running];
}

export interface FreshStartOptions {
  device: AdbDevice;
  /** The game about to be profiled. Never stopped - it is the subject. */
  targetPackage: string;
  /** Installed third-party packages, so system apps are never touched. */
  installedThirdParty: string[];
  logger?: Logger;
}

/**
 * Free as much memory as can be freed safely.
 *
 * Two steps, in order of bluntness:
 *
 *   1. `am kill-all`, which asks Android to reclaim every *background* process.
 *      This is the documented, safe operation: it leaves foreground and
 *      persistent processes alone.
 *   2. Force-stop the third-party apps that still hold a process, excluding the
 *      subject, the launcher and any keyboard.
 *
 * The second step is needed because `am kill-all` spares anything Android
 * considers not-background, which on a modern device includes a good deal of
 * what a QA phone accumulates.
 */
export async function prepareFreshStart(opts: FreshStartOptions): Promise<FreshStartResult> {
  const { device, targetPackage, installedThirdParty, logger } = opts;

  const availableBeforeBytes = await readAvailableBytes(device);
  const skipped: FreshStartResult['skipped'] = [];

  // ---- 1. background processes ------------------------------------------
  const killAll = await device.shell(['am', 'kill-all'], 30_000);
  const killAllRan = killAll.code === 0;
  if (!killAllRan) {
    logger?.debug('am kill-all was refused', { stderr: killAll.stderr.slice(0, 200) });
  }

  // ---- 2. resident third-party apps -------------------------------------
  const [launcher, inputMethods, running, foregroundBefore] = await Promise.all([
    resolveLauncher(device),
    resolveInputMethods(device),
    runningThirdPartyPackages(device, installedThirdParty),
    device.foregroundPackage(),
  ]);

  /*
   * Whatever is in front, added explicitly.
   *
   * `am kill-all` reclaims background processes and spares the foreground, so
   * the app the tester was last using is precisely the one that survives this
   * step. It is normally in `running` as well, but not always - the process
   * list and the window manager disagree for a moment during a transition, and
   * the app that matters most is the one that must not fall through that gap.
   */
  const candidates = [...new Set(running)];
  if (
    foregroundBefore &&
    foregroundBefore !== targetPackage &&
    installedThirdParty.includes(foregroundBefore) &&
    !candidates.includes(foregroundBefore)
  ) {
    candidates.push(foregroundBefore);
  }

  const protectedPackages = new Map<string, string>();
  protectedPackages.set(targetPackage, 'the game being profiled');
  if (launcher) protectedPackages.set(launcher, 'the home screen');
  for (const ime of inputMethods) {
    if (!protectedPackages.has(ime)) protectedPackages.set(ime, 'a keyboard');
  }

  const stopped: string[] = [];
  for (const packageName of candidates) {
    const reason = protectedPackages.get(packageName);
    if (reason) {
      skipped.push({ packageName, reason });
      continue;
    }

    const res = await device.shell(['am', 'force-stop', packageName], 20_000);
    if (res.code === 0) stopped.push(packageName);
    else skipped.push({ packageName, reason: 'the device refused to stop it' });
  }

  // Reclaim is not instant: the killer runs, then pages are freed.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const availableAfterBytes = await readAvailableBytes(device);

  const freedBytes =
    availableBeforeBytes !== null && availableAfterBytes !== null
      ? availableAfterBytes - availableBeforeBytes
      : null;

  logger?.info('Cleared memory before the run', {
    stopped: stopped.length,
    skipped: skipped.length,
    foregroundBefore,
    freedMb: freedBytes !== null ? Math.round(freedBytes / (1024 * 1024)) : null,
  });

  return {
    availableBeforeBytes,
    availableAfterBytes,
    freedBytes,
    stopped,
    skipped,
    killAllRan,
    foregroundBefore: foregroundBefore === targetPackage ? null : foregroundBefore,
  };
}
