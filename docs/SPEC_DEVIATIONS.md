# Deviations from the specification

Every point where the implementation departs from [SPEC.md](./SPEC.md), why, and
what was built instead. Nothing here changes the product's scope — these are
places where the specified approach would not have worked on real devices, or
where a specified detail needed a concrete engineering decision.

---

## 1. Telemetry cadence is two-tier, not a single continuous stream

**Spec §11** asks for continuous lightweight telemetry including PSS, SwapPSS and
major memory categories.

**Problem.** The only reliable non-root source for PSS by category is
`dumpsys meminfo <pid>`. It costs roughly 150–400 ms per call and briefly
suspends the target process to walk its memory maps. Polling it at 1 Hz — the
natural reading of "continuous" — measurably perturbs the game we are trying to
measure and can itself cause frame hitches, which contaminates the very
measurement the tool exists to produce.

**What was built.** Two independent sampling tiers on separate timers
([`src/telemetry/sampler.ts`](../src/telemetry/sampler.ts)):

| Tier | Source | Default rate | Gives |
|---|---|---|---|
| fast | `/proc/<pid>/status`, `oom_score_adj` | 1 Hz | RSS, swap, kill-candidate score |
| deep | `dumpsys meminfo <pid>` | 0.2 Hz | Full PSS breakdown, SwapPSS, App Summary |

The two are never mixed into one series: PSS and RSS answer different questions,
and a series that silently alternates between them produces sawtooth artefacts
indistinguishable from the spikes we are hunting. The analysis layer keeps them
as separate aligned series and picks PSS as primary whenever it has the
resolution to describe the curve.

**Consequence.** Probes are capability-checked once at session start and recorded
in the session manifest, so a report always states which probe produced its
numbers. Modern Android mounts `/proc` with `hidepid`, which blocks the fast tier
for non-debuggable release builds; the sampler detects this, degrades to
deep-only, and tightens the deep cadence to compensate.

---

## 2. Unity Memory Profiler snapshots are not in the MVP

**Spec §11** lists "Unity Memory Profiler snapshot where supported" as a deep
capture artifact.

**Problem.** This is not achievable against a shipped release APK. Capturing a
snapshot requires the `com.unity.memoryprofiler` package compiled into the build
plus a runtime hook to trigger it. Neither exists in a build a studio hands over,
and adding them changes the binary under test.

**What was built.** A `DeepCaptureProvider` seam with the providers that *are*
achievable against an arbitrary APK: full `dumpsys meminfo` dump, logcat slice,
screenshot, and `am dumpheap` where the build is debuggable (Java heap only —
note that IL2CPP content is native and will not appear there).

**Recommendation.** Unity snapshots belong at roadmap Stage 3, "studio-provided
test hooks" (spec §7), where the studio ships an instrumented build. That is the
only honest place for them.

---

## 3. Scene analysis produces a test-surface map, not an automation target

**Spec §3** already concludes that scene analysis "cannot universally tell us how
to play". The implementation takes that conclusion literally.

Scene indexing resolves each scene's referenced asset GUIDs against the asset
index and reports a per-scene memory estimate. That answers "which screens are
worth testing and what will they cost to load", which is what drives the
`UNITY.SCENE.HEAVY` rule and the correlation of load spikes to specific scenes.
It is deliberately not used to derive a navigation graph.

---

## 4. `aapt2` is optional; the manifest is parsed directly

**Spec §14 Step 3** requires extracting package name, version, ABI, launcher
activity and manifest metadata, which conventionally means `aapt2 dump badging`.

**What was built.** A dependency-free binary `AndroidManifest.xml` (AXML) parser
and ZIP reader ([`src/apk/axml.ts`](../src/apk/axml.ts),
[`src/apk/zip.ts`](../src/apk/zip.ts)), so APK inspection works on any machine
with only Node installed — which matters because this runs on studio benches and
CI boxes. `aapt2` is used as a cross-check when present, and disagreements are
recorded as report warnings.

This also gets us Unity-specific signal `aapt2` cannot provide: engine version
from the serialized data folder, IL2CPP vs Mono from the shipped native
libraries, asset payload size, and the top-level content breakdown.

**One robustness note learned in testing:** `aapt2` reports an empty string for
any attribute whose resource id it cannot resolve. Empty values from `aapt2` are
therefore treated as absent rather than allowed to overwrite a value our own
parser read correctly.

---

## 5. Transition markers are measured with directional windows

**Spec §9** defines Recovery Delta as `Recovered - Initial Baseline`.

**Problem discovered during testing.** Taking a median over a window *centred* on
the marker straddles the transition the marker announces. Opening a screen and
then measuring "memory when the screen opened" with a centred window averages the
before and after states together — which systematically understates retention,
and in one test produced a *negative* retention figure for a screen that had
plainly leaked 180 MB.

**What was built.** Directional windows in
[`src/analysis/timeline.ts`](../src/analysis/timeline.ts):

- `stableValueBefore` — median of the window *ending* at the marker. The
  reference level, before whatever the marker announces began.
- `stableValueAfter` — median of a window starting after a settle delay, so the
  destruction and GC that follow closing a screen are excluded.

Cycle start/recovery and screen open/close both use these.

---

## 6. Scoring: explicit saturation and a confirmed-critical floor

**Spec §13** says "do not simply average rule counts" but does not prescribe a
formula.

**What was built** ([`src/analysis/scoring.ts`](../src/analysis/scoring.ts)):

- **Impact accumulation, then saturation.** Each finding contributes
  `severity_weight × confidence`; the total maps through `1 - e^(-total/K)`.
  Summing means many small problems can add up to real risk; saturating means
  they can never eclipse a genuine critical finding.
- **Different K for static and live** (25 vs 12). A single *confirmed* critical
  finding reaches the "high" band on its own; it takes several unconfirmed static
  criticals to get there.
- **A confirmed-critical floor.** If any live or correlated finding is critical
  with confidence ≥ 0.9, live risk is floored at 75. Without this, the arithmetic
  could report "moderate" for a session in which the OS killed the game — which
  is technically consistent with the curve and useless to a studio.
- **Static can only raise the combined score, never lower it.** A clean static
  scan is not evidence against something we watched happen.
- **Confidence is scored separately** from risk, so "this game is fine" is
  distinguishable from "we could not measure it". A static-only run says so in
  the headline.

---

## 7. Devices are ranked automatically into A/B roles

**Spec §10** defines Device A as lower/mid memory and Device B as higher memory
but does not say who decides.

**What was built.** Roles are derived from measured `MemTotal`, not asked of the
operator. Getting them backwards silently inverts the interpretation of every
cross-device result, and it is the kind of mistake that is invisible in the
output. More than two devices are supported; extras are profiled and reported but
do not take the A/B roles. A single-device run is labelled A and the report states
that cross-device comparison was unavailable.

---

## 8. Static memory figures are estimates, and say so

Runtime texture memory depends on the format Unity picks at build time, which is
genuinely unknowable from the project alone when the importer is set to
Automatic.

Every estimate therefore carries the assumption it was derived under
(`"4096x4096 downscaled to 2048x2048 by maxTextureSize 2048, ASTC 6x6 (3.56 bpp)
with mipmaps"`) and a confidence that drops when the format had to be assumed.
Rules that fire on estimates inherit that confidence, which then flows into the
score. An estimate honest about its uncertainty is more useful to a studio than a
precise-looking number that is quietly wrong.

---

## 9. Code rules are lexical, with deliberate false-positive control

**Spec §14 Step 8** lists twelve C#-visible patterns.

A full C# parse (Roslyn or equivalent) would be a heavyweight dependency for
marginal precision — all twelve patterns are recognisable lexically. What *is*
handled carefully is false positives: comments and string literals are blanked
before matching (preserving line numbers), so a commented-out
`Resources.LoadAll` or a log message mentioning it never becomes a finding.

Rules that are inherently uncertain — "unbounded collections" being the clearest
case, since a cache may legitimately be bounded in another file — carry a
correspondingly low confidence and wording that asks the reader to verify, rather
than being dropped or overstated.

---

## 10. The console is a local web app in a browser, not a native window

**Spec §5 / §14 Step 7** asks for an operator UI with event-marker buttons; it
does not say what kind of application that should be.

**What was built.** A local HTTP server plus a zero-build HTML/JS console, opened
in the operator's default browser and packaged as a single executable. The
alternative — Electron — would add roughly 150 MB, a second runtime, and a
packaging toolchain, to render the same three files.

**The one thing this costs, and how it is handled.** A browser deliberately hides
the real filesystem path behind `<input type="file">`, and a Unity project is far
too large to upload. Since the server runs on the operator's own machine, it
opens the *operating system's* own dialogs instead
([`src/server/nativeDialog.ts`](../src/server/nativeDialog.ts)) — WinForms via
PowerShell on Windows, AppleScript on macOS, zenity/kdialog on Linux — and
returns a genuine path. Paths can also be typed or pasted, so a machine without a
dialog mechanism degrades rather than fails.

**Packaging.** `npm run build:exe` bundles the ESM sources to CommonJS with
esbuild and injects them into a Node binary using Node's Single Executable
Application support. The console's three files travel inside the binary as SEA
assets rather than beside it, so the result is genuinely one file. Two details
worth knowing:

- `import.meta.url` is empty in a CJS bundle, so `node:sea` is resolved through
  `process.getBuiltinModule` with `createRequire` only as an ESM-runtime
  fallback. Getting this wrong silently disables asset loading in the exe.
- Injecting a blob invalidates the Node binary's Authenticode signature. The
  build removes it with `signtool` when the Windows SDK is present, and proceeds
  without it otherwise. **For distribution outside your own team the executable
  should be code-signed**, or Windows SmartScreen will warn every studio that
  runs it.

---

## 11. Desktop application

**Not in the spec** — the spec asks for an operator UI without saying what kind
of application it should be. Delivered as a proper desktop app because that is
what an operator on a test bench actually wants: an icon to double-click, a real
window, and native file dialogs.

**How it is put together.** Electron wraps the *same* analysis server and the
*same* console the CLI and browser modes use. The server runs inside Electron's
main process and the window points at it over localhost on an OS-assigned free
port, so two copies cannot collide. There is exactly one implementation of the
pipeline; the desktop app is a shell around it, not a fork of it.

- **Native dialogs.** Inside the app, the console uses Electron's own
  `dialog.showOpenDialog` through a narrow preload bridge
  ([`desktop/preload.cjs`](../desktop/preload.cjs)) — properly parented to the
  window, no PowerShell. In a plain browser the same button falls back to the
  server's OS-shelling endpoint. `window.oomDesktop` is the feature test.
- **Security posture.** `contextIsolation: true`, `nodeIntegration: false`, and
  the renderer gets three named operations (pick, reveal, openExternal) rather
  than a general IPC channel.
- **Workspaces** default to `Documents/GD-PerformanceShield` rather than a folder beside
  the binary, which may sit somewhere unwritable like Program Files.

### One environment trap worth knowing about

`ELECTRON_RUN_AS_NODE=1` is set inside VS Code's extension host and inherited by
anything spawned from it. When set, an Electron binary silently runs as plain
Node: `require('electron')` returns the npm shim instead of the API, `app` is
`undefined`, and the process exits with **no window and no meaningful error**.

This cost real debugging time here, so `npm run desktop` goes through
[`scripts/run-desktop.mjs`](../scripts/run-desktop.mjs), which strips the
variable before spawning Electron. Packaged builds are unaffected — they are
launched from Explorer or Finder, not from a tooling process.

### macOS

The build is configured for macOS (dmg + zip, x64 and arm64) but **must be built
on a Mac**. electron-builder cannot produce a `.dmg` from Windows: it needs
macOS-only tooling for the disk image, code signing and notarization. Options
are a Mac, or a CI job with a `macos-latest` runner.

Both platforms need signing before distribution outside your own team —
Authenticode on Windows, Developer ID plus notarization on macOS — or users get
SmartScreen and Gatekeeper warnings.

---

## 12. PDF export, and the reader who is not you

**Spec §14 Step 14** lists "HTML later, PDF later" as report formats.

**What was built.** An **Export PDF** action in the report panel that takes a
multi-select of the three audience cuts and writes each as its own PDF.

The important constraint came out of using it: these files are the deliverable
that *leaves* the building. They go to a producer or an engineer at a studio who
has never opened this tool. So the print renderer
([`src/report/html.ts`](../src/report/html.ts)) is not a Markdown conversion - it
is a separate renderer, because a document that has to stand on its own needs
things Markdown cannot express:

- **Page geometry.** A4, controlled margins, and `break-inside: avoid` on every
  finding and table row. A finding split across a page boundary is the difference
  between a report someone reads and one they put down.
- **No internal references.** No `report.json`, no "see the complete report", no
  localhost links. Every one of those is a dead end for the recipient, and there
  is a test asserting none of them appear.
- **A primer.** Each PDF explains what predicted / measured / confirmed mean and
  why a confidence score sits beside the risk score, because the reader has no
  other context.
- **Always light.** A dark report wastes ink and reads badly on paper, so the
  print renderer ignores the console theme.

**Mechanism.** Chromium's `printToPDF` in the Electron main process - no PDF
library, and the same engine that laid the page out does the pagination. One
offscreen window is reused for the whole batch: creating a window per cut
intermittently failed the second load with `ERR_FAILED`, which only showed up
when the export was tested with more than one cut selected.

Outside the desktop app there is no way to write a file directly, so browser mode
opens each cut with `?print=1` and the reader picks "Save as PDF".

---

## 13. Process termination is reported only when the OS says it killed the game

**Spec §10** lists process termination as one of the runtime signatures to
detect, and the natural implementation is the one that was there first: the
process watcher notices the game's PID is gone, and the tool reports a critical
termination.

**Problem.** A missing PID is not evidence of a kill. The operator closing the
game at the end of a flow, a force-stop, a `restarted` event after a normal
relaunch and adb dropping the connection all look identical from outside the
process. Reporting each of those as "the game did not survive" puts the report's
single strongest claim - the one that sets the headline and the priority-one
finding - on the weakest evidence in the session.

The kill notice that *does* prove it had its own gap. Kill notices come from
`system_server`, not from the game, so the logcat filter deliberately keeps
system-wide signals (`oom_kill`, `low_memory`, `anr`) regardless of which process
they name. Analysis then matched them by device serial only, so the low-memory
killer reaping any other app during the session counted as a kill of the game.

**What was built.** Termination now requires positive evidence of an automatic
kill of *our* process ([`src/analysis/anomaly.ts`](../src/analysis/anomaly.ts)):

- The line must be an OS-initiated kill - `lowmemorykiller`/`lmkd` or
  `ActivityManager: Killing` - which the matcher table marks with `systemKill`.
  An in-app `OutOfMemoryError` shares the `oom_kill` category but is a crash of
  our own making, and is reported as one (`LIVE.CRASH`), not as a kill.
- The line must be attributable to the game: either the capture flagged it
  (`LogEvent.appRelated`, set from the app's PIDs and package name) or the stored
  message names the package. Attribution requires one of those - a line we cannot
  attribute is treated as being about another app.

A process that only disappeared now produces **no finding at all**, and
`processDeaths` counts log-confirmed abnormal terminations rather than
disappearances, so neither the device table nor the headline claims a kill the
log does not support. `osKills` is tracked separately, so the headline can say
"terminated by the OS" only where that is what happened.

**Consequence.** The tool is quieter and occasionally under-reports: a kill line
carrying only a bare PID, from a session captured before `appRelated` existed,
cannot be attributed and is skipped. That trade is deliberate - a critical
finding that might be the operator closing the app is worse than a missing one,
because it sends a studio hunting a reproduction that never existed.

---

## 14. Per-mapping detail is best-effort, and says so when it is missing

**Spec.** Deep telemetry reports PSS by category.

**What we do.** The category breakdown from `dumpsys meminfo` is always
collected, and each App Summary category can be opened up into the rows it is a
sum of — `Graphics` into GPU driver memory, EGL surfaces and GL driver objects,
and so on. Those rows are built from the **private** columns rather than PSS,
because Android computes the summary categories from private memory; a
breakdown built from the PSS column would not add up to the number above it.

Below that, a second probe reads `/proc/<pid>/smaps` and groups it by mapping
name, which is what turns "Graphics grew 137 MB" into "`/dev/kgsl-3d` grew 137
MB" and names `libunity.so`, `libil2cpp.so` and `base.apk` individually.

**Why it is a deviation.** That file is readable only for a debuggable build
(via `run-as`) or on a rooted device. On a stock handset running a release APK,
SELinux denies it. The probe therefore checks once, at session start, and drops
out silently if refused — the session continues with the reported rows alone.

**Consequence.** Two grades of answer, and the console states which one it is
showing rather than presenting the coarser one as though it were the whole
story. Where smaps is unavailable the drill-down says so, and names the reason,
instead of showing a shorter list that looks complete.

The deeper answer — *which texture*, *which line of C#* — remains out of reach
of any OS-level probe, because Android reports memory by mapping and not by
engine object. That attribution stays the static analysis's job, via correlation.

---

## 15. Unity's per-asset-type memory comes from the engine, not from the wire

**The problem.** Android accounts memory by mapping. Unity's native allocator is
one anonymous mapping, so the OS reports "Unattributed +134 MB" and cannot say
how much of that is textures. No OS-level probe can: the information does not
exist outside the process.

**The obvious approach, and why it was rejected.** A Unity development build
opens a PlayerConnection socket, and the Editor's Profiler reads memory counters
over it. Parsing that stream ourselves would need a reimplementation of Unity's
`RawFrameData` binary format — undocumented, internal, and versioned with the
engine. A parser written against one engine version returns wrong numbers on
another and nothing at all on a third, with no way for the tool to tell which
case it is in. A wrong texture figure in a report sent to a studio is worse than
an absent one, so we do not do it.

**What we do instead.**

1. **Discover and forward the socket** (`device.profiler` stage). This uses the
   same mechanism the Editor does — `adb forward tcp:N localabstract:Unity-<pkg>`
   — and is documented and stable. It gives two real things: proof of whether
   the build is a development build at all, and a live port the operator can
   point Unity's own Profiler at alongside our capture.

2. **Read the counters from inside the engine.** `scripts/unity/PerformanceShieldReporter.cs`
   is a ~120-line component the studio drops into the project. It reads Unity's
   documented `ProfilerRecorder` counters and emits them to logcat, which we
   already tail. Counters the running engine version does not expose are
   reported **by name as unavailable** rather than as zero — a zero would read as
   "this build has no audio".

**Consequence.** The four buckets are engine-authoritative and version-safe, at
the cost of a one-time change to the project. Without that component the run
still works; the console explains what is missing and how to get it, rather than
showing a breakdown that looks complete.

**The two accountings are shown side by side, never merged.** Unity's texture
figure includes GPU memory that Android reports under Graphics, and the OS's
native-allocator figure includes engine bookkeeping Unity attributes to no asset
type. Neither contains the other, so presenting the engine rows as a
decomposition of the OS row would be a lie that happens to add up.

---

## 16. Frame rate needs two strategies, and battery drain often cannot be measured

**Frame rate.** `dumpsys gfxinfo` counts frames drawn through Android's View
system (HWUI). A Unity game draws through its own GL or Vulkan surface, so on
most Unity builds gfxinfo reports almost no frames — not because the game is
slow, but because gfxinfo cannot see it.

SurfaceFlinger's per-layer latency buffer can see it, because every app
ultimately presents through the compositor. That is the primary source; gfxinfo
remains a fallback for the rare Unity build that renders into a View. Which one
was used is recorded, and the report says so where the fallback was used —
two runs measured different ways are not comparable.

Both measure **presented** frames, which is what a player experiences. Neither
sees the engine's intended frame rate.

**Battery drain.** Running over USB adb normally means the device is charging,
and a charging device has no drain to measure. Rather than report a number
derived from one, the charging state is recorded with every sample and any
session that was plugged in reports no drain figure at all — with the reason,
and the workaround (wireless adb, cable unplugged). The battery **level** is
still reported, because that is a fact; only the drain is withheld.

**Heat.** Reported as the *rise* as well as the absolute, because phones idle
anywhere from 24 °C to 35 °C depending on ambient and on what ran before. "Rose
14 degrees" compares across sessions where "reached 41" does not. Zone naming is
vendor-specific, so the hottest zone's name is passed through as-is rather than
interpreted — `gpuss-0` or `mtktsbattery` tells a developer where the heat is,
and guessing which zone is "the CPU" would not.

Android's own thermal status is reported separately from temperature: when the
framework says it is limiting performance, that is stated plainly, because
memory held longer due to slower frames is a real effect and not a measurement
artefact.

**Spikes in the developer and complete cuts only.** A lead needs the verdict and
the cost. A list of memory mappings is detail to an engineer and noise to them,
and printing it in every cut would make the summary unreadable without making it
more useful.

**The summary is a different document, not a shorter one.** It used to be the
complete report with sections filtered out, which made it a condensed technical
report: the same headings, the same tables, the same prose, less of it. A
producer opening that still had to read it to find the answer. It is now a
one-page snapshot built from `src/report/snapshot.ts`, in a fixed hierarchy -
status and score, the four numbers, pass or fail against this device class, what
limited the frame, one line per subsystem, the biggest issue, the worst frame
collapse, how it played, the device and session, one line of conclusion - and it
stops there.

Three rules keep it honest. It derives no new figures: the score, the
confidence, the budget verdict, the frame-rate and stutter ratings and the
priority ordering all come from the analysis, and the snapshot only chooses
which to show and what word goes beside each. It never fabricates: a metric the
run could not measure shows no number and says "not measured", which is not the
same as saying it is fine. And risk and confidence are set apart deliberately -
confidence is drawn in plain grey whatever the band, because a low confidence
rendered in the risk colour reads as a low risk, which is the opposite of what
it means.

Two of its conventions were taken back into the complete report, because a
reader moving between the two documents should not have to relearn how to read
one. Every heading is ruled - the h2s always were, and the subheadings and
small-caps labels now are, so a section boundary is visible without reading the
words. And every column is ruled the way rows already were: a four-column table
ruled only horizontally makes a reader track across open space to keep a figure
with its heading. The verdict column goes last in every table, which is where
the start-to-end table already put its remark; the subsystem check used to open
with an unlabelled status pill, which both broke that habit and left a column
with no heading over it.

Headings that ask a question are punctuated as questions - "What should we fix
first?", "Why did frames drop?" - and headings that name a section keep their
name. The distinction is deliberate: "Frame rate" and "All findings" are places
in the document, and turning them into questions would make the contents page
read like an interview.

The one thing brevity is not allowed to swallow is a warning. A session where
the OS killed the game, a run that never reached a device, or a peak past what
the phone can be relied on to give one app each surface as a line under the
status, on a page that otherwise carries no prose.

---

## 17. GPU, CPU threading, storage and audio: what Android will and will not tell you

Five modules were added on top of the memory and frame-rate baseline: GPU and
rendering, CPU threading and bottleneck attribution, storage and disk I/O, audio
subsystem performance, and an automated diagnostic engine. Most of the
engineering in them is not the measurement — it is deciding what to do when the
device refuses to answer, which on modern Android is often.

**Android publishes no GPU load API.** There is no equivalent of
`dumpsys meminfo` for the GPU. What exists is vendor sysfs:
`/sys/class/kgsl/kgsl-3d0/gpubusy` and `gpu_busy_percentage` on Adreno,
`/sys/class/misc/mali0/device/utilisation` on Mali, and a devfreq clock node as
a last resort ([`src/telemetry/gpu.ts`](../src/telemetry/gpu.ts)). On most retail
Android 12+ devices SELinux denies an adb shell read of all of them. The probe
resolves a working source once at session start, records every strategy it tried
and what came back, and reports **nothing** rather than a zero when none
answered — a zero would read as "the GPU was idle", which is the opposite of not
knowing. Where only the clock is readable it is still reported: a GPU that never
leaves its top frequency bin is not coasting, even if no percentage is available
to say so.

`gpubusy` is a pair of free-running tick counters, so a utilisation figure is a
difference between two reads. The first sample of a session can only establish
the baseline and deliberately reports null. The same is true of every counter in
these modules: per-core jiffies, per-thread jiffies, and the `/proc/<pid>/io`
byte totals are all cumulative, and a cumulative counter presented as an
instantaneous rate would report a main thread that had been pinned for twenty
minutes as using 4% of a core.

**Draw calls, geometry and per-thread frame time cannot be observed from outside
the process.** No amount of sysfs reading will produce a triangle count, and this
is the single most consequential gap in a run without the reporter component.
Main-thread, render-thread and GPU frame time are the only figures that can
settle CPU-bound against GPU-bound; without them the tool falls back to GPU
utilisation against per-thread CPU load, which is sampled every few seconds while
a frame lasts sixteen milliseconds. Both paths are implemented
([`src/analysis/bottleneck.ts`](../src/analysis/bottleneck.ts)) and every verdict
states which one produced it, because a measurement and an inference deserve
different amounts of trust and a reader cannot tell them apart otherwise. Where
neither is available the verdict is `unknown`, not the common case.

**Overdraw is not measurable, and no number is invented for it.** Unity exposes
no overdraw counter on any version, and Android's overdraw debugging is a screen
tint with no readable output. What the tool reports instead is *fill-rate
pressure*, and only when the GPU was genuinely busy while the geometry it was
handed was trivial — a combination that on a mobile game is nearly always
full-screen transparent layers, stacked particles or an expensive fragment
shader. It is labelled as an inference wherever it appears.

**Thread load is a percentage of one core, never of the device.** A game's main
thread cannot spread across cores, so 100% is saturated and no amount of idle
silicon elsewhere will help it. Whole-device figures are a percentage of all
cores, and the two bases are never mixed: reporting "the CPU was 30% busy" about
a completely main-thread-bound game is the mistake that basis exists to prevent.
Clusters are found from the frequencies cores share as their ceiling, which is
how big.LITTLE is detectable without a vendor table; a SoC with one distinct
ceiling is reported as uniform rather than having all of it called "big".

**`/proc/<pid>/stat`'s comm field is a trap.** It is wrapped in parentheses that
may themselves contain spaces and parentheses — `Job.Worker 0` does — so the line
is split at the last `)` rather than on whitespace. Splitting on whitespace
shifts every subsequent field by one and silently reports a thread's scheduling
policy as its CPU time.

**Storage is measured as two figures, not one.** `rchar` counts every read the
game issued; `read_bytes` counts the ones the page cache could not satisfy. A
scene load that reads 400 MB with `read_bytes` near zero was served from cache
and cost almost nothing; the same 400 MB from flash is where the frame stalls
come from, and a tool reporting only one of them would call those two cases
identical. `/proc/<pid>/io` is readable only by the process's own uid or root, so
this works through `run-as` on a debuggable build or `su` on a rooted device and
reports itself unavailable on a release build on a stock handset. There is no
per-file accounting an unprivileged observer can reach, so a read is correlated
against the frame timeline rather than attributed to a bundle — and the gate is
on reads that cost frames, not on bandwidth, because reading a lot is not a
defect.

**AudioFlinger's dump is not a stable interface.** Its text has changed shape
across releases and vendor forks, and the underrun counters in particular are
printed by whichever mixer implementation the device uses. The parser matches a
small number of durable phrases (`N Tracks of which M are active`, the several
spellings of `underruns=`), sums them across output threads because a phone has
several, and does not pretend a device that printed nothing about underruns had
none. Underruns are reported as a difference against the first reading: the audio
server has been running since boot and its lifetime total says nothing about this
game.

**Correlation is reported as correlation.** The diagnostic engine
([`src/analysis/diagnostics.ts`](../src/analysis/diagnostics.ts)) finds the
moments the frame rate collapsed and asks every other subsystem what it was doing
within five seconds of them — five, because that is the deep-sample interval and
a tighter window would reject genuine matches. Three rules keep it from becoming
a machine that invents causes: a cause is ranked, never asserted, and the wording
stays at "in the same window"; a symptom with no coincident evidence is reported
with no cause rather than assigned the most common one; and every cause names the
figure it rests on. Confidence is capped well below 1 for the same reason.

Within the ranking, a *change* outranks a stage time. "The GPU took 58 ms for
that frame" is the most certain fact available and close to a restatement of "the
frame took 58 ms"; what a developer can act on is what changed to make it so, so
a 400 MB asset load or a tripled draw-call count leads and the stage time sits
below it saying which stage to look at.

**Device tiers are separate from RAM tiers.** Memory budgets are keyed on RAM
alone, because RAM is what decides when the low-memory killer fires. Performance
depends on the SoC as well, and a phone can pair 8 GB with a mid-range chip —
exactly the device a RAM-only tier would grade against the wrong bar. Tiering
([`src/analysis/deviceTier.ts`](../src/analysis/deviceTier.ts)) uses RAM as the
primary axis and lets the fastest core's clock move a device a tier when the two
plainly disagree. The frame-rate floor is additionally capped against the panel's
refresh rate. Every threshold applied travels in the report so a failed check is
arguable, and the memory ceiling is taken from the RAM tier table rather than
invented a second time.

**A CI check that could not be measured is skipped, never passed.** The gate
([`src/report/qualityGate.ts`](../src/report/qualityGate.ts)) writes
`quality-gate.json` alongside the report: `status` is `pass`, `warn` or `fail`
and `exitCode` is non-zero on failure, so a pipeline step can gate on one field.
Skipped checks are counted and named, because a gate that silently passes because
a probe was unavailable teaches a team that green means nothing. A margin of 10%
either side of a threshold is a warning rather than a failure — two runs of the
same build on the same phone differ by a few percent, and a gate that flips red
on that is a gate a team turns off — and `warnOnly` exists so a studio can adopt
the gate without breaking their build on day one.

**What the summary carries.** All five modules reach the one-page summary, in the
order the questions get asked: pass or fail against this device class, what
limited the frame, one line per subsystem, and the worst frame collapse with what
coincided with it. A subsystem that could not be measured keeps its row and says
so — dropping it would make a run that measured two subsystems look like a run
where five were fine.
