/**
 * Thermal and battery telemetry.
 *
 * Both matter for OOM work for the same underlying reason: a phone that is hot
 * throttles, a throttled phone renders slower, and a slower game holds assets
 * in memory for longer. A peak reached on a cool device and the same peak
 * reached on a throttling one are not the same result.
 *
 * The honest complication is battery drain. Running over USB adb normally means
 * the device is charging, and a charging device has no drain to measure. Rather
 * than report a meaningless number, the charging state is recorded with every
 * sample and the analysis refuses to state a drain figure for any session that
 * was plugged in. Temperature stays valid either way - and is usually the more
 * useful of the two.
 */
import type { AdbDevice } from '../devices/adb.js';
import { summarizeFrames, type FrameStats } from './fps.js';
import type { Logger } from '../core/logger.js';

export interface BatteryReading {
  levelPercent: number | null;
  /** True while any power source is attached. */
  charging: boolean;
  temperatureC: number | null;
  voltageMv: number | null;
  /** Coulomb counter in µAh, where the device exposes one. */
  chargeCounterUah: number | null;
}

export interface ThermalReading {
  /** Hottest thermal zone the kernel exposes, and which one it was. */
  maxZoneC: number | null;
  maxZoneName: string | null;
  /** Thermal status as Android itself classifies it. */
  status: ThermalStatus | null;
  /** True when the framework says the device is limiting performance. */
  throttling: boolean;
}

/** Android's own thermal severity ladder, from PowerManager. */
export type ThermalStatus =
  | 'none'
  | 'light'
  | 'moderate'
  | 'severe'
  | 'critical'
  | 'emergency'
  | 'shutdown';

const THERMAL_STATUS: ThermalStatus[] = [
  'none',
  'light',
  'moderate',
  'severe',
  'critical',
  'emergency',
  'shutdown',
];

/** Statuses at which the framework is actively sacrificing performance. */
const THROTTLING_FROM = 2; // moderate

/**
 * Parse `dumpsys battery`.
 *
 * Temperature is reported in tenths of a degree, and level in whole percent.
 * `AC/USB/Wireless powered` are separate booleans, so charging is any of them -
 * a device on a wireless pad still is not discharging.
 */
export function parseBatteryDump(text: string): BatteryReading {
  const num = (key: string): number | null => {
    const m = new RegExp(`^\\s*${key}:\\s*(-?\\d+)\\s*$`, 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  const bool = (key: string): boolean => {
    const m = new RegExp(`^\\s*${key}:\\s*(true|false)\\s*$`, 'm').exec(text);
    return m?.[1] === 'true';
  };

  const tenthsC = num('temperature');

  return {
    levelPercent: num('level'),
    charging: bool('AC powered') || bool('USB powered') || bool('Wireless powered'),
    temperatureC: tenthsC === null ? null : Math.round((tenthsC / 10) * 10) / 10,
    voltageMv: num('voltage'),
    chargeCounterUah: num('Charge counter'),
  };
}

/**
 * Parse `dumpsys thermalservice`.
 *
 * The line we want is `Thermal Status: N`, an index into Android's severity
 * ladder. Older releases have no thermalservice at all, which is why this
 * returns null rather than assuming "none" - "not measured" and "not hot" are
 * different claims.
 */
export function parseThermalStatus(text: string): { status: ThermalStatus | null; throttling: boolean } {
  const m = /Thermal Status:\s*(\d+)/i.exec(text);
  if (!m) return { status: null, throttling: false };

  const index = Number(m[1]);
  const status = THERMAL_STATUS[index] ?? null;
  return { status, throttling: index >= THROTTLING_FROM };
}

/**
 * Parse a batch read of /sys/class/thermal.
 *
 * Zone naming is entirely vendor-specific, so no attempt is made to interpret
 * which zone is the CPU or the GPU. The hottest zone and its name are reported
 * as-is, which is honest and still actionable: a name like `mtktsbattery` or
 * `gpuss-0` tells a developer where the heat is.
 *
 * Values are millidegrees on most kernels but plain degrees on a few. A reading
 * above 200 is taken as millidegrees, since no phone runs at 200 °C and no
 * phone idles at 0.2 °C.
 */
export function parseThermalZones(text: string): { maxZoneC: number | null; maxZoneName: string | null } {
  const zones = text.split('###').map((chunk) => chunk.trim()).filter(Boolean);

  let maxZoneC: number | null = null;
  let maxZoneName: string | null = null;

  for (const zone of zones) {
    const [name = '', raw = ''] = zone.split('|').map((p) => p.trim());
    const value = Number(raw);
    if (!name || !Number.isFinite(value) || value <= 0) continue;

    const celsius = value > 200 ? value / 1000 : value;
    // Anything past this is a sensor fault, not a phone.
    if (celsius < 5 || celsius > 150) continue;

    if (maxZoneC === null || celsius > maxZoneC) {
      maxZoneC = Math.round(celsius * 10) / 10;
      maxZoneName = name;
    }
  }

  return { maxZoneC, maxZoneName };
}

/**
 * Reads thermal and battery state for one device.
 *
 * Sampled on the deep cadence rather than the fast one: neither changes
 * meaningfully in a second, and both cost a shell round trip.
 */
export class DeviceHealthProbe {
  private zonesAvailable: boolean | null = null;
  private thermalServiceAvailable: boolean | null = null;

  constructor(
    private readonly device: AdbDevice,
    private readonly logger?: Logger,
  ) {}

  async battery(): Promise<BatteryReading | null> {
    const res = await this.device.shell(['dumpsys', 'battery'], 15_000);
    if (res.code !== 0) return null;
    return parseBatteryDump(res.stdout);
  }

  async thermal(): Promise<ThermalReading | null> {
    const zones = await this.readZones();
    const status = await this.readStatus();

    if (!zones && !status) return null;

    return {
      maxZoneC: zones?.maxZoneC ?? null,
      maxZoneName: zones?.maxZoneName ?? null,
      status: status?.status ?? null,
      throttling: status?.throttling ?? false,
    };
  }

  /**
   * Read every thermal zone in one shell call.
   *
   * A phone has 20-90 zones; reading them individually would be that many adb
   * round trips per sample. The `###` and `|` separators are chosen because no
   * zone type contains either.
   */
  private async readZones(): Promise<{ maxZoneC: number | null; maxZoneName: string | null } | null> {
    if (this.zonesAvailable === false) return null;

    const script =
      'for z in /sys/class/thermal/thermal_zone*; do ' +
      'printf "%s|%s###" "$(cat $z/type 2>/dev/null)" "$(cat $z/temp 2>/dev/null)"; done';

    const res = await this.device.script(script, 20_000);
    if (res.code !== 0 || res.stdout.trim().length === 0) {
      if (this.zonesAvailable === null) {
        this.zonesAvailable = false;
        this.logger?.debug('Thermal zones are not readable on this device');
      }
      return null;
    }

    this.zonesAvailable = true;
    return parseThermalZones(res.stdout);
  }

  private async readStatus(): Promise<{ status: ThermalStatus | null; throttling: boolean } | null> {
    if (this.thermalServiceAvailable === false) return null;

    const res = await this.device.shell(['dumpsys', 'thermalservice'], 15_000);
    if (res.code !== 0) {
      this.thermalServiceAvailable = false;
      return null;
    }

    const parsed = parseThermalStatus(res.stdout);
    if (parsed.status === null && this.thermalServiceAvailable === null) {
      // Present but silent about status; stop asking.
      this.thermalServiceAvailable = false;
      return null;
    }
    this.thermalServiceAvailable = true;
    return parsed;
  }
}

// ---------------------------------------------------------------------------
// Session-level summaries
// ---------------------------------------------------------------------------

export interface ThermalSummary {
  /**
   * Peak battery temperature.
   *
   * Kept apart from `peakC` because they are different sensors. `peakC` is the
   * hottest thermal zone the kernel exposes, which on most phones is a SoC or
   * GPU sensor and reads a degree or two above the battery. Other tools report
   * the battery figure, so this is the one to compare against them - and mixing
   * the two under one label is how a one-degree disagreement turns into an
   * argument about whose measurement is wrong.
   */
  peakBatteryC: number | null;
  startC: number | null;
  /**
   * Temperature at the end of the session, which is not the same as the peak: a
   * device can hit 46 degrees mid-session and settle back to 40. Both belong in
   * a report - the peak is what throttled, the end is the state the next
   * session would start from.
   */
  endC: number | null;
  peakC: number | null;
  /** Rise from the start of the session to its hottest point. */
  riseC: number | null;
  hottestZone: string | null;
  /** Worst thermal status Android reported during the session. */
  worstStatus: ThermalStatus | null;
  /** Seconds spent at moderate or worse, where performance is being limited. */
  throttlingMs: number;
  verdict: 'cool' | 'warm' | 'hot' | 'throttling' | 'unknown';
}

export interface BatterySummary {
  startPercent: number | null;
  endPercent: number | null;
  /** Battery temperature at each end - the one sensor every device exposes. */
  startTemperatureC: number | null;
  endTemperatureC: number | null;
  /** Percentage points consumed. Null whenever the device was charging. */
  drainPercent: number | null;
  /** Extrapolated to an hour, for comparing sessions of different lengths. */
  drainPercentPerHour: number | null;
  /** mAh consumed, where the device exposes a coulomb counter. */
  drainMah: number | null;
  /**
   * Net change in the fuel gauge, in mAh, whether charging or not.
   *
   * The reported level is a whole percent, so a three-minute session almost
   * always shows "no change" - which tells the reader nothing. The charge
   * counter in `dumpsys battery` moves in 5 mAh steps on this hardware, about a
   * tenth of a percent, so it sees what the level cannot. Signed: negative means
   * the battery lost charge, positive means the cable put more in than the game
   * took out. Reported even while charging, because unlike a drain figure a net
   * change is not a claim about what the game cost.
   */
  netChargeMah: number | null;
  startChargeUah: number | null;
  endChargeUah: number | null;
  /** True if any power source was attached at any point. */
  wasCharging: boolean;
  /** Why a drain figure is absent, when it is. */
  unavailableReason: string | null;
}

export interface HealthSample {
  elapsedMs: number;
  battery?: BatteryReading;
  thermal?: ThermalReading;
}

/**
 * Reduce a session's health samples to a thermal verdict.
 *
 * The rise matters more than the absolute: phones idle anywhere from 24 °C to
 * 35 °C depending on ambient and on what ran before, so "went up 14 degrees" is
 * comparable across sessions where "reached 41 degrees" is not.
 *
 * The temperature is the battery sensor's, not the hottest thermal zone's. A
 * zone is a chip: on a Galaxy A36 the `cpu-0-0` zone sat at 62.3 °C through a
 * session where the battery read 34.5 °C and another tool reported 33.3 °C. Both
 * numbers are true, but 62 °C is an ordinary temperature for a CPU die under
 * load and an alarming one for a phone, and reporting it as "the device
 * temperature" earned a session the verdict "hot" for running normally. The
 * battery sensor is also the only one that means the same thing on every
 * handset, so it is the only one worth comparing between runs or between tools.
 * The hottest zone is kept alongside as detail, not promoted to the headline.
 */
export function summarizeThermal(samples: HealthSample[]): ThermalSummary {
  const readings = samples.filter((s) => s.thermal);
  const temps = readings
    .map((s) => s.battery?.temperatureC ?? s.thermal!.maxZoneC ?? null)
    .filter((t): t is number => t !== null);

  if (temps.length === 0) {
    return {
      peakBatteryC: null,
      startC: null,
      endC: null,
      peakC: null,
      riseC: null,
      hottestZone: null,
      worstStatus: null,
      throttlingMs: 0,
      verdict: 'unknown',
    };
  }

  const startC = temps[0]!;
  const endC = temps[temps.length - 1]!;
  const peakC = Math.max(...temps);
  const riseC = Math.round((peakC - startC) * 10) / 10;

  const hottest = readings.reduce<{ c: number; zone: string | null }>(
    (best, s) => {
      const c = s.thermal!.maxZoneC ?? -Infinity;
      return c > best.c ? { c, zone: s.thermal!.maxZoneName } : best;
    },
    { c: -Infinity, zone: null },
  );

  let worstIndex = -1;
  for (const s of readings) {
    const i = s.thermal!.status ? THERMAL_STATUS.indexOf(s.thermal!.status) : -1;
    if (i > worstIndex) worstIndex = i;
  }
  const worstStatus = worstIndex >= 0 ? THERMAL_STATUS[worstIndex]! : null;

  // Time attributed to the sample that observed it, so a throttling window is
  // measured rather than counted.
  let throttlingMs = 0;
  for (let i = 1; i < readings.length; i++) {
    if (readings[i]!.thermal!.throttling) {
      throttlingMs += readings[i]!.elapsedMs - readings[i - 1]!.elapsedMs;
    }
  }

  const verdict: ThermalSummary['verdict'] =
    throttlingMs > 0 || (worstIndex >= THROTTLING_FROM)
      ? 'throttling'
      : peakC >= 45 || riseC >= 12
        ? 'hot'
        : peakC >= 38 || riseC >= 6
          ? 'warm'
          : 'cool';

  const batteryTemps = samples
    .map((s) => s.battery?.temperatureC)
    .filter((t): t is number => typeof t === 'number');

  return {
    peakBatteryC: batteryTemps.length > 0 ? Math.max(...batteryTemps) : null,
    startC: Math.round(startC * 10) / 10,
    endC: Math.round(endC * 10) / 10,
    peakC: Math.round(peakC * 10) / 10,
    riseC,
    hottestZone: hottest.zone,
    worstStatus,
    throttlingMs,
    verdict,
  };
}

/**
 * Reduce a session's health samples to a battery summary.
 *
 * Refuses to state a drain figure for a session that was plugged in at any
 * point, which over USB adb is the usual case. A number derived from a charging
 * device would look like a measurement and be meaningless.
 */
export function summarizeBattery(samples: HealthSample[], durationMs: number): BatterySummary {
  const readings = samples.map((s) => s.battery).filter((b): b is BatteryReading => Boolean(b));

  if (readings.length === 0) {
    return {
      startPercent: null,
      endPercent: null,
      startTemperatureC: null,
      endTemperatureC: null,
      drainPercent: null,
      drainPercentPerHour: null,
      drainMah: null,
      netChargeMah: null,
      startChargeUah: null,
      endChargeUah: null,
      wasCharging: false,
      unavailableReason: 'Battery state could not be read from this device.',
    };
  }

  const first = readings[0]!;
  const last = readings[readings.length - 1]!;
  const wasCharging = readings.some((r) => r.charging);

  /*
   * Signed net change in the fuel gauge. Available whether or not the cable was
   * in, because it makes no claim about what the game cost - it states what the
   * gauge did. Two decimals: the counter steps by 5 mAh, and rounding a 15 mAh
   * change to whole percent is how a session ends up reporting "no change".
   */
  const netChargeMah =
    first.chargeCounterUah !== null && last.chargeCounterUah !== null
      ? Math.round(((last.chargeCounterUah - first.chargeCounterUah) / 1000) * 100) / 100
      : null;
  const charge = {
    netChargeMah,
    startChargeUah: first.chargeCounterUah,
    endChargeUah: last.chargeCounterUah,
  };

  if (wasCharging) {
    return {
      startPercent: first.levelPercent,
      endPercent: last.levelPercent,
      startTemperatureC: first.temperatureC,
      endTemperatureC: last.temperatureC,
      drainPercent: null,
      drainPercentPerHour: null,
      drainMah: null,
      ...charge,
      wasCharging: true,
      unavailableReason:
        'The device was charging over USB for part or all of this session, so battery drain ' +
        'cannot be measured. To measure it, profile over wireless adb (`adb tcpip`) with the ' +
        'cable unplugged.',
    };
  }

  const drainPercent =
    first.levelPercent !== null && last.levelPercent !== null
      ? first.levelPercent - last.levelPercent
      : null;

  const hours = durationMs / 3_600_000;
  const drainMah =
    first.chargeCounterUah !== null && last.chargeCounterUah !== null
      ? Math.round((first.chargeCounterUah - last.chargeCounterUah) / 1000)
      : null;

  return {
    startPercent: first.levelPercent,
    endPercent: last.levelPercent,
    startTemperatureC: first.temperatureC,
    endTemperatureC: last.temperatureC,
    drainPercent,
    // Normalised so a 4-minute session and a 40-minute one can be compared.
    drainPercentPerHour:
      drainPercent !== null && hours > 0 ? Math.round((drainPercent / hours) * 10) / 10 : null,
    drainMah,
    ...charge,
    wasCharging: false,
    unavailableReason:
      drainPercent === null ? 'The device did not report a battery level.' : null,
  };
}

/**
 * Unity's `Mathf.RoundToInt`, which is not `Math.round`.
 *
 * `Mathf.RoundToInt(f)` is `(int)Math.Round(f)`, and .NET's `Math.Round`
 * defaults to round-half-to-even: 0.5 goes to 0, 1.5 goes to 2. Using
 * JavaScript's `Math.round` here would agree with the engine everywhere except
 * exact halves, which is precisely where a percentile index lands on an even
 * sample count - so the two would disagree only sometimes, which is worse than
 * disagreeing always.
 */
function roundHalfToEven(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction > 0.5) return floor + 1;
  if (fraction < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * One percentile of the per-second frame-rate samples.
 *
 * This is GDPerfTracker's formula, copied deliberately:
 *
 *     index = Clamp(RoundToInt((count - 1) * p), 0, count - 1)
 *
 * The report and the in-game recorder are meant to be read side by side - the
 * report has a whole section mapping its fields onto `fps_p01`, `fps_p50` and
 * the rest - so the two agreeing is the point, and any improvement of ours that
 * breaks that agreement is not an improvement.
 *
 * It replaced a nearest-rank index (`ceil(n * q) - 1`). Both return a rate the
 * game actually ran at, which was the property worth keeping; they simply pick
 * a different sample. They also agree far less often than a spot check
 * suggests: over sample counts from 5 to 400 they choose different samples for
 * about half of them at p01 and p99, and on a three-minute session - roughly
 * 180 samples - five of the seven published percentiles differ. One real
 * session agreed at every percentile, which is how this stayed invisible: 131
 * samples happens to be a count where the two formulas coincide.
 *
 * Expects `sortedAscending` already sorted; `q` is a fraction, so 0.01 for p01.
 */
export function fpsPercentile(sortedAscending: number[], q: number): number {
  if (sortedAscending.length === 0) return 0;
  const index = Math.min(
    sortedAscending.length - 1,
    Math.max(0, roundHalfToEven((sortedAscending.length - 1) * q)),
  );
  return sortedAscending[index]!;
}

/**
 * The percentile ladder over the per-second samples.
 *
 * Field names follow the studio's in-game recorder (GDPerfTracker) so a report
 * and an analytics payload from the same build can be read side by side. The
 * quantity is the same in both: the rate over each one-second bucket, sorted,
 * not the interval between individual frames.
 *
 * That distinction matters and is easy to lose. `low1PercentFps` elsewhere in
 * this summary is the mean of the worst 1% of *frames*, which on one real
 * session read 5.2 fps; `p01` here is the 1st percentile of *seconds*, which on
 * the same session read 20. Neither is wrong - a single 700 ms frame is a real
 * freeze, and a whole second averaging 20 fps is a different complaint - but
 * comparing one against the other reads as a discrepancy where there is none.
 */
export interface FpsPercentiles {
  /** The player's worst moments. A game averaging 40 with a p01 of 8 feels broken. */
  p01: number;
  /** Whether slowdowns are frequent: far below p50 means often, not one-off. */
  p05: number;
  p25: number;
  /** The typical second. Same value as `medianFps`, named for the ladder. */
  p50: number;
  p75: number;
  /** Near-best. At the cap means the device has headroom. */
  p95: number;
  /** Best sustained. Far under the cap means the device can never reach target. */
  p99: number;
}

export interface FpsSummary {
  averageFps: number | null;
  /**
   * Median frame rate: the middle value of the per-second samples.
   *
   * This is the figure other tools label "median FPS", and it is the one to
   * compare against them - the midpoint of the curve on the chart. Reported
   * beside the average because they answer different questions: one long stall
   * drags an average down but barely moves a median.
   */
  medianFps: number | null;
  /**
   * One over the median gap between frames.
   *
   * A different quantity from `medianFps`, despite both being "medians". This
   * one describes how fast the game renders *when it renders*; the other how
   * many frames a second actually arrived. Measured on a real session: 58.8 here
   * against 32.9 delivered, which is a game producing frames at nearly 60 and
   * then stalling - a shape neither figure shows on its own.
   */
  typicalFrameFps: number | null;
  /** One over the longest single frame in the session. */
  minFrameFps: number | null;
  maxFrameFps: number | null;
  /** Average frame rate of the worst 1% of frames. */
  low1PercentFps: number | null;
  longestFrameMs: number | null;
  /** Frames over one display refresh period. */
  smallJanks: number | null;
  /** Frames over 83 ms - a stall a player felt. */
  janks: number | null;
  /** Frames over 125 ms. */
  bigJanks: number | null;
  /**
   * What a GameBench-style counter would report: frames over twice the typical
   * interval. The figure to hold against another tool's headline jank number.
   */
  crossToolJanks: number | null;
  janksPerMinute: number | null;
  /** Every frame counted, across every window. */
  totalFrames: number | null;
  /** The panel's refresh rate - a device property, not the game's. */
  displayHz: number | null;
  /**
   * True when the game's rate sat at the panel's refresh rate for most of the
   * session. Worth stating plainly: a developer who set a frame-rate cap and
   * sees this is looking at a cap that is not applying.
   */
  matchesDisplayRate: boolean | null;
  minFps: number | null;
  /**
   * Share of the session spent within ±20% of the median rate, 0-100.
   *
   * The industry figure ("FPS stability"): over 75 reads as stable around the
   * median, 80 as good. Time-weighted where windows report their length, for the
   * same reason the average is - a 0.4 s stall must not count like a 2 s stretch.
   */
  stabilityPercent: number | null;
  /** 1st percentile of sampled rates - the stutter a player actually notices. */
  lowPercentileFps: number | null;
  /** The whole ladder, for reading against a cap rather than against 60. */
  percentiles: FpsPercentiles | null;
  /**
   * The session's merged frame-interval histogram - the raw distribution the
   * jank counts are derived from, carried so the report can draw it.
   */
  frameBuckets: Array<{ ms: number; count: number }> | null;
  sampleCount: number;
  jankPercent: number | null;
  worstFrameMs: number | null;
  source: string | null;
}

/**
 * Reduce frame-rate samples to a summary.
 *
 * The average is total frames over total measured time, which is what "average
 * FPS" means everywhere else and what makes it comparable with another tool.
 *
 * It used to weight each window by its own frame count, on the reasoning that a
 * window capturing 120 frames says more about the session than one capturing 4.
 * That reasoning is backwards: weighting by frame count gives the fast windows
 * more say precisely because they were fast, which is the same thing as
 * discounting the stalls. On a real 168-second session it reported 41.0 fps
 * where the true average was 38.6 - a flattering 2.4 fps, and 2.4 fps further
 * from the 37 another tool measured on the same game. A stall should pull the
 * average down by exactly as much time as it took, and dividing frames by time
 * does that on its own.
 */
export function summarizeFps(
  readings: Array<{
    fps: number;
    displayHz?: number | null;
    matchesDisplayRate?: boolean | null;
    frames?: FrameStats | undefined;
    frameCount: number;
    /** How long this window covered. Needed to average over time. */
    windowMs?: number | null;
    jankPercent: number | null;
    worstFrameMs: number | null;
    source: string;
  }>,
  durationMs = 0,
): FpsSummary {
  if (readings.length === 0) {
    return {
      averageFps: null,
      medianFps: null,
      typicalFrameFps: null,
      minFrameFps: null,
      maxFrameFps: null,
      low1PercentFps: null,
      longestFrameMs: null,
      smallJanks: null,
      janks: null,
      bigJanks: null,
      crossToolJanks: null,
      janksPerMinute: null,
      totalFrames: null,
      displayHz: null,
      matchesDisplayRate: null,
      minFps: null,
      stabilityPercent: null,
      lowPercentileFps: null,
      percentiles: null,
      frameBuckets: null,
      sampleCount: 0,
      jankPercent: null,
      worstFrameMs: null,
      source: null,
    };
  }

  const totalFrames = readings.reduce((sum, r) => sum + r.frameCount, 0);
  const measuredMs = readings.reduce((sum, r) => sum + (r.windowMs ?? 0), 0);
  /*
   * Frames over the time actually covered by the windows, not over the session:
   * a window that failed to parse contributed no frames, and charging its
   * seconds against the frames the others did capture would report a rate the
   * game never ran at. Where no window reported its length there is nothing to
   * divide by, and the mean of the per-second rates is the closest honest
   * answer - it agrees exactly when the windows are of equal length.
   */
  /*
   * Frames over measured time, which is also the recorder's `fps_avg` wherever
   * the two can be compared.
   *
   * The recorder computes `sum / _fpsSamples.Count` - the mean of its
   * per-second buckets - and its buckets are all one second, so for its own
   * data the two definitions are the same number. On a real session here they
   * differed by 0.05 fps.
   *
   * They part company only when windows are *unequal*, and then this one is
   * right and the mean is not: switching to the mean turned a 2 s window at
   * 60 fps followed by a 0.4 s stall at 10 fps into an average of 35, where
   * 124 frames over 2.4 s is 51.7. Giving a 0.4 s stall the same weight as a
   * 2 s stretch of smooth play is the same error as the frame-weighted mean
   * this replaced, pointing the other way.
   *
   * The mean stays as the fallback for a summary built without window lengths,
   * where every window has to be assumed equal anyway.
   */
  const averageFps =
    measuredMs > 0
      ? totalFrames / (measuredMs / 1000)
      : readings.reduce((sum, r) => sum + r.fps, 0) / readings.length;

  const sorted = [...readings].map((r) => r.fps).sort((a, b) => a - b);
  const at = (q: number): number => fpsPercentile(sorted, q);

  const jankSamples = readings.filter((r) => r.jankPercent !== null);
  const worst = readings.reduce<number | null>(
    (w, r) => (r.worstFrameMs !== null && (w === null || r.worstFrameMs > w) ? r.worstFrameMs : w),
    null,
  );

  /*
   * The refresh rate the session mostly ran at, not the first one seen.
   *
   * Adaptive panels change rate, and they idle low: on a Galaxy A36 the first
   * four windows of a session reported 30 Hz while the game was still starting,
   * and the remaining 138 reported 60 Hz. Taking the first reading judged the
   * whole session against 30 Hz, which halves the per-frame budget and made a
   * game holding a solid 60 fps look like it never missed a refresh - 12 counted
   * where the true figure was about 179. Each window's own stats already use the
   * rate that window saw; this is only for the session-wide histogram, where the
   * rate the session spent its time at is the only sensible answer.
   */
  const hzCounts = new Map<number, number>();
  for (const r of readings) {
    if (typeof r.displayHz === 'number') {
      hzCounts.set(r.displayHz, (hzCounts.get(r.displayHz) ?? 0) + 1);
    }
  }
  const hz =
    [...hzCounts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? null;

  // "Most of the session", not "ever": one window at the panel's rate during a
  // loading screen is not the same claim as a game that never left it.
  const matching = readings.filter((r) => r.matchesDisplayRate === true).length;
  const judged = readings.filter((r) => typeof r.matchesDisplayRate === 'boolean').length;

  /*
   * Frame-level figures, computed once over the whole session.
   *
   * The histograms from every window are merged and reduced together rather than
   * each window being reduced and the results averaged. That distinction is not
   * cosmetic: a median of medians is not a median, and taking the worst window's
   * worst-1% is not the session's worst 1% - it is systematically pessimistic.
   * The published definition is "the worst 1% of frame times since the beginning
   * of the session", and merging is the only way to answer that question.
   */
  const framed = readings
    .map((r) => r.frames)
    .filter((f): f is FrameStats => Boolean(f) && f!.frameCount > 0);

  const merged = new Map<number, number>();
  for (const window of framed) {
    for (const bucket of window.buckets) {
      merged.set(bucket.ms, (merged.get(bucket.ms) ?? 0) + bucket.count);
    }
  }

  const session =
    merged.size > 0
      ? summarizeFrames(
          [...merged].map(([ms, count]) => ({ ms, count })),
          hz,
        )
      : null;

  const frameTotal = session?.frameCount ?? 0;
  const janks = session?.janks ?? null;
  const worstFrameMs = session?.longestFrameMs ?? null;

  // The middle of the per-second samples, which is what a chart's midpoint shows
  // and what other tools mean by "median FPS".
  const sampled = readings.map((r) => r.fps).sort((a, b) => a - b);
  const medianFps =
    sampled.length > 0 ? Math.round(sampled[Math.floor(sampled.length / 2)]! * 10) / 10 : null;

  /*
   * FPS stability: the share of session time within ±20% of the median rate.
   *
   * This is the standard definition (proportion of *time*, not of samples), so
   * windows are weighted by their length where they report one - the same
   * reasoning as the average above. Falls back to a per-sample share when no
   * window carries a length, where every window has to be assumed equal anyway.
   * The band is judged against the same median the summary reports, so the two
   * figures cannot disagree about what "the middle" was.
   */
  let stabilityPercent: number | null = null;
  if (medianFps !== null && medianFps > 0) {
    const lo = medianFps * 0.8;
    const hi = medianFps * 1.2;
    let inBand = 0;
    let weighed = 0;
    for (const r of readings) {
      const weight = r.windowMs != null && r.windowMs > 0 ? r.windowMs : measuredMs > 0 ? 0 : 1;
      if (weight <= 0) continue;
      weighed += weight;
      if (r.fps >= lo && r.fps <= hi) inBand += weight;
    }
    if (weighed > 0) stabilityPercent = Math.round((inBand / weighed) * 1000) / 10;
  }

  return {
    averageFps: totalFrames > 0 ? Math.round(averageFps * 10) / 10 : null,
    medianFps,
    typicalFrameFps: session?.medianFps ?? null,
    // The worst single frame in the whole session, not an average of worsts.
    minFrameFps: session?.minFps ?? null,
    maxFrameFps: session?.maxFps ?? null,
    low1PercentFps: session?.low1PercentFps ?? null,
    longestFrameMs: worstFrameMs,
    smallJanks: session?.smallJanks ?? null,
    janks,
    bigJanks: session?.bigJanks ?? null,
    crossToolJanks: session?.crossToolJanks ?? null,
    janksPerMinute:
      janks !== null && durationMs > 0
        ? Math.round((janks / (durationMs / 60_000)) * 10) / 10
        : null,
    totalFrames: frameTotal > 0 ? frameTotal : null,
    displayHz: hz,
    matchesDisplayRate: judged > 0 ? matching / judged > 0.75 : null,
    minFps: sorted[0] ?? null,
    stabilityPercent,
    // The same figure as `percentiles.p01`, kept under its older name. It used
    // to be computed separately with a different index, so the two disagreed.
    lowPercentileFps: sorted.length > 0 ? at(0.01) : null,
    percentiles:
      sorted.length > 0
        ? {
            p01: at(0.01),
            p05: at(0.05),
            p25: at(0.25),
            p50: at(0.5),
            p75: at(0.75),
            p95: at(0.95),
            p99: at(0.99),
          }
        : null,
    frameBuckets: session && session.buckets.length > 0 ? session.buckets : null,
    sampleCount: readings.length,
    jankPercent:
      jankSamples.length > 0
        ? Math.round(
            (jankSamples.reduce((sum, r) => sum + r.jankPercent!, 0) / jankSamples.length) * 10,
          ) / 10
        : null,
    worstFrameMs: worst,
    source: readings[0]!.source,
  };
}

// ---------------------------------------------------------------------------
// Ratings
// ---------------------------------------------------------------------------

/**
 * A word beside each number, so a reader who does not know what good looks like
 * still gets an answer.
 *
 * The thresholds are ours. GameBench shows labels of this kind but does not
 * publish its cut-offs, so inventing numbers and attributing them there would
 * be dishonest - these are stated in the report as the tool's own judgement,
 * and they are deliberately simple enough to argue with.
 */
export type Rating = 'excellent' | 'good' | 'fair' | 'poor' | 'unknown';

export const RATING_LABEL: Record<Rating, string> = {
  excellent: 'Excellent',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  unknown: 'Not measured',
};

/**
 * Rate a frame rate against what the build was aiming for.
 *
 * Judged as a share of the target rather than against a fixed number: a game
 * holding 29 of a 30 target is doing its job, and one holding 29 of a 60 target
 * is missing half its frames. Where no target is known the panel's refresh rate
 * stands in, since that is the ceiling the hardware allows.
 */
export function rateFps(fps: number | null, target: number | null): Rating {
  if (fps === null || target === null || target <= 0) return 'unknown';

  const share = fps / target;
  if (share >= 0.95) return 'excellent';
  if (share >= 0.85) return 'good';
  if (share >= 0.7) return 'fair';
  return 'poor';
}

/**
 * Rate stutter by how often it happens, not how much there was.
 *
 * Per minute rather than a total, because a session twice as long collects twice
 * as many janks without being twice as bad.
 */
export function rateJanks(janks: number | null, durationMs: number): Rating {
  if (janks === null || durationMs <= 0) return 'unknown';

  const perMinute = janks / (durationMs / 60_000);
  if (perMinute < 0.5) return 'excellent';
  if (perMinute <= 2) return 'good';
  if (perMinute <= 6) return 'fair';
  return 'poor';
}

/** Rate heat by the rise, which travels between sessions as an absolute does not. */
export function rateHeat(riseC: number | null, throttling: boolean): Rating {
  if (throttling) return 'poor';
  if (riseC === null) return 'unknown';
  if (riseC < 3) return 'excellent';
  if (riseC < 7) return 'good';
  if (riseC < 12) return 'fair';
  return 'poor';
}

export const RATING_BASIS =
  'Ratings are this tool’s own, not an industry standard. Frame rate is judged as a share of ' +
  'the target the build was aiming for (95% or better is excellent, 85% good, 70% fair). Stutter ' +
  'is judged per minute rather than as a total, because a longer session collects more janks ' +
  'without being worse. Heat is judged by how far it rose during play.';
