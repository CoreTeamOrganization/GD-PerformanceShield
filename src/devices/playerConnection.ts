/**
 * Unity PlayerConnection discovery and forwarding.
 *
 * A Unity **development build** on Android opens a Unix abstract domain socket
 * named `Unity-<bundleIdentifier>`. That socket is how the Unity Editor's
 * Profiler attaches over USB: it runs
 *
 *   adb forward tcp:<local> localabstract:Unity-<package>
 *
 * and speaks PlayerConnection over the forwarded port. This module does the
 * same discovery and forwarding, which gives us two things: proof that the
 * build under test is actually profileable, and a live port the operator can
 * point Unity's own Profiler at.
 *
 * What this module deliberately does **not** do is parse the protocol. The
 * payload carried over PlayerConnection is Unity's internal `RawFrameData`
 * format - undocumented, versioned with the engine, and read only by the
 * Editor. A speculative parser would emit texture and mesh figures that are
 * wrong on some engine versions and absent on others, and a wrong memory number
 * in a report sent to a studio is worse than a missing one. Engine-authoritative
 * per-asset-type totals come from the reporter bridge instead - see
 * `scripts/unity/PerformanceShieldReporter.cs` and `engineMetrics.ts`.
 */
import type { AdbDevice } from './adb.js';
import type { Logger } from '../core/logger.js';

export interface PlayerConnectionInfo {
  /** True when a Unity PlayerConnection socket exists for this package. */
  available: boolean;
  /** The abstract socket name, e.g. `Unity-com.gdm.prison.guard`. */
  socketName: string | null;
  /** Local TCP port forwarded to it, once `forward()` has run. */
  localPort: number | null;
  /**
   * Whether this looks like a development build. The socket only exists on one,
   * so its absence is the single most useful thing we can tell the operator.
   */
  developmentBuild: boolean;
  /** Operator-facing explanation when nothing was found. */
  reason: string | null;
}

/**
 * Abstract sockets appear in /proc/net/unix with a leading `@`.
 *
 * The file is world-readable, so this needs neither root nor a debuggable app -
 * which matters, because the whole point is to find out whether the build is a
 * development build before assuming anything else about it.
 */
export function parseUnitySockets(procNetUnix: string): string[] {
  const names = new Set<string>();

  for (const line of procNetUnix.split('\n')) {
    // Columns end with the path; abstract sockets are prefixed with '@'.
    const match = /@(Unity-\S+)\s*$/.exec(line.trimEnd());
    if (match?.[1]) names.add(match[1]);
  }

  return [...names];
}

/**
 * Pull the PlayerConnection banner out of logcat.
 *
 * A development build logs its connection parameters at startup, which is the
 * fallback when /proc/net/unix cannot be read. The line looks like:
 *
 *   PlayerConnection initialized network socket : 0.0.0.0 55000
 *   Multi-casting "[IP] 10.0.2.15 [Port] 55000 [Flags] 2 ... [PackageName] AndroidPlayer" to [225.0.0.222:54997]...
 */
export function parseConnectionBanner(logText: string): { port: number | null; guid: string | null } {
  const port =
    /PlayerConnection initialized network socket\s*:\s*\S+\s+(\d+)/i.exec(logText)?.[1] ??
    /\[Port\]\s*(\d+)/i.exec(logText)?.[1] ??
    null;

  const guid = /\[Guid\]\s*(\d+)/i.exec(logText)?.[1] ?? null;

  return { port: port ? Number(port) : null, guid };
}

/** Ports Unity's tooling uses, tried in order when picking a local one. */
const CANDIDATE_LOCAL_PORTS = [34999, 34998, 54998, 55000, 55001];

export interface ForwardOptions {
  device: AdbDevice;
  packageName: string;
  logger?: Logger;
}

/**
 * Find the game's PlayerConnection socket and forward it to localhost.
 *
 * Discovery is by socket name rather than by port, because on Android the
 * player does not listen on a TCP port at all - it listens on an abstract
 * socket, and `adb forward` is what turns that into a local port.
 */
export async function openPlayerConnection(opts: ForwardOptions): Promise<PlayerConnectionInfo> {
  const { device, packageName, logger } = opts;

  const absent: PlayerConnectionInfo = {
    available: false,
    socketName: null,
    localPort: null,
    developmentBuild: false,
    reason: null,
  };

  const listing = await device.shell(['cat', '/proc/net/unix'], 15_000);
  if (listing.code !== 0) {
    return {
      ...absent,
      reason: 'Could not read /proc/net/unix on this device, so a Unity profiler socket cannot be found.',
    };
  }

  const sockets = parseUnitySockets(listing.stdout);
  // Prefer the socket named for this package; a device can be running more than
  // one development build, and attaching to the wrong one would be silent.
  const socketName =
    sockets.find((s) => s === `Unity-${packageName}`) ??
    sockets.find((s) => s.includes(packageName)) ??
    null;

  if (!socketName) {
    return {
      ...absent,
      reason:
        sockets.length > 0
          ? `Unity profiler sockets exist on this device (${sockets.join(', ')}) but none belong to ` +
            `${packageName}. That build is not a development build.`
          : 'No Unity profiler socket on this device. The build under test is a release build - ' +
            'Unity only opens one in a development build ("Development Build" in Build Settings).',
    };
  }

  // A port already forwarded to this socket is reused rather than duplicated.
  const existing = await findExistingForward(device, socketName);
  if (existing !== null) {
    logger?.info('Reusing existing Unity profiler forward', { socketName, localPort: existing });
    return { available: true, socketName, localPort: existing, developmentBuild: true, reason: null };
  }

  for (const port of CANDIDATE_LOCAL_PORTS) {
    const res = await device.exec(['forward', `tcp:${port}`, `localabstract:${socketName}`], 15_000);
    if (res.code === 0) {
      logger?.info('Forwarded Unity PlayerConnection', { socketName, localPort: port });
      return { available: true, socketName, localPort: port, developmentBuild: true, reason: null };
    }
  }

  return {
    available: false,
    socketName,
    localPort: null,
    developmentBuild: true,
    reason:
      `Found the Unity profiler socket (${socketName}) but every candidate local port was busy. ` +
      'Close the Unity Editor or another profiler and retry.',
  };
}

/** Which local port, if any, already forwards to this socket. */
export async function findExistingForward(
  device: AdbDevice,
  socketName: string,
): Promise<number | null> {
  const res = await device.exec(['forward', '--list'], 10_000);
  if (res.code !== 0) return null;
  return parseForwardList(res.stdout, device.serial, socketName);
}

/**
 * `adb forward --list` prints one line per forward:
 *   R5CT10ABCD tcp:34999 localabstract:Unity-com.gdm.prison.guard
 */
export function parseForwardList(
  text: string,
  serial: string,
  socketName: string,
): number | null {
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [lineSerial, local, remote] = parts;
    if (lineSerial !== serial) continue;
    if (remote !== `localabstract:${socketName}`) continue;
    const port = /^tcp:(\d+)$/.exec(local ?? '')?.[1];
    if (port) return Number(port);
  }
  return null;
}

/** Remove a forward we created, so a later run is not blocked by a stale one. */
export async function closePlayerConnection(
  device: AdbDevice,
  localPort: number,
  logger?: Logger,
): Promise<void> {
  const res = await device.exec(['forward', '--remove', `tcp:${localPort}`], 10_000);
  if (res.code !== 0) {
    logger?.debug('Could not remove Unity profiler forward', { localPort, stderr: res.stderr });
  }
}
