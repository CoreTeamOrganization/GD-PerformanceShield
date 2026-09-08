# GD-PerformanceShield

Unity mobile performance and stability analyzer. Give it a studio's **APK** and **Unity
repository**; it analyses the project, installs and profiles the build on real
Android devices while a human plays, correlates what it measured against what it
found in the source, scores the risk, and writes an evidence-based report.

Built to the specification in [docs/SPEC.md](docs/SPEC.md). Departures from it are
recorded in [docs/SPEC_DEVIATIONS.md](docs/SPEC_DEVIATIONS.md). Every project
analysis check, its threshold, and what it does and does not prove is listed in
[docs/PROJECT_CHECKS.md](docs/PROJECT_CHECKS.md).

---

## What it does

| Automated | Human |
|---|---|
| Detect devices, assign A/B roles, install, launch, confirm the game is in front | Play the game |
| Download and inspect the APK | Log in, navigate menus |
| Sample memory continuously; watch logcat and process lifecycle | Press a marker when the game reaches a state |
| Measure frame rate per second, with the percentile ladder (p01 to p99) | |
| Sample GPU, CPU threads, storage I/O and audio on the same clock | |
| Detect memory spikes, retention, recovery failure, kills | |
| Detect frame-rate drops and level changes, and rank them | |
| Name the likely cause of each drop, with the evidence and a confidence level | |
| Read heat, throttling and battery | |
| Compare two sessions against a measured noise floor | |
| Score risk, apply a pass/fail gate, generate the report | |

The MVP deliberately does **not** automate gameplay. Automating profiling across
25+ different games is tractable; automating play across them is not, and a
non-deterministic AI player would make runs incomparable. The roadmap for getting
there is in spec §7, and the architecture leaves room for it.

### Currently switched off

Reading the **Unity project** alongside the device measurement - static analysis
of assets, import settings, scenes and C#, and tracing a measured spike back to
the line that caused it - is built and tested but not exposed. The project-folder
field is hidden in the console and the project-derived sections are omitted from
the report, including the caveats that exist to explain a *missing* project:
with the field hidden there is nothing missing, and saying causes "cannot be
identified" without it would describe an input the operator was never offered.

It is one value in [`src/core/features.ts`](src/core/features.ts). The CLI still
accepts `--project`, and the analysis behind it is unchanged.

---

## Requirements

- **Node.js 20.11+** (developed on 24)
- **git** on `PATH` (for repository intake)
- **adb** — from Android platform-tools, auto-detected from `ANDROID_HOME` or `PATH`
- No native modules, no Android SDK build-tools required. `aapt2` is used as a
  cross-check if present but the APK parser does not need it.

The packaged `.exe` needs none of the above except **adb** — Node and every
dependency are inside it.

```bash
npm install
npm test          # 66 tests, no devices needed
```

---

## Quick start

### The desktop app (recommended)

A real desktop application — icon, window, native file dialogs. No browser, no
terminal.

```bash
npm install
npm run desktop            # run it from source
npm run dist:win           # build the Windows app + installer
npm run dist:mac           # build the macOS dmg + zip  (must run on a Mac)
```

Output lands in `dist-desktop/`:

- `win-unpacked/GD-PerformanceShield.exe` - the app itself. Self-contained; copy the
  folder anywhere and run it.
- `OOM-Inspector-<version>-win-x64.zip` - the same folder, zipped for handing to
  a studio.
- `GD-PerformanceShield-<version>-x64.exe` - the NSIS installer, **if** your machine can
  build it (see below).

**Building the installer needs one extra privilege on Windows.** electron-builder
fetches its signing toolchain before checking whether a certificate exists, and
unpacking that archive creates symlinks, which Windows refuses to ordinary
processes. The app itself builds fine either way - only the installer step fails.
Fix it by enabling **Developer Mode** (Settings → System → For developers) or by
running the build from an Administrator terminal. CI runners already have the
privilege.

The window walks you through four steps:

1. **Choose what to analyze** — the panel asks one thing at a time and shows
   nothing you have not reached yet. Pick the **device** (auto-selected when only
   one is attached), which reveals the **game** picker; choosing a game reveals
   the options and the **Analyze** button. Nothing is installed or copied; the
   analysis launches what is already there.
2. **Analysis progress** — each stage as it runs, with what it found.
3. **Play the game** — a live **memory** chart and a live **frame-rate** chart on
   one clock, either of which can be clicked at any point for what every
   subsystem was doing at that instant. Marker buttons with keyboard shortcuts
   *(device mode only)*.
4. **Report** — verdict, per-device results, recovery table, and ranked fixes
   with evidence. Buttons to open the report folder or the raw files.

Reports are written to `Documents/GD-PerformanceShield` by default.

**macOS note:** the build is configured for macOS (dmg + zip, Intel and Apple
Silicon) but electron-builder cannot produce a `.dmg` from Windows — it needs
macOS-only tooling for the disk image and signing. Build it on a Mac, or on CI
with a `macos-latest` runner.

Both platforms should be code-signed before you hand them to studios
(Authenticode on Windows, Developer ID + notarization on macOS), or users will
see SmartScreen and Gatekeeper warnings.

### The single-file executable

If you would rather have one file and no installer, there is also a CLI-plus-
browser build with everything embedded:

```bash
npm run build:exe          # -> dist-exe/gd-performance-shield.exe  (~90 MB, one file)
```

Double-clicking it starts the server and opens the console in your default
browser. Same console, same pipeline — it just borrows a browser window instead
of shipping its own. `npm run gui` does the same from a source checkout.

### From the command line

Static analysis only — no devices, CI-friendly:

```bash
npx gdshield scan --name "Cosmic Racer" --local ./cosmic-racer --apk ./build.apk
```

Against a repository instead of a local folder:

```bash
npx gdshield scan --name "Cosmic Racer" --repo https://github.com/studio/cosmic-racer.git --branch release/1.4 --apk ./builds/cosmic-racer.apk
```

Full analysis with devices and terminal marker prompts:

```bash
npx gdshield analyze --name "Cosmic Racer" --repo https://github.com/studio/cosmic-racer.git --apk ./build.apk --fresh-state
```

### Utilities

```bash
npx gdshield devices              # connected devices with assigned A/B roles
npx gdshield inspect-apk app.apk  # package, version, ABIs, Unity version, backend
npx gdshield list                 # previous analyses
npx gdshield report <analysisId>  # re-render a stored report
```

---

## Configuration

Copy `.env.example` to `.env` or set the variables directly.

| Variable | Purpose |
|---|---|
| `GDPS_WORKSPACE_ROOT` | Where analysis workspaces live (default `./analysis`) |
| `GDPS_ADB_PATH` | Explicit adb binary |
| `GDPS_AAPT2_PATH` | Explicit aapt2 binary (optional) |
| `GDPS_GITHUB_TOKEN` | Token for private repository clone |
| `GDPS_PORT` | Console port (default 7845) |
| `GDPS_FAST_SAMPLE_MS` / `GDPS_DEEP_SAMPLE_MS` | Sampling cadences |
| `GDPS_LOG_LEVEL` | `trace`…`error` |

The pre-rename `OOM_*` spelling of every variable above is still accepted as a
fallback, so shells and CI jobs set up before the rename keep working.

---

## Output

Every run writes a self-contained workspace (spec §14 Step 1):

```text
analysis/<game-id>/<analysis-id>/
  metadata/   job.json                       job status and stage ledger
  apk/        the APK, inspection.json
  devices/    devices.json, launch_*.json    launch result, fresh-start result
  telemetry/  <session>_<serial>.jsonl       memory samples, one per line
  events/     <session>.jsonl                operator markers + lifecycle events
  logs/       job.jsonl, *_logcat.jsonl
  reports/    report.json, report.md, report-summary.md, quality-gate.json
```

Two cuts of the same run, because they answer different questions:

| File | For | Holds |
|---|---|---|
| `report-summary.md` | a lead or producer | the verdict, what it costs, what to do |
| `report.md` | whoever opens the project | every finding with its evidence, the event timeline, the subsystem detail |
| `quality-gate.json` | a build pipeline | pass/fail per check, so CI need not parse the report |

### Sharing a report outside your team

The report panel has **Export PDF…**, which lets you tick any combination of the
three cuts and writes each one as a standalone PDF.

Those PDFs are written for someone who has never used this tool and never will:
they explain their own terms, carry no file paths or links back into the app, and
need nothing installed to read. The summary is what you hand a producer; the
developer report is what you hand the engineer who has to fix it.

PDFs are rendered by Chromium's own print engine inside the desktop app, so there
is no extra dependency. In browser mode the same pages open with the print dialog
already up, and you choose "Save as PDF" there.

`report.json` is the source of truth and is schema-validated
([`src/report/model.ts`](src/report/model.ts)) before it is written — a rendering
bug cannot ship a malformed report. `report.md` is a rendering of it, written for
a studio lead rather than for us: headline verdict, per-device results, ranked
fixes with evidence, then detail.

Telemetry is append-only JSONL, so a session that ends in a crash — the one you
most want — still has every sample taken up to that moment on disk.

---

## How to read a result

The report separates three things that are usually conflated:

- **Static risk** — predicted from the project. Nothing has been observed.
- **Live risk** — measured on real hardware.
- **Evidence confidence** — how much of the intended evidence was actually
  collected. A static-only run says so in the headline; a one-device run says
  cross-device comparison was unavailable.

Findings measured on device *and* explained by something in the project are
reported as **correlated** and carry the highest confidence. That is the
spec §12 mechanism: "closing the Shop keeps 180 MB" plus "the Shop's Addressables
are never released" is a far stronger statement than either alone.

The headline metric is **recovery delta**, not peak (spec §9). Peak is confounded
by device budget and content size; memory that never comes back after returning
to the same screen is direct evidence of retention.

---

## Architecture

```text
src/
  core/       job system, workspace, config, JSONL, logging, exec
  intake/     git clone, Unity project validation, APK acquisition
  apk/        ZIP reader, binary AndroidManifest parser, APK inspector
  devices/    adb wrapper, device manager (A/B roles), install/launch/PID
  telemetry/  two-tier memory probes, sampler, logcat monitor, capture session
  events/     operator marker vocabulary
  static/     asset index, code index, scene index, rule engine, rules
  analysis/   timeline, anomaly, repeated-flow, correlation, scoring
  report/     schema, assembly, Markdown renderer
  pipeline/   end-to-end orchestration
  server/     console API + WebSocket, native file dialogs, embedded assets
  ui/         zero-build desktop console
  cli/        commands
```

The pipeline is the single implementation of the flow — the CLI and the browser
console both drive it, so a run started from either is the same run.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the extension points
(new rules, new probes, recorded flows, UI automation).

---

## Status

Implements spec §14 Steps 1–15, plus the frame-rate, subsystem and root-cause
layers described above. Steps 16–18 (deep capture triggers, recorded flow
playback, AI exploration) have their interfaces in place and are not implemented —
by design, per spec §7 and §13.

Project-side analysis is complete and switched off; see **Currently switched
off** above.
