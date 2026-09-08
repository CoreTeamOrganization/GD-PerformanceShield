/**
 * Step 4 - Device Manager.
 *
 * Detects connected devices, profiles their hardware, and assigns the A/B roles
 * from spec section 10: the lower-memory device exposes real OOM risk, the
 * higher-memory device separates genuine retention from device-budget limits.
 * Roles are derived from measured RAM rather than asking the operator, because
 * getting them backwards silently inverts the interpretation of every result.
 */
import { DeviceError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import { MB } from '../core/types.js';
import { Adb, type AdbDevice } from './adb.js';

export type DeviceRole = 'A' | 'B' | 'extra';

export interface DeviceInfo {
  serial: string;
  role: DeviceRole;
  model: string;
  manufacturer: string;
  brand: string;
  device: string;
  androidVersion: string;
  sdkInt: number;
  abi: string;
  supportedAbis: string[];
  totalRamBytes: number;
  availableRamBytes: number | null;
  /** Value of `dalvik.vm.heapgrowthlimit` - the per-app Java heap cap. */
  heapGrowthLimit: string | null;
  heapSize: string | null;
  /** Whether `/proc/<pid>` of a foreign process is readable (cheap-probe support). */
  procReadable: boolean | null;
  storageFreeBytes: number | null;
  isEmulator: boolean;
  screen: string | null;
  /** True when the device runs a userdebug/eng build - enables extra probes. */
  isDebugBuild: boolean;
}

export interface DetectOptions {
  /** Only use these serials. */
  onlySerials?: string[];
  logger?: Logger;
  /** Fail when fewer than this many devices are usable. */
  minDevices?: number;
}

export class DeviceManager {
  constructor(
    private readonly adb: Adb,
    private readonly logger?: Logger,
  ) {}

  /** Detect and profile every usable device, then assign A/B roles. */
  async detect(opts: DetectOptions = {}): Promise<DeviceInfo[]> {
    await this.adb.startServer();
    const listings = await this.adb.listDevices();

    const unusable = listings.filter((l) => l.state !== 'device');
    for (const bad of unusable) {
      this.logger?.warn(`Device ${bad.serial} is ${bad.state} - skipping`, {
        hint:
          bad.state === 'unauthorized'
            ? 'Accept the USB debugging prompt on the device.'
            : 'Reconnect the cable or reboot the device.',
      });
    }

    let usable = listings.filter((l) => l.state === 'device');
    if (opts.onlySerials?.length) {
      const wanted = new Set(opts.onlySerials);
      const missing = [...wanted].filter((s) => !usable.some((u) => u.serial === s));
      if (missing.length > 0) {
        throw new DeviceError(`Requested device(s) not connected: ${missing.join(', ')}`, {
          hint: 'Run `gdshield devices` to list what adb can currently see.',
        });
      }
      usable = usable.filter((l) => wanted.has(l.serial));
    }

    if (usable.length === 0) {
      throw new DeviceError('No usable Android devices are connected.', {
        hint:
          'Connect a device over USB, enable Developer Options -> USB debugging, and accept the ' +
          'authorization prompt. Verify with `adb devices`.',
      });
    }

    const infos: DeviceInfo[] = [];
    for (const listing of usable) {
      infos.push(await this.profile(listing.serial));
    }

    const ranked = assignRoles(infos);

    if (opts.minDevices && ranked.length < opts.minDevices) {
      throw new DeviceError(
        `${opts.minDevices} device(s) required but only ${ranked.length} available.`,
      );
    }

    if (ranked.length === 1) {
      this.logger?.warn(
        'Only one device connected - cross-device comparison (spec section 10) is unavailable. ' +
          'Results will show absolute risk but cannot separate retention from device budget.',
      );
    }

    for (const info of ranked) {
      this.logger?.info(`Device ${info.role}: ${describeDevice(info)}`);
    }

    return ranked;
  }

  /** Gather hardware and OS facts for one device. */
  async profile(serial: string): Promise<DeviceInfo> {
    const device = this.adb.device(serial);
    const props = await device.getAllProps();

    const totalRamBytes = await readTotalRam(device);
    const availableRamBytes = await readAvailableRam(device);
    const storageFreeBytes = await readFreeStorage(device);
    const procReadable = await probeProcReadable(device);

    const sdkInt = Number(props['ro.build.version.sdk'] ?? 0) || 0;
    const supportedAbis = (props['ro.product.cpu.abilist'] ?? props['ro.product.cpu.abi'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    return {
      serial,
      role: 'extra',
      model: props['ro.product.model'] ?? 'unknown',
      manufacturer: props['ro.product.manufacturer'] ?? 'unknown',
      brand: props['ro.product.brand'] ?? 'unknown',
      device: props['ro.product.device'] ?? 'unknown',
      androidVersion: props['ro.build.version.release'] ?? 'unknown',
      sdkInt,
      abi: props['ro.product.cpu.abi'] ?? 'unknown',
      supportedAbis,
      totalRamBytes,
      availableRamBytes,
      heapGrowthLimit: props['dalvik.vm.heapgrowthlimit'] ?? null,
      heapSize: props['dalvik.vm.heapsize'] ?? null,
      procReadable,
      storageFreeBytes,
      isEmulator:
        (props['ro.build.characteristics'] ?? '').includes('emulator') ||
        (props['ro.product.model'] ?? '').toLowerCase().includes('sdk') ||
        serial.startsWith('emulator-'),
      screen: await readScreenSize(device),
      isDebugBuild: (props['ro.build.type'] ?? 'user') !== 'user',
    };
  }
}

/**
 * Role assignment: lowest total RAM becomes Device A (the OOM canary), highest
 * becomes Device B (the headroom reference). With a single device we still
 * label it A, because absolute risk is what a one-device run measures.
 */
export function assignRoles(devices: DeviceInfo[]): DeviceInfo[] {
  const sorted = [...devices].sort((a, b) => a.totalRamBytes - b.totalRamBytes);
  return sorted.map((d, i) => ({
    ...d,
    role: i === 0 ? 'A' : i === sorted.length - 1 && sorted.length > 1 ? 'B' : 'extra',
  }));
}

async function readTotalRam(device: AdbDevice): Promise<number> {
  const out = await device.shellOut(['cat', '/proc/meminfo'], 20_000);
  const match = /MemTotal:\s+(\d+)\s*kB/.exec(out);
  return match?.[1] ? Number(match[1]) * 1024 : 0;
}

async function readAvailableRam(device: AdbDevice): Promise<number | null> {
  const out = await device.shellOut(['cat', '/proc/meminfo'], 20_000);
  const available = /MemAvailable:\s+(\d+)\s*kB/.exec(out);
  if (available?.[1]) return Number(available[1]) * 1024;
  const free = /MemFree:\s+(\d+)\s*kB/.exec(out);
  return free?.[1] ? Number(free[1]) * 1024 : null;
}

async function readFreeStorage(device: AdbDevice): Promise<number | null> {
  const out = await device.shellOut(['df', '/data'], 20_000);
  const lines = out.trim().split('\n');
  const dataLine = lines.find((l) => l.includes('/data')) ?? lines[lines.length - 1];
  if (!dataLine) return null;
  const cols = dataLine.trim().split(/\s+/);
  // df output on Android: Filesystem 1K-blocks Used Available Use% Mounted
  const available = cols.find((c, i) => i >= 3 && /^\d+$/.test(c));
  return available ? Number(available) * 1024 : null;
}

/**
 * Modern Android mounts /proc with hidepid, which blocks the cheap sampling
 * probe for release builds. We detect this once, up front, so the telemetry
 * sampler can pick its probe set instead of failing repeatedly at runtime.
 */
async function probeProcReadable(device: AdbDevice): Promise<boolean | null> {
  const res = await device.shell(['cat', '/proc/1/statm'], 15_000);
  if (res.code !== 0) return false;
  return /^\d+/.test(res.stdout.trim());
}

async function readScreenSize(device: AdbDevice): Promise<string | null> {
  const out = await device.shellOut(['wm', 'size'], 20_000);
  return /Physical size:\s*(\S+)/.exec(out)?.[1] ?? null;
}

export function describeDevice(info: DeviceInfo): string {
  const ram = info.totalRamBytes > 0 ? `${(info.totalRamBytes / (1024 * MB)).toFixed(1)} GB RAM` : 'RAM unknown';
  return `${info.manufacturer} ${info.model} - Android ${info.androidVersion} (API ${info.sdkInt}), ${ram}, ${info.abi} [${info.serial}]`;
}
