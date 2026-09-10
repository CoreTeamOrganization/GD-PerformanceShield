/**
 * Frame rate measurement.
 *
 * Why this needs three strategies rather than one:
 *
 * `dumpsys gfxinfo` counts frames drawn through Android's View system (HWUI),
 * and a Unity game draws through its own GL or Vulkan surface instead. On a
 * Unity build it therefore reports zero frames - not because the game is slow,
 * but because it cannot see it.
 *
 * SurfaceFlinger *can* see it, because every app presents through the
 * compositor. But its two interfaces are not interchangeable. `--latency` is
 * legacy: deprecated by Android 10 and returning an empty buffer on many
 * Android 13+ builds even though the option still exists. `--timestats`
 * replaced it, is per-layer, and reports an average frame rate directly - so
 * that is tried first.
 *
 * All three measure *presented* frames, which is what a player experiences.
 * None of them sees the frame rate the engine intended.
 */
import type { AdbDevice } from '../devices/adb.js';
import type { Logger } from '../core/logger.js';

export type FpsSource = 'timestats' | 'surfaceflinger' | 'gfxinfo';

/** One strategy that was tried, and what came back. */
export interface FpsAttempt {
  strategy: string;
  ok: boolean;
  /** Phrased for an operator, because this is what gets shown when none works. */
  detail: string;
}

export interface FpsReading {
  /**
   * The **application's** frame rate: frames the game submitted to the
   * compositor, divided by wall-clock time.
   *
   * This is the game's own output, not the screen's refresh rate. The
   * distinction matters and is easy to get wrong: SurfaceFlinger also reports an
   * `averageFPS` per layer, computed as one over the mean gap between frames,
   * and that figure is both quantised to whole milliseconds and blind to gaps -
   * on a real handset it read 62.5 where the game was actually producing 59.6.
   * So the count over a window we timed ourselves is what is reported.
   */
  fps: number;
  /**
   * The panel's refresh rate, which is a property of the device rather than of
   * the game. Carried so a report can say whether the game is tracking the
   * screen or running below it.
   */
  displayHz: number | null;
  /**
   * True when the app's rate is at the panel's refresh rate.
   *
   * Worth flagging on its own: a developer who set a frame-rate cap and sees
   * this is looking at a cap that is not applying. In Unity,
   * `Application.targetFrameRate` is ignored whenever
   * `QualitySettings.vSyncCount` is non-zero.
   */
  matchesDisplayRate: boolean | null;
  frameCount: number;
  windowMs: number;
  /**
   * Per-frame figures for this window: median, worst 1%, and jank counts.
   *
   * Absent where the source cannot report frame times. An average over a
   * five-second window cannot see a single 118 ms stall, and that stall is
   * exactly what a player notices - so this is where the useful detail is.
   */
  frames?: FrameStats;
  /** Share of frames that took more than twice the display's refresh interval. */
  jankPercent: number | null;
  worstFrameMs: number | null;
  source: FpsSource;
}

/** A layer name SurfaceFlinger will accept, plus what it belongs to. */
export interface SurfaceLayer {
  name: string;
}

/**
 * Pick the game's own surface out of SurfaceFlinger's layer list.
 *
 * A running app has several layers - the window, its dim layer, sometimes a
 * splash - and only the one the game presents into carries frame timestamps.
 * Unity draws into a SurfaceView, so that is preferred where it exists.
 */
export function pickGameLayer(listing: string, packageName: string): string | null {
  const candidates = listing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.includes(packageName));

  if (candidates.length === 0) return null;

  // Layers that never carry frames, only compositing state.
  const noise = /^(Dim Layer|ColorLayer|BackColorSurface|Task=|Wallpaper)/i;
  const usable = candidates.filter((c) => !noise.test(c));
  if (usable.length === 0) return null;

  // Unity presents through a SurfaceView; that layer is the game's own output.
  return (
    usable.find((c) => /SurfaceView/i.test(c)) ??
    usable.find((c) => /UnityPlayerActivity/i.test(c)) ??
    usable[usable.length - 1]! // topmost, which is the foreground window
  );
}

/**
 * Parse `dumpsys SurfaceFlinger --latency <layer>`.
 *
 * Format: a refresh period in nanoseconds on the first line, then up to 128 rows
 * of three timestamps - when the frame was wanted, when it was actually
 * presented, and when the app finished drawing it. Frame rate comes from the
 * spacing of the *actual present* column, because that is when the player saw it.
 *
 * Rows are dropped rather than guessed at when a timestamp is a placeholder:
 * `0` means the slot was never filled, and INT64_MAX means the frame was still
 * pending when the buffer was read. Treating either as a real time would
 * manufacture an enormous frame interval and destroy the average.
 */
export function parseSurfaceFlingerLatency(text: string): FpsReading | null {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) return null;

  const refreshNs = Number(lines[0]);
  if (!Number.isFinite(refreshNs) || refreshNs <= 0) return null;

  const PENDING = 9223372036854775807; // INT64_MAX
  const presented: number[] = [];

  for (const line of lines.slice(1)) {
    const parts = line.split(/\s+/).map(Number);
    if (parts.length < 3 || parts.some((p) => !Number.isFinite(p))) continue;

    const actual = parts[1]!;
    if (actual === 0 || actual >= PENDING) continue;
    presented.push(actual);
  }

  if (presented.length < 2) return null;

  presented.sort((a, b) => a - b);
  const spanNs = presented[presented.length - 1]! - presented[0]!;
  if (spanNs <= 0) return null;

  // n timestamps bound n-1 intervals.
  const intervals = presented.length - 1;
  const fps = (intervals * 1e9) / spanNs;

  // Jank against the display's own refresh interval rather than a fixed 60 Hz:
  // a 90 Hz or 120 Hz panel has a different budget per frame.
  const jankThresholdNs = refreshNs * 2;
  let janky = 0;
  let worstNs = 0;
  for (let i = 1; i < presented.length; i++) {
    const gap = presented[i]! - presented[i - 1]!;
    if (gap > jankThresholdNs) janky++;
    if (gap > worstNs) worstNs = gap;
  }

  return {
    fps: Math.round(fps * 10) / 10,
    // The latency buffer carries a refresh period but not the panel's advertised
    // rate, and deriving one from the other would be a guess.
    displayHz: Math.round(1e9 / refreshNs),
    matchesDisplayRate: null,
    frameCount: presented.length,
    windowMs: Math.round(spanNs / 1e6),
    jankPercent: Math.round((janky / intervals) * 1000) / 10,
    worstFrameMs: Math.round((worstNs / 1e6) * 10) / 10,
    source: 'surfaceflinger',
  };
}

/**
 * Aggregate counters from `dumpsys gfxinfo <package>`.
 *
 * Cumulative since the process started, so a rate needs two readings. Returned
 * raw for the caller to difference.
 */
export interface GfxInfoCounters {
  totalFrames: number;
  jankyFrames: number;
}

export function parseGfxInfo(text: string): GfxInfoCounters | null {
  const total = /Total frames rendered:\s*(\d+)/i.exec(text)?.[1];
  if (!total) return null;

  const janky = /Janky frames:\s*(\d+)/i.exec(text)?.[1] ?? '0';
  return { totalFrames: Number(total), jankyFrames: Number(janky) };
}

/**
 * Samples frame rate for one app on one device.
 *
 * Stateful, because every strategy needs it: TimeStats has to be switched on,
 * the legacy layer name is resolved once, and the gfxinfo fallback works on
 * differences between readings.
 *
 * Strategies are tried in order of how well they see a Unity game:
 *
 *   1. TimeStats     per-layer, supported on Android 10+, reports FPS directly
 *   2. --latency     legacy per-layer buffer; deprecated, empty on many 13+ builds
 *   3. gfxinfo       counts View-system frames only, so it under-reports Unity
 *
 * Every attempt is recorded. When none works the operator gets the list of what
 * was tried and what came back, because "not measurable" on its own is not
 * something anyone can act on.
 */
export class FpsSampler {
  private layer: string | null = null;
  private timeStatsLayer: string | null = null;
  private source: FpsSource | null = null;
  private lastGfx: { counters: GfxInfoCounters; at: number } | null = null;
  private lastTimeStatsAt = 0;
  /**
   * The previous cumulative reading, so a window can be taken as a difference.
   *
   * TimeStats counts from whenever it was last cleared, and the obvious way to
   * get one second's worth is to clear it every second. That costs a second
   * SurfaceFlinger call per sample - and SurfaceFlinger takes its own lock to
   * answer, so every call is a chance to hold up composition - and it loses
   * every frame that lands between the dump and the clear. Diffing the
   * cumulative counters instead needs one call, drops nothing, and cancels the
   * round-trip latency: both ends of the window now carry the same offset
   * between being asked and being snapshotted.
   */
  private prevTimeStats: Map<
    string,
    { totalFrames: number; droppedFrames: number; buckets: Map<number, number> }
  > = new Map();
  private readonly attempts: FpsAttempt[] = [];

  constructor(
    private readonly device: AdbDevice,
    private readonly packageName: string,
    private readonly logger?: Logger,
  ) {}

  /** What was tried, and why each one did or did not work. */
  get diagnostics(): FpsAttempt[] {
    return this.attempts;
  }

  private note(strategy: string, ok: boolean, detail: string): void {
    this.attempts.push({ strategy, ok, detail });
  }

  /**
   * Work out which strategy this device and build support.
   *
   * Done once, before the session, so the manifest records how frame rate was
   * measured: two runs measured different ways are not comparable, and the
   * report has to be able to say which was used.
   */
  async prepare(): Promise<FpsSource | null> {
    if (await this.prepareTimeStats()) return this.source;
    if (await this.prepareLatency()) return this.source;
    if (await this.prepareGfxInfo()) return this.source;

    this.logger?.warn('Frame rate cannot be measured on this device', {
      attempts: this.attempts,
    });
    return null;
  }

  // ---- 1. TimeStats -------------------------------------------------------

  private async prepareTimeStats(): Promise<boolean> {
    const enable = await this.timeStats(['-enable']);
    if (enable === null) {
      this.note('SurfaceFlinger TimeStats', false, 'The --timestats option is not available.');
      return false;
    }

    await this.timeStats(['-clear']);

    // TimeStats needs frames to have gone past before it has anything to
    // report, so availability is judged on whether the game's layer appears at
    // all rather than on a frame count.
    const dump = await this.timeStats(['-dump', '-maxlayers', '32']);
    if (dump === null) {
      this.note('SurfaceFlinger TimeStats', false, 'Enabled, but -dump returned nothing.');
      return false;
    }

    const layers = parseTimeStats(dump);
    const mine = layers.find((l) => layerBelongsTo(l.layer, this.packageName));

    if (!mine) {
      this.note(
        'SurfaceFlinger TimeStats',
        false,
        layers.length > 0
          ? `Working, but no layer belongs to ${this.packageName} yet. ` +
            `Layers seen: ${layers.map((l) => l.layer).slice(0, 4).join(', ')}`
          : 'Working, but reported no layers at all.',
      );
      // Still the best strategy: the layer appears once the game draws a frame,
      // and the game may not have rendered anything when this ran.
      this.source = 'timestats';
      this.lastTimeStatsAt = Date.now();
      this.note('SurfaceFlinger TimeStats', true, 'Selected; waiting for the game to draw.');
      return true;
    }

    this.timeStatsLayer = mine.layer;
    this.source = 'timestats';
    this.lastTimeStatsAt = Date.now();
    /*
     * Baseline every surface the game already has, not just the first.
     *
     * Otherwise a game that starts with two surfaces - a splash and the one it
     * will keep - has to spend a whole extra sample discovering the second,
     * and if the first is the one that goes quiet that sample reports nothing.
     * Baselining so the first real sample reports its own second rather than
     * everything drawn since TimeStats was switched on.
     */
    for (const layer of layers) {
      if (layerBelongsTo(layer.layer, this.packageName)) this.sinceLastRead(layer);
    }
    this.note('SurfaceFlinger TimeStats', true, `Using layer ${mine.layer}`);
    this.logger?.info('Frame rate from SurfaceFlinger TimeStats', { layer: mine.layer });
    return true;
  }

  /** One TimeStats call. Returns null when the option is unsupported. */
  private async timeStats(args: string[]): Promise<string | null> {
    const res = await this.device.shell(
      ['dumpsys', 'SurfaceFlinger', '--timestats', ...args],
      20_000,
    );
    if (res.code !== 0) return null;
    // Unknown options make SurfaceFlinger print its usage rather than fail.
    if (/unknown option|usage:/i.test(res.stdout)) return null;
    return res.stdout;
  }

  // ---- 2. Legacy --latency ------------------------------------------------

  private async prepareLatency(): Promise<boolean> {
    const listing = await this.device.shell(['dumpsys', 'SurfaceFlinger', '--list'], 15_000);
    if (listing.code !== 0) {
      this.note('SurfaceFlinger --latency', false, 'Could not list layers.');
      return false;
    }

    this.layer = pickGameLayer(listing.stdout, this.packageName);
    if (!this.layer) {
      const sample = listing.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 4)
        .join(', ');
      this.note(
        'SurfaceFlinger --latency',
        false,
        `No layer names contain ${this.packageName}. First few layers: ${sample}`,
      );
      return false;
    }

    // Several vendors keep the option but return an empty buffer, and finding
    // that out mid-session would cost the run.
    const probe = await this.readSurfaceFlinger();
    if (!probe) {
      this.note(
        'SurfaceFlinger --latency',
        false,
        `Found layer ${this.layer}, but the latency buffer was empty. This option is legacy and ` +
          'returns nothing on many Android 13 and newer builds.',
      );
      return false;
    }

    this.source = 'surfaceflinger';
    this.note('SurfaceFlinger --latency', true, `Using layer ${this.layer}`);
    this.logger?.info('Frame rate from SurfaceFlinger --latency', { layer: this.layer });
    return true;
  }

  // ---- 3. gfxinfo ---------------------------------------------------------

  private async prepareGfxInfo(): Promise<boolean> {
    const res = await this.device.shell(['dumpsys', 'gfxinfo', this.packageName], 20_000);
    if (res.code !== 0) {
      this.note('gfxinfo', false, 'The app reported no graphics info.');
      return false;
    }

    const counters = parseGfxInfo(res.stdout);
    if (!counters) {
      this.note('gfxinfo', false, 'No frame counters in the output.');
      return false;
    }

    if (counters.totalFrames === 0) {
      // The normal Unity case: the game draws through its own surface, so the
      // View system has rendered nothing and never will.
      this.note(
        'gfxinfo',
        false,
        'Reports 0 frames rendered. Expected for a Unity game: Unity draws through its own ' +
          'surface rather than through Android’s View system, so gfxinfo cannot see it.',
      );
      return false;
    }

    // Seed the baseline here rather than rejecting the strategy for not having
    // one: the first reading can only ever establish it.
    this.lastGfx = { counters, at: Date.now() };
    this.source = 'gfxinfo';
    this.note('gfxinfo', true, `${counters.totalFrames} frames rendered so far.`);
    this.logger?.info(
      'Frame rate from gfxinfo. For a Unity build this usually under-reports, because Unity ' +
        'draws through its own surface rather than through the View system.',
    );
    return true;
  }

  // ---- sampling -----------------------------------------------------------

  async sample(): Promise<FpsReading | null> {
    if (this.source === 'timestats') return this.readTimeStats();
    if (this.source === 'surfaceflinger') return this.readSurfaceFlinger();
    if (this.source === 'gfxinfo') return this.readGfxInfo();
    return null;
  }

  /**
   * One TimeStats window.
   *
   * Cleared after reading so the next sample covers the interval since this one
   * rather than the whole session, which would flatten every dip into an
   * ever-smoother average.
   */
  /**
   * One window's frames, as the change since the previous read.
   *
   * Returns null when the counters have gone backwards, which happens when
   * SurfaceFlinger resets its stats or the game's layer is recreated - on an
   * orientation change, or when the game reloads its surface. There is no
   * sensible window to report across a reset, so this re-baselines and skips the
   * sample rather than emitting a negative or absurd frame count.
   */
  private sinceLastRead(now: LayerFrameStats): LayerFrameStats | null {
    const buckets = new Map(now.buckets.map((b) => [b.ms, b.count]));
    // Keyed by layer, because a game can have more than one surface over a
    // session and each counts from its own start. Sharing one slot between them
    // made every swap look like the counters going backwards.
    const prev = this.prevTimeStats.get(now.layer) ?? null;
    this.prevTimeStats.set(now.layer, {
      totalFrames: now.totalFrames,
      droppedFrames: now.droppedFrames,
      buckets,
    });
    if (prev === null) return null;

    if (now.totalFrames < prev.totalFrames || now.droppedFrames < prev.droppedFrames) {
      this.logger?.debug('Frame counters went backwards; re-baselining', {
        was: prev.totalFrames,
        now: now.totalFrames,
      });
      return null;
    }

    const delta: Array<{ ms: number; count: number }> = [];
    for (const [ms, count] of buckets) {
      const before = prev.buckets.get(ms) ?? 0;
      if (count < before) return null;
      if (count > before) delta.push({ ms, count: count - before });
    }

    return {
      ...now,
      totalFrames: now.totalFrames - prev.totalFrames,
      droppedFrames: now.droppedFrames - prev.droppedFrames,
      buckets: delta,
    };
  }

  private async readTimeStats(): Promise<FpsReading | null> {
    /*
     * The window ends when the dump is *asked for*, not when it comes back.
     *
     * This was measuring from one response to the next, which put the adb and
     * dumpsys round trip - a few hundred milliseconds - into the denominator
     * while the frame count only covered up to the moment SurfaceFlinger took
     * its snapshot. On a one-second cadence that latency is a quarter of the
     * window, and it dragged every reading about 25% low: a session whose
     * per-second rates should have sat around 42 fps reported 32.
     */
    const requestedAt = Date.now();
    const windowMs = Math.max(1, requestedAt - this.lastTimeStatsAt);

    const dump = await this.timeStats(['-dump', '-maxlayers', '32']);
    if (dump === null) return null;

    const layers = parseTimeStats(dump);
    const displayHz = parseDisplayHz(dump);

    // The next window starts where this one ends, whatever time the response
    // happened to arrive.
    this.lastTimeStatsAt = requestedAt;

    /*
     * Follow whichever of the game's surfaces is drawing now.
     *
     * A Unity game does not keep one surface for a whole session: showing an
     * interstitial, or leaving the splash, destroys the SurfaceView and creates
     * another with a new id. The old layer stays in the TimeStats dump with its
     * final counts frozen.
     *
     * This used to pin the first layer it saw and keep asking that one. When
     * `prepare()` ran before the game had drawn - which is the normal case, the
     * process has just started - the pin landed on an early surface, and after
     * the swap every window was a zero difference against a dead layer. The
     * frame rate then read null for the entire session while the game was
     * visibly running at 60 fps, and the only clue was a diagnostic saying it
     * was still waiting for the game to draw.
     *
     * So all of the game's layers are diffed against their own baselines, and
     * the one that actually moved is the one reported. A frozen layer
     * contributes a zero delta and is ignored; a brand-new one contributes
     * nothing on the read that discovers it and everything after that.
     */
    const ours = layers.filter((l) => layerBelongsTo(l.layer, this.packageName));
    if (ours.length === 0) return null;

    let mine: LayerFrameStats | null = null;
    let cumulative: LayerFrameStats | null = null;
    for (const layer of ours) {
      const delta = this.sinceLastRead(layer);
      if (delta !== null && delta.totalFrames > (mine?.totalFrames ?? 0)) {
        mine = delta;
        cumulative = layer;
      }
    }

    if (mine === null || cumulative === null || mine.totalFrames === 0) return null;

    // Remembered only for reporting which surface the figures came from; the
    // choice above is made afresh every read.
    this.timeStatsLayer = cumulative.layer;

    // The app's own rate: frames it submitted, over a window we timed.
    //
    // Deliberately *not* SurfaceFlinger's `averageFPS`. That is one over the
    // mean gap between frames, quantised into whole-millisecond buckets, so a
    // game producing a frame every 16.8 ms reports as 62.5 - it lands every
    // interval in the "16ms" bucket. Measured on an Android 16 handset: 243
    // frames in 4.08 s is 59.6 fps, and `averageFPS` claimed 62.5.
    const fps = mine.totalFrames / (windowMs / 1000);

    // Whether the game is tracking the panel. A cap that is set but not applying
    // looks exactly like this, and it is worth saying so.
    const matchesDisplayRate =
      displayHz !== null && displayHz > 0 ? Math.abs(fps - displayHz) / displayHz < 0.06 : null;

    return {
      fps: Math.round(fps * 10) / 10,
      displayHz,
      matchesDisplayRate,
      frameCount: mine.totalFrames,
      windowMs,
      ...(mine.buckets.length > 0
        ? { frames: summarizeFrames(mine.buckets, displayHz) }
        : {}),
      jankPercent:
        mine.totalFrames > 0
          ? Math.round((mine.droppedFrames / mine.totalFrames) * 1000) / 10
          : null,
      // TimeStats reports histograms rather than a single worst frame.
      worstFrameMs: null,
      source: 'timestats',
    };
  }

  private async readSurfaceFlinger(): Promise<FpsReading | null> {
    if (!this.layer) return null;

    const res = await this.device.shell(
      ['dumpsys', 'SurfaceFlinger', '--latency', this.layer],
      15_000,
    );
    if (res.code !== 0) return null;
    return parseSurfaceFlingerLatency(res.stdout);
  }

  private async readGfxInfo(): Promise<FpsReading | null> {
    const res = await this.device.shell(['dumpsys', 'gfxinfo', this.packageName], 20_000);
    if (res.code !== 0) return null;

    const counters = parseGfxInfo(res.stdout);
    if (!counters) return null;

    const now = Date.now();
    const previous = this.lastGfx;
    this.lastGfx = { counters, at: now };

    if (!previous) return null; // first reading establishes the baseline only

    const frames = counters.totalFrames - previous.counters.totalFrames;
    const windowMs = now - previous.at;
    if (frames <= 0 || windowMs <= 0) return null;

    const janky = counters.jankyFrames - previous.counters.jankyFrames;

    return {
      // gfxinfo only gives a count, so this is already a wall-clock rate.
      fps: Math.round((frames / (windowMs / 1000)) * 10) / 10,
      displayHz: null,
      matchesDisplayRate: null,
      frameCount: frames,
      windowMs,
      jankPercent: frames > 0 ? Math.round((janky / frames) * 1000) / 10 : null,
      // gfxinfo's aggregate counters carry no per-frame timing.
      worstFrameMs: null,
      source: 'gfxinfo',
    };
  }

  /** Leave TimeStats as we found it, so the tool costs the device nothing after. */
  async release(): Promise<void> {
    if (this.source === 'timestats') await this.timeStats(['-disable']);
  }
}

// ---------------------------------------------------------------------------
// SurfaceFlinger TimeStats
// ---------------------------------------------------------------------------

/**
 * Per-layer frame statistics from `dumpsys SurfaceFlinger --timestats`.
 *
 * This is the strategy that works on a modern handset. `--latency`, which this
 * module tried first for years, is legacy: it was already deprecated by
 * Android 10 and on many Android 13+ builds it returns an empty buffer even
 * though the option still exists. TimeStats replaced it, is per-layer, and
 * reports an average frame rate directly.
 *
 * It has to be switched on before it collects anything, which is why this needs
 * `prepare()` rather than being a pure read. It is cleared after every sample so
 * each reading covers one window rather than the whole session to date.
 */
export interface LayerFrameStats {
  layer: string;
  totalFrames: number;
  droppedFrames: number;
  /** As SurfaceFlinger computed it, where the build reports one. */
  averageFps: number | null;
  /** Frame-interval buckets, which is where per-frame timing survives. */
  buckets: Array<{ ms: number; count: number }>;
}

/**
 * Parse the `-dump` output.
 *
 * Layout is a global block followed by one section per layer:
 *
 *   layerName = 9a9a9d2 SurfaceView[com.pkg/com.unity3d.player.UnityPlayerActivity]@0(BLAST)#243618
 *   totalFrames = 314
 *   droppedFrames = 0
 *   ... jank payload, frame-rate vote ...
 *   averageFPS = 62.289
 *
 * The label differs by release: Android 13 and earlier print `Layer name:`,
 * Android 14+ prints `layerName =` and prefixes a hex id. Both are accepted,
 * because a tool that only understood one would silently report no frame rate
 * on half the devices in a QA rack - which is exactly what happened.
 *
 * `averageFPS` sits well below the frame counts, after the jank payload, so a
 * parser that stopped at the first blank line would miss it.
 *
 * Only per-layer sections are returned. The global `totalFrames` counts every
 * layer on the display, including the status bar and the launcher, so reporting
 * it as the game's frame rate would be wrong.
 */
export function parseTimeStats(text: string): LayerFrameStats[] {
  const sections = text.split(/^[ 	]*(?:Layer name:|layerName\s*=)[ 	]*/m).slice(1);
  const out: LayerFrameStats[] = [];

  for (const section of sections) {
    const lines = section.split('\n');
    const layer = (lines[0] ?? '').trim();
    if (!layer) continue;

    const value = (key: string): number | null => {
      const m = new RegExp(`^\\s*${key}\\s*=\\s*([\\d.]+)`, 'm').exec(section);
      return m ? Number(m[1]) : null;
    };

    const totalFrames = value('totalFrames');
    if (totalFrames === null) continue;

    out.push({
      layer,
      totalFrames,
      droppedFrames: value('droppedFrames') ?? 0,
      averageFps: value('averageFPS'),
      buckets: parseFrameHistogram(section),
    });
  }

  return mergeByLayer(out);
}

/**
 * Collapse repeated sections for the same layer into one.
 *
 * A single dump really does print the same layer more than once. Measured on an
 * Android 16 handset, one Unity surface appeared three times in one dump with
 * totals of 287, 53 and 8 - SurfaceFlinger keeps its per-layer statistics split
 * by things the layer name does not mention, and prints a block per bucket.
 *
 * Left unmerged this is not a cosmetic problem. A caller diffing cumulative
 * counters keyed by layer name processes the three blocks in sequence, so each
 * one overwrites the baseline the previous had just stored, and the difference
 * it computes is between two blocks of the *same* dump. That produced frame
 * rates of 215 fps on a 30 Hz panel, climbing every sample.
 *
 * Merging is a sum because the blocks are disjoint counts of the same surface's
 * frames. Histogram buckets add for the same reason, and `averageFps` is
 * dropped: an average of three averages weighted by nothing is not a figure
 * worth carrying, and it is only ever a fallback.
 */
function mergeByLayer(layers: LayerFrameStats[]): LayerFrameStats[] {
  const merged = new Map<string, LayerFrameStats>();

  for (const layer of layers) {
    const seen = merged.get(layer.layer);
    if (!seen) {
      merged.set(layer.layer, { ...layer, buckets: [...layer.buckets] });
      continue;
    }

    seen.totalFrames += layer.totalFrames;
    seen.droppedFrames += layer.droppedFrames;
    seen.averageFps = null;

    for (const bucket of layer.buckets) {
      const existing = seen.buckets.find((b) => b.ms === bucket.ms);
      if (existing) existing.count += bucket.count;
      else seen.buckets.push({ ...bucket });
    }
    seen.buckets.sort((a, b) => a.ms - b.ms);
  }

  return [...merged.values()];
}

/**
 * The panel's refresh rate, from the dump's own report of it.
 *
 * A device property rather than a layer one, so the first occurrence is taken
 * and applies to every layer.
 */
export function parseDisplayHz(text: string): number | null {
  const m = /displayRefreshRate\s*=\s*([\d.]+)/.exec(text);
  return m ? Math.round(Number(m[1])) : null;
}

/** Does this layer name belong to the app under test? */
export function layerBelongsTo(layer: string, packageName: string): boolean {
  return layer.includes(packageName);
}

// ---------------------------------------------------------------------------
// Frame times and janks
// ---------------------------------------------------------------------------

/**
 * Per-frame statistics, derived from the frame-interval histogram.
 *
 * The histogram is the one place per-frame timing survives on a modern handset.
 * TimeStats reports it per layer as `present2present`, bucketed by millisecond,
 * and it is what makes a median, a worst-1% and a jank count possible at all -
 * an average frame rate over a five-second window cannot see a single 118 ms
 * stall, and a single 118 ms stall is exactly what a player notices.
 *
 * Definitions follow GameBench's, because a studio comparing the two tools
 * should get the same answer:
 *
 *   small jank   frame took longer than one display refresh (16.7 ms at 60 Hz)
 *   jank         frame took over 83 ms  (two frames at 24 fps)
 *   big jank     frame took over 125 ms (three frames at 24 fps)
 *
 * GameBench also counts a jank when a frame takes more than twice the average
 * of the *previous three* frames. That rule needs frames in order, and a
 * histogram has thrown the order away - see `relativeJankNote`.
 */
export interface FrameStats {
  frameCount: number;
  /** Median frame rate: robust to the stalls that drag an average down. */
  medianFps: number | null;
  /** One over the longest frame time - the worst moment in the window. */
  minFps: number | null;
  /** One over the shortest frame time. */
  maxFps: number | null;
  /** Average frame rate of the worst 1% of frames. */
  low1PercentFps: number | null;
  longestFrameMs: number | null;
  /** Frames over one display refresh period. */
  smallJanks: number;
  /** Frames over 83 ms - the absolute threshold, applied exactly. */
  janks: number;
  /** Frames over 125 ms. */
  bigJanks: number;
  /**
   * What a GameBench-style counter would report, estimated.
   *
   * Their relative rule counts a frame that takes over twice the average of
   * the previous three - which, on a vsync-locked game, fires on every dropped
   * refresh: a 33 ms frame after three 16 ms frames is over 2x32/2. That is why
   * their jank number can be ~25x the absolute count on the same session.
   * Ordered frame times are unavailable here, so twice the *median* interval
   * stands in for twice the recent average: over a window the two agree except
   * right at a level change. Kept separate from `janks` - one figure for
   * cross-tool comparison, one that means "a stall a player felt" - because
   * merging them would make both worse.
   */
  crossToolJanks: number;
  /** The buckets themselves, so a chart or a later rule can use them. */
  buckets: Array<{ ms: number; count: number }>;
}

/** Two frames at 24 fps, which is GameBench's jank threshold. */
const JANK_MS = 83;
/** Three frames at 24 fps. */
const BIG_JANK_MS = 125;

/**
 * Pull the frame-interval histogram out of one layer's TimeStats section.
 *
 * `present2present` is the gap between frames actually reaching the screen,
 * which is what a player experiences. The other histograms in the section
 * (`latch2present`, `acquire2present` and so on) measure latency through the
 * pipeline rather than the interval between frames, and would answer a
 * different question.
 */
export function parseFrameHistogram(section: string): Array<{ ms: number; count: number }> {
  const match = /present2present histogram is as below:\s*\n(.+)/.exec(section);
  if (!match?.[1]) return [];

  return [...match[1].matchAll(/(\d+)ms=(\d+)/g)]
    .map((m) => ({ ms: Number(m[1]), count: Number(m[2]) }))
    .filter((b) => Number.isFinite(b.ms) && Number.isFinite(b.count) && b.count > 0);
}

/**
 * Reduce a frame-interval histogram to the figures a report can use.
 *
 * Bucket labels are lower bounds - a frame of 16.8 ms lands in the `16ms`
 * bucket - so every frame time here is a slight underestimate and every derived
 * frame rate a slight overestimate. That is stated rather than corrected,
 * because inventing a distribution inside each bucket would be a guess dressed
 * as precision.
 */
export function summarizeFrames(
  buckets: Array<{ ms: number; count: number }>,
  displayHz: number | null,
): FrameStats {
  const sorted = [...buckets].filter((b) => b.count > 0).sort((a, b) => a.ms - b.ms);
  const frameCount = sorted.reduce((sum, b) => sum + b.count, 0);

  const empty: FrameStats = {
    frameCount: 0,
    medianFps: null,
    minFps: null,
    maxFps: null,
    low1PercentFps: null,
    longestFrameMs: null,
    smallJanks: 0,
    janks: 0,
    bigJanks: 0,
    crossToolJanks: 0,
    buckets: [],
  };
  if (frameCount === 0) return empty;

  const fpsOf = (ms: number) => (ms > 0 ? Math.round((1000 / ms) * 10) / 10 : null);

  // Median by walking the cumulative count, which needs no expansion of the
  // histogram into a list - a long session can hold tens of thousands of frames.
  const half = frameCount / 2;
  let seen = 0;
  let medianMs = sorted[0]!.ms;
  for (const bucket of sorted) {
    seen += bucket.count;
    if (seen >= half) {
      medianMs = bucket.ms;
      break;
    }
  }

  const shortestMs = sorted[0]!.ms;
  const longestMs = sorted[sorted.length - 1]!.ms;

  // The worst 1% of frames, by frame time. At least one frame, so a short
  // window still reports its worst moment rather than nothing.
  const worstCount = Math.max(1, Math.round(frameCount * 0.01));
  let remaining = worstCount;
  let worstMsTotal = 0;
  for (let i = sorted.length - 1; i >= 0 && remaining > 0; i--) {
    const take = Math.min(remaining, sorted[i]!.count);
    worstMsTotal += sorted[i]!.ms * take;
    remaining -= take;
  }
  const low1PercentFps = fpsOf(worstMsTotal / (worstCount - remaining || 1));

  // A refresh period, from the panel's own rate where it is known.
  const refreshMs = displayHz && displayHz > 0 ? 1000 / displayHz : 16.7;

  // No relative rule. It was tried against the window's median in place of the
  // previous three frames, and real data showed why that does not work: in a
  // 176-second session of 9657 frames, 98% of which were 16 ms, the median-based
  // rule counted 173 janks where the absolute rule counts 7. A vsync-limited
  // game that occasionally presents 33 ms instead of 16 ms is dropping a frame,
  // but calling every one of those a jank inflates the count roughly 25-fold and
  // makes the figure incomparable with any other tool. The published relative
  // criterion needs frames in order; ordered frame times are unavailable on
  // recent Android, so it is simply not applied - see `relativeJankNote`.
  let smallJanks = 0;
  let janks = 0;
  let bigJanks = 0;
  /*
   * A missed refresh has to clear the refresh period by a real margin.
   *
   * SurfaceFlinger bins frame intervals into whole milliseconds, and a 60 Hz
   * vsync is 16.67 ms, so a frame that hit its vsync perfectly lands in either
   * the 16 ms or the 17 ms bucket depending on jitter. Comparing against 16.67
   * counts every 17 ms frame as a miss. Measured on a real session: of 6488
   * frames, 2203 landed at 16 ms and 1521 at 17 ms - both on vsync - and this
   * figure reported 4284 misses, 55% above the true 2763. A game holding a
   * steady 60 fps could be told it missed a third of its refreshes.
   *
   * Half a period of headroom separates the two cases cleanly, because the
   * intervals are quantised to multiples of the vsync: on that same session the
   * next populated bucket after 17 ms was 33 ms, which is genuinely one dropped
   * refresh, and there were exactly two frames anywhere between.
   */
  const missedRefreshMs = refreshMs * 1.5;
  /*
   * The cross-tool threshold: twice the median frame interval, floored by the
   * missed-refresh guard so millisecond binning cannot count on-vsync frames.
   * Twice-the-median tracks the game's own cap - a 30 fps title (33 ms frames)
   * is judged against 66 ms, exactly as a relative rule would judge it - which
   * is what keeps this a fair stand-in for the ordered-frames rule.
   */
  const crossToolMs = Math.max(missedRefreshMs, medianMs * 2);
  let crossToolJanks = 0;
  for (const bucket of sorted) {
    if (bucket.ms > missedRefreshMs) smallJanks += bucket.count;
    if (bucket.ms > JANK_MS) janks += bucket.count;
    if (bucket.ms > crossToolMs) crossToolJanks += bucket.count;
    // Absolute only. The published definition lists the same relative condition
    // for a big jank as for an ordinary one, which would make the two counts
    // identical and the distinction useless - so a big jank is taken to be the
    // 125 ms threshold, which is what separates a stutter from a visible freeze.
    if (bucket.ms > BIG_JANK_MS) bigJanks += bucket.count;
  }

  return {
    frameCount,
    medianFps: fpsOf(medianMs),
    minFps: fpsOf(longestMs),
    maxFps: fpsOf(shortestMs),
    low1PercentFps,
    longestFrameMs: longestMs,
    smallJanks,
    janks,
    bigJanks,
    crossToolJanks,
    buckets: sorted,
  };
}

/**
 * Why our jank count can differ slightly from a tool with ordered frame times.
 *
 * Stated in the report rather than hidden, because a studio checking one tool
 * against another deserves to know where the two can disagree.
 */
export const relativeJankNote =
  'A frame counts as a jank when it takes over 83 ms, and as a severe jank over 125 ms. These ' +
  'are the standard absolute thresholds and are applied exactly. Tools like GameBench also ' +
  'count a frame as janky when it takes more than twice the average of the previous three ' +
  'frames - a rule that fires on every dropped refresh, so their headline jank number runs far ' +
  'higher than the absolute count on the same session. That criterion needs frames in order, ' +
  'which recent Android no longer reports; the "janks (cross-tool estimate)" row approximates ' +
  'it as frames over twice the typical frame interval, and is the number to hold against a ' +
  'GameBench-style counter. The plain jank count stays conservative on purpose: it means a ' +
  'stall a player felt, not a single dropped refresh.';
