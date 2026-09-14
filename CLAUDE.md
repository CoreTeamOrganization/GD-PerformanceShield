# GD PerformanceShield

Unity mobile performance analyzer (Node/TypeScript + Electron, formerly "OOM
Inspector"). Give it an APK and a device; it profiles FPS/janks/memory/heat over
adb while a human plays, then writes evidence-based reports. Built to
[docs/SPEC.md](docs/SPEC.md); departures live in
[docs/SPEC_DEVIATIONS.md](docs/SPEC_DEVIATIONS.md). Owner: Ghulam Mohyuddin
(Game District); original author: Uzair Hassan. Internal tool for ~24 GD
studios — positioned against GameBench, wins on diagnosis (correlation,
recovery delta) rather than on raw metrics, which now match GameBench 1:1.

## Dev loop

```bash
npm test                  # vitest; all green is the bar (498 tests as of 2026-09-14)
npx tsc --noEmit          # typecheck (tsc builds nothing the app runs)
npm run desktop           # run the Electron app from source
npm run gui               # same console in a browser
npm run build:desktop && npx electron-builder --mac dmg --arm64 --config electron-builder.yml
                          # DMG -> dist-desktop/  (EJECT any mounted copy first
                          #  - a mounted /Volumes/GD-PerformanceShield blocks the
                          #  packager, and NEVER force-eject while the app runs
                          #  from it: that created 400%-CPU zombie processes once)
```

The UI (`src/ui`) is deliberately build-free plain JS, shipped as extraResources
(`Resources/ui` in the .app) — `node --check src/ui/app.js` after editing it.
`desktop/build/server.cjs` is a committed esbuild bundle; rebuild + commit it
when server-side code changes.

## Conventions that matter here

- **Comments are the codebase's voice**: they state the measured case that
  motivated a rule ("on a real session this read 32 where the truth was 42"),
  never what the next line does. Match that register.
- **Never report a number the evidence can't support.** Corrupt/unknowable
  windows return null, findings carry confidence, "confirmed" is reserved for
  observed events. This principle has repeatedly been the fix.
- Report schema (`src/report/model.ts`, zod) is a contract: new fields are
  `.nullable().optional()` so stored reports keep validating.
- Session workspaces land in `~/Documents/GD-PerformanceShield/<game>/<id>/`;
  telemetry is append-only JSONL — debug from those files, they survive crashes.

## Field gotchas (each cost a real debugging session)

- **One profiler at a time on a device.** GameBench clears SurfaceFlinger
  TimeStats (shared global counters) and corrupts our diffs; we now discard
  impossible windows and warn (`windowLooksTruncated`, src/telemetry/fps.ts).
- gfxinfo sees zero frames for Unity games (they bypass the View system) —
  that's why GameBench's free app reports 0 janks on Unity titles; our
  three-strategy fallback (TimeStats -> --latency -> gfxinfo) exists for this.
- adb self-provisions to `~/.gd-performanceshield/tools/` when missing
  (src/devices/adbProvision.ts); GUI apps get minimal PATH on macOS, so brew
  installs are also probed explicitly.
- A report only exists after the operator FINISHES the session; closing the app
  mid-capture leaves status `live_capture` and telemetry on disk but no report.
- Jank definitions: absolute 83/125 ms are primary ("a stall a player felt");
  `crossToolJanks` (2x median interval) is the GameBench-comparable estimate.
- Ad/home/return context lines come from ActivityTaskManager START lines
  (src/telemetry/activityEvents.ts); banners/overlay ads are invisible to it.
- **Two temperatures, never one.** The hottest kernel zone is a CPU/GPU die
  sensor and runs 20-30 °C above the battery under a game (Galaxy A36: die 65,
  battery 33, skin 38). Shown as "Temp" it read as the phone's temperature,
  went red, and was disbelieved. Live console and reports now label it CPU
  heat; phone heat is the battery sensor, which is also GameBench's figure.
- **The project must be the build's source.** Correlation names files with the
  same confidence whether or not they are in the APK. `assessBuildMatch`
  (src/intake/buildMatch.ts) compares the Android application identifier and
  bundleVersion against the profiled app: a different package skips the
  correlation stage, a different version is a report limitation, the commit is
  unverifiable. The console asks the operator to confirm before every run
  with a project.

## State and open threads (as of 2026-09-14)

Shipped: GameBench metric parity incl. FPS stability; live incident feed;
frame-time histogram; auto previous-run comparison in reports; ad/home/return
context lines (live + report charts); adb auto-provisioning; interference
guard; dark GD-gold instrument theme; arm64 DMG.

Open, in rough priority:
1. Dogfood on real GD games/devices; reconcile vs GameBench **run sequentially**.
2. Multi-device hardening pass (Samsung/older Android/60 Hz budget devices) —
   the FPS-source fallback chain is where field surprises live.
3. `projectAnalysis` feature flag (src/core/features.ts) is ON as of
   2026-09-14 to trial the memory side on real games: leaks/spikes are traced
   to the asset or script behind them (correlation.ts). FPS drops are NOT yet
   linked to code - they are timeline events, not findings, so correlate()
   never sees them. Next steps in order: Tier 1 = turn drops into findings
   tagged with screen + bottleneck verdict and teach correlate() which static
   rules explain CPU- vs GPU-bound drops (tool-side only); Tier 2 = add GC
   Allocated In Frame and per-subsystem ProfilerRecorder markers to
   scripts/unity/PerformanceShieldReporter.cs; Tier 3 = opt-in simpleperf/
   Perfetto deep capture on a drop (needs the build's IL2CPP symbol file).
4. Low-severity review leftovers for the developer: compareSessions merges
   screen visits across device roles; zero-length first flow cycle when the
   first marker is flow_complete; deviceTier panel-rate Math.min doc mismatch.
5. Web dashboard is PARKED by decision; when revived: Vercel (UI/API) +
   Supabase (Postgres/storage/Realtime) — GD buildings share no LAN and Vercel
   can't host WebSockets.
6. Play-Store-tap context line ("player left to the store") offered, not built.
7. Windows build for QA racks (`dist:win` on a Windows machine); code-signing/
   notarization before wide distribution.

Unrelated sibling tool: `~/Documents/GitHub/Package Memory Reader ` holds the
GD Play Memory Auditor (Python; Play-Console vitals vs Google's Feb 2027
thresholds) — different product, don't mix them up.
