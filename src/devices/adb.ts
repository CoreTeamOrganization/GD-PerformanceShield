/**
 * Typed ADB wrapper.
 *
 * Every call is serial-targeted (`adb -s SERIAL ...`) as the spec requires -
 * with two devices attached, an untargeted adb command is a silent correctness
 * bug that would attribute Device B's memory to Device A.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { DeviceError } from '../core/errors.js';
import { run, type RunResult } from '../core/exec.js';
import type { Logger } from '../core/logger.js';

export interface AdbDeviceListing {
  serial: string;
  state: 'device' | 'offline' | 'unauthorized' | 'bootloader' | 'recovery' | 'unknown';
  properties: Record<string, string>;
}

export class Adb {
  constructor(
    readonly adbPath: string,
    private readonly logger?: Logger,
  ) {}

  /** Run a raw adb command with no device target (e.g. `devices`, `start-server`). */
  async raw(args: string[], timeoutMs = 30_000): Promise<RunResult> {
    this.logger?.trace('adb', { args: args.join(' ') });
    return run(this.adbPath, args, { timeoutMs });
  }

  async startServer(): Promise<void> {
    const res = await this.raw(['start-server'], 60_000);
    if (res.code !== 0) {
      throw new DeviceError(`Failed to start the adb server: ${res.stderr.trim()}`, {
        hint: `Check that "${this.adbPath}" is a working adb binary, or set GDPS_ADB_PATH.`,
      });
    }
  }

  async version(): Promise<string> {
    const res = await this.raw(['version'], 15_000);
    return res.stdout.split('\n')[0]?.trim() ?? 'unknown';
  }

  /** Parse `adb devices -l`. */
  async listDevices(): Promise<AdbDeviceListing[]> {
    const res = await this.raw(['devices', '-l'], 20_000);
    if (res.code !== 0) {
      throw new DeviceError(`adb devices failed: ${res.stderr.trim()}`);
    }
    const out: AdbDeviceListing[] = [];
    for (const line of res.stdout.split('\n').slice(1)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [serial, state, ...rest] = trimmed.split(/\s+/);
      if (!serial || !state) continue;
      const properties: Record<string, string> = {};
      for (const token of rest) {
        const idx = token.indexOf(':');
        if (idx > 0) properties[token.slice(0, idx)] = token.slice(idx + 1);
      }
      out.push({ serial, state: normalizeState(state), properties });
    }
    return out;
  }

  device(serial: string): AdbDevice {
    return new AdbDevice(this.adbPath, serial, this.logger?.child(serial));
  }
}

function normalizeState(state: string): AdbDeviceListing['state'] {
  const known = ['device', 'offline', 'unauthorized', 'bootloader', 'recovery'] as const;
  return (known as readonly string[]).includes(state)
    ? (state as AdbDeviceListing['state'])
    : 'unknown';
}

/** All commands for one specific device. */
export class AdbDevice {
  constructor(
    readonly adbPath: string,
    readonly serial: string,
    private readonly logger?: Logger,
  ) {}

  private args(rest: string[]): string[] {
    return ['-s', this.serial, ...rest];
  }

  async exec(args: string[], timeoutMs = 30_000): Promise<RunResult> {
    this.logger?.trace('adb device', { args: args.join(' ') });
    return run(this.adbPath, this.args(args), { timeoutMs });
  }

  /**
   * Run a single command with its arguments.
   *
   * Note what this does *not* do: adb joins everything after `shell` with
   * spaces and hands the result to the device's shell, so these argv entries
   * are not isolated from each other the way a local `spawn` would isolate
   * them. That makes this the wrong tool for anything containing shell syntax -
   * use `script` for that.
   */
  async shell(command: string[], timeoutMs = 30_000): Promise<RunResult> {
    return this.exec(['shell', ...command], timeoutMs);
  }

  /**
   * Run a shell script on the device.
   *
   * This exists because `shell(['sh', '-c', script])` does not work and fails
   * silently. adb joins its arguments with spaces before the device shell ever
   * sees them, so the script loses its grouping: a loop came apart at the first
   * semicolon and died with "syntax error: unexpected 'do'", and
   * `sh -c 'cat FILE; echo x'` ran `cat` with no arguments - it read stdin, got
   * EOF and printed nothing, so the caller saw an empty file rather than an
   * error. Two probes were doing exactly this and had been returning nothing at
   * all. Passing the script as one argument lets the device shell parse it, and
   * that is all `sh -c` was ever there to arrange.
   */
  async script(text: string, timeoutMs = 30_000): Promise<RunResult> {
    return this.exec(['shell', text], timeoutMs);
  }

  async shellOut(command: string[], timeoutMs = 30_000): Promise<string> {
    const res = await this.shell(command, timeoutMs);
    return res.stdout;
  }

  /** Read a single `getprop` value. */
  async getProp(name: string): Promise<string | null> {
    const res = await this.shell(['getprop', name], 15_000);
    const value = res.stdout.trim();
    return value.length > 0 ? value : null;
  }

  /** Read every property in one round trip - far cheaper than N getprop calls. */
  async getAllProps(): Promise<Record<string, string>> {
    const res = await this.shell(['getprop'], 30_000);
    const props: Record<string, string> = {};
    const re = /^\[([^\]]+)\]:\s*\[([^\]]*)\]$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(res.stdout)) !== null) {
      if (m[1] !== undefined) props[m[1]] = m[2] ?? '';
    }
    return props;
  }

  async install(apkPath: string, opts: { reinstall?: boolean; grantAll?: boolean } = {}): Promise<void> {
    const args = ['install'];
    if (opts.reinstall) args.push('-r');
    if (opts.grantAll) args.push('-g');
    args.push('-d'); // allow version downgrade; studios often hand us older builds
    args.push(apkPath);

    const res = await this.exec(args, 20 * 60_000);
    const combined = `${res.stdout}\n${res.stderr}`;
    if (res.code !== 0 || /Failure|Error:/i.test(combined)) {
      throw new DeviceError(`Install failed on ${this.serial}: ${combined.trim().slice(0, 600)}`, {
        hint: interpretInstallFailure(combined),
      });
    }
  }

  async uninstall(packageName: string): Promise<void> {
    await this.exec(['uninstall', packageName], 120_000);
  }

  async isInstalled(packageName: string): Promise<boolean> {
    const res = await this.shell(['pm', 'path', packageName], 20_000);
    return res.stdout.includes('package:');
  }

  async forceStop(packageName: string): Promise<void> {
    await this.shell(['am', 'force-stop', packageName], 20_000);
  }

  /** Clear app data so a cold-launch test really starts from a fresh state. */
  async clearData(packageName: string): Promise<void> {
    await this.shell(['pm', 'clear', packageName], 60_000);
  }

  async startActivity(component: string): Promise<RunResult> {
    return this.shell(
      ['am', 'start', '-W', '-n', component, '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER'],
      120_000,
    );
  }

  /**
   * Which package currently holds the foreground.
   *
   * The one check that says whether a measurement is worth anything. `am start`
   * reporting "Status: ok" means an activity was started, not that it stayed in
   * front - another app can take the foreground back immediately, and on a QA
   * phone full of ad-heavy games one routinely does. A Unity app in the
   * background still has a PID and still reports memory, but its renderer is
   * throttled or paused, so every frame-rate figure from a backgrounded session
   * is meaningless while looking entirely normal.
   *
   * Field names differ across Android versions, so several are accepted.
   * Returns null when none of them can be read, which is different from
   * "nothing is in the foreground" and is treated as unknown by callers.
   */
  async foregroundPackage(): Promise<string | null> {
    const res = await this.shell(['dumpsys', 'activity', 'activities'], 20_000);
    if (res.code !== 0) return null;

    for (const key of ['topResumedActivity', 'mResumedActivity', 'ResumedActivity']) {
      // ActivityRecord{hash u0 com.pkg/.Activity taskId}
      // String.raw, because in an ordinary template literal `\S` collapses to
      // `S` and the pattern silently stops matching anything.
      const match = new RegExp(String.raw`${key}=\S+\s+\S+\s+([A-Za-z0-9_.]+)/`).exec(
        res.stdout,
      );
      if (match?.[1]) return match[1];
    }

    // Some builds only expose the focused window.
    const window = await this.shell(['dumpsys', 'window'], 20_000);
    const focused = /mCurrentFocus=Window\{\S+ \S+ ([A-Za-z0-9_.]+)\//.exec(window.stdout);
    return focused?.[1] ?? null;
  }

  /** Launch via the monkey tool - the fallback when the launcher component is unknown. */
  async startViaMonkey(packageName: string): Promise<RunResult> {
    return this.shell(
      ['monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'],
      60_000,
    );
  }

  /**
   * Resolve the PID of a package's main process.
   *
   * `pidof` is the fast path but is missing or restricted on some devices, so
   * we fall back to `ps -A`. Returning the *main* process matters: Unity games
   * often spawn `:gcm`/`:unityads` helper processes whose memory is not the
   * memory we are profiling.
   */
  async getPid(packageName: string): Promise<number | null> {
    const viaPidof = await this.shell(['pidof', packageName], 15_000);
    const pidofValue = viaPidof.stdout.trim().split(/\s+/).filter(Boolean);
    if (pidofValue.length > 0) {
      const pid = Number(pidofValue[0]);
      if (Number.isFinite(pid) && pid > 0) return pid;
    }

    const ps = await this.shell(['ps', '-A', '-o', 'PID,NAME'], 30_000);
    const source = ps.stdout.trim().length > 0 ? ps.stdout : (await this.shell(['ps'], 30_000)).stdout;
    for (const line of source.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const name = parts[parts.length - 1];
      if (name !== packageName) continue;
      const pid = Number(parts[0]);
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
    return null;
  }

  /** Every process belonging to the package, including `:child` processes. */
  async getAllPids(packageName: string): Promise<Array<{ pid: number; name: string }>> {
    const ps = await this.shell(['ps', '-A', '-o', 'PID,NAME'], 30_000);
    const out: Array<{ pid: number; name: string }> = [];
    for (const line of ps.stdout.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const name = parts[parts.length - 1] ?? '';
      if (name !== packageName && !name.startsWith(`${packageName}:`)) continue;
      const pid = Number(parts[0]);
      if (Number.isFinite(pid) && pid > 0) out.push({ pid, name });
    }
    return out;
  }

  async pull(remote: string, local: string, timeoutMs = 5 * 60_000): Promise<void> {
    const res = await this.exec(['pull', remote, local], timeoutMs);
    if (res.code !== 0) {
      throw new DeviceError(`adb pull ${remote} failed: ${res.stderr.trim().slice(0, 400)}`);
    }
  }

  /** Capture a PNG screenshot straight into a local file. */
  async screenshot(localPath: string): Promise<void> {
    const remote = `/sdcard/oom_shot_${Date.now()}.png`;
    await this.shell(['screencap', '-p', remote], 60_000);
    await this.pull(remote, localPath);
    await this.shell(['rm', '-f', remote], 15_000);
  }

  /** Spawn a long-lived streaming command (logcat). Caller must kill it. */
  /**
   * Run an adb command and collect stdout as raw bytes.
   *
   * `exec()` decodes stdout as text, which corrupts binary. `adb exec-out` is
   * the binary-clean transport, and this is the only way to read part of a file
   * off a device without pulling the whole thing.
   */
  async execBinary(args: string[], timeoutMs = 60_000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = this.spawnStream(args);
      const chunks: Buffer[] = [];
      const errors: Buffer[] = [];

      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`adb ${args.join(' ')} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.on('data', (c: Buffer) => chunks.push(c));
      child.stderr.on('data', (c: Buffer) => errors.push(c));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(Buffer.concat(errors).toString().trim() || `adb exited ${code}`));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
    });
  }

  /**
   * Read a byte range from a file on the device.
   *
   * `dd` seeks in whole blocks, so the request is widened to block boundaries
   * and trimmed afterwards. Used to read a ZIP's central directory and one or
   * two entries out of an APK instead of transferring hundreds of megabytes.
   */
  async readFileRange(remotePath: string, offset: number, length: number): Promise<Buffer> {
    const BLOCK = 4096;
    const startBlock = Math.floor(offset / BLOCK);
    const endByte = offset + length;
    const blockCount = Math.ceil(endByte / BLOCK) - startBlock;

    const raw = await this.execBinary(
      [
        'exec-out',
        'dd',
        `if=${remotePath}`,
        `bs=${BLOCK}`,
        `skip=${startBlock}`,
        `count=${blockCount}`,
      ],
      120_000,
    );

    const from = offset - startBlock * BLOCK;
    return raw.subarray(from, from + length);
  }

  /** Size of a file on the device, or null when it cannot be read. */
  async fileSize(remotePath: string): Promise<number | null> {
    const res = await this.shell(['stat', '-c', '%s', remotePath], 20_000);
    const value = Number.parseInt(res.stdout.trim(), 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  spawnStream(args: string[]): ChildProcessWithoutNullStreams {
    return spawn(this.adbPath, this.args(args), {
      windowsHide: true,
      shell: false,
    }) as ChildProcessWithoutNullStreams;
  }

  async clearLogcat(): Promise<void> {
    await this.exec(['logcat', '-c'], 20_000);
  }
}

function interpretInstallFailure(output: string): string {
  if (output.includes('INSTALL_FAILED_INSUFFICIENT_STORAGE')) {
    return 'The device is out of storage. Free space and retry.';
  }
  if (output.includes('INSTALL_FAILED_UPDATE_INCOMPATIBLE') || output.includes('signatures do not match')) {
    return 'A build with a different signing key is installed. Uninstall it first (--fresh-install).';
  }
  if (output.includes('INSTALL_FAILED_NO_MATCHING_ABIS')) {
    return 'The APK has no native library matching this device ABI (e.g. arm64-only APK on a 32-bit device).';
  }
  if (output.includes('INSTALL_FAILED_VERSION_DOWNGRADE')) {
    return 'A newer version is installed. Uninstall it first (--fresh-install).';
  }
  if (output.includes('device unauthorized') || output.includes('no permissions')) {
    return 'Accept the USB debugging prompt on the device screen.';
  }
  return 'Check the device is unlocked, authorized for USB debugging, and has free storage.';
}
