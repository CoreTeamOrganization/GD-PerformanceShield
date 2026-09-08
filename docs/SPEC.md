# Unity Mobile OOM Risk Analyzer — Finalized Process & MVP Plan

> This is the source-of-truth specification for GD-PerformanceShield, reproduced here so
> the implementation and its requirements live together. Where the build departs
> from this document, the departure and its reasoning are recorded in
> [SPEC_DEVIATIONS.md](./SPEC_DEVIATIONS.md).

## 1. Studio Inputs

For the MVP, ask each studio for only:

1. **APK or APK download link**
2. **GitHub access to the complete Unity project**, plus the target/latest branch to analyze.

The tool can perform the remaining intake steps automatically.

### Important
The repository should contain the complete Unity project, including:
- `Assets/`
- `ProjectSettings/`
- `Packages/`
- `.meta` files
- Scenes and Prefabs
- Addressables configuration

`.meta` files and project settings are required because many OOM risks come from Unity import/editor configuration, not C# code.

---

## 2. Final End-to-End Process

```text
Studio Input
 ├─ APK / APK Link
 └─ GitHub Access + Branch
        ↓
Automated Intake
 ├─ Clone repository
 ├─ Checkout branch
 ├─ Validate Unity project
 ├─ Download APK
 ├─ Inspect APK
 └─ Create analysis ID
        ↓
Static Analysis
 ├─ Code
 ├─ Assets
 ├─ Import settings
 ├─ Scenes/prefabs
 └─ Initial OOM hypotheses
        ↓
Device Test Setup
 ├─ Detect devices
 ├─ Install APK
 ├─ Launch game
 ├─ Detect correct PID
 └─ Start telemetry
        ↓
Gameplay / Flow Execution
 ├─ Human plays in MVP
 ├─ Tool records memory
 └─ Tool records test events
        ↓
Live Analysis
 ├─ Spikes
 ├─ Retained growth
 ├─ Repeated baseline growth
 └─ Process/OOM events
        ↓
Correlation
 ├─ Static findings
 ├─ Runtime memory
 └─ Game events
        ↓
Scoring
        ↓
Automatic Studio Report
```

---

## 3. Can Unity Scene Setup Define the Gameplay Flow?

### Partially, not completely.

The tool can inspect Build Settings scenes, scene order, `SceneManager.LoadScene`, additive loading, UI references, Addressables, game managers and persistent objects, and build a candidate structure:

```text
Boot
 ↓
MainMenu
 ├─ Shop
 ├─ Settings
 └─ LevelSelect
       ↓
    Gameplay
       ↓
     Results
       ↓
    MainMenu
```

However, this does **not** tell the tool exactly how to play the game: a whole game may exist in one scene; scene names may be misleading; custom state machines may control navigation; gameplay may need joystick/gesture input; content may be unlocked progressively; login/network state may be required.

### Final rule

> Scene analysis tells us **where we may need to test**. It cannot universally tell us **how to play**.

---

## 4. How Should the Tool Play the Game?

### MVP recommendation: Manual gameplay, automatic analysis.

The tool automatically handles APK installation, app launch, correct process detection, session creation, memory telemetry, device metrics, event timestamps, anomaly detection and report generation.

The human handles login, game-specific navigation, actual gameplay and unusual controls.

---

## 5. Manual Testing Workflow

```text
1. Connect Device A.
2. Connect Device B.
3. Select the game.
4. Click Start Analysis.
5. Tool installs APK.
6. Tool launches game.
7. Tool finds the game PID.
8. Tool starts telemetry.
9. Tool records baseline.
10. Human plays.
```

Operator UI event buttons: Main Menu, Gameplay Start, Gameplay End, Shop, Inventory, Settings, Baseline, Flow Complete, Custom Event.

Example timeline:

```text
10:00:00 App launched          410 MB
10:00:25 Main Menu             450 MB
10:01:10 Gameplay Start        470 MB
10:03:20 Peak                  890 MB
10:05:00 Gameplay End          760 MB
10:05:30 Recovery              640 MB
```

The human labels game states; the system captures all technical measurements automatically.

---

## 6. Why Not AI Gameplay First?

Studios differ in controls, genres, login systems, UI, progression, networking and loading flows. A universal AI player would introduce non-deterministic test paths, failures and stuck states, expensive development, and poor comparability between runs.

> **MVP = automate profiling, not all gameplay.**

---

## 7. Future Automation Roadmap

1. **Manual** — human plays; tool analyzes automatically.
2. **Recorded deterministic flows** — save successful manual routes and replay them.
3. **Studio-provided test hooks** — debug menus, level selectors, test accounts, test routes.
4. **UI automation** — deterministic taps, swipes, keyboard input and checkpoints.
5. **AI-assisted discovery** — AI discovers unknown screens and candidate flows; successful routes are saved as deterministic scripts.

---

## 8. Standard Test Protocol

- **Test A — Cold Launch:** fresh state → launch → wait for stable state → record baseline.
- **Test B — Major UI:** open major UI → close → return to baseline. (Shop, Inventory, Customization, Settings, major popups.)
- **Test C — Repeated Gameplay Loop:** Main Menu → Gameplay → Play → Exit → Main Menu. Repeat 3–5 times.
- **Test D — Content Transition:** Content A → B → C → A.
- **Test E — Long Session:** a standardized longer session where practical.

---

## 9. The Most Important OOM Metric: Recovery

Do not only measure peak memory.

```text
Initial Baseline = stable starting memory
Peak            = highest memory during the flow
Recovered       = memory after returning to the same state

Recovery Delta  = Recovered - Initial Baseline
```

Example:

```text
Initial Main Menu:  500 MB
Gameplay Peak:      950 MB
Returned Menu:      650 MB
Recovery Delta:    +150 MB
```

Repeat:

```text
Cycle 1: +150 MB
Cycle 2: +310 MB
Cycle 3: +470 MB
```

This is stronger evidence of retention than simply reporting a 950 MB peak.

---

## 10. Two-Device Strategy

- **Device A — Lower/Mid Memory:** expose practical OOM risk and memory pressure.
- **Device B — Higher Memory:** compare behaviour and separate memory growth from device-budget limitations.

```text
Device A: baseline grows and app eventually dies.
Device B: same baseline growth but no immediate termination.
```

Do not average the devices into one score. Report Device A risk, Device B risk, and cross-device behaviour.

---

## 11. Continuous vs Deep Monitoring

**Continuous lightweight telemetry** collected throughout the session: timestamp, PID, PSS, SwapPSS where available, major memory categories, process state, available device memory, important log events.

**Deep capture** triggered only when useful: large spike, sustained growth, repeated recovery failure, crash, process restart, end of repeated flow. Possible artifacts: Unity Memory Profiler snapshot where supported, logs, screenshots, advanced Android profiling.

---

## 12. Static-to-Live Correlation

Static analysis produces hypotheses:

```text
Hypothesis:      Shop assets may not be released.
Static evidence: Large shop textures. Addressable loading. Suspicious or missing release path.
```

During testing:

```text
Open Shop:  +220 MB
Close Shop: +180 MB remains
Repeat:     baseline continues growing
```

> Final result: High-confidence memory retention risk related to Shop content.

---

## 13. MVP Scope

**Fully automated:** GitHub clone and branch checkout, Unity project validation, static analysis, APK download and inspection, device detection, APK installation, app launch, PID detection, memory monitoring, event timeline, anomaly detection, repeated-flow comparison, static/runtime correlation, scoring, report generation.

**Human-driven:** gameplay, game-specific navigation, login, important state markers.

**Later:** recorded flows, UI automation, AI exploration, Unity instrumentation, automatic scene/state recognition, iOS support.

---

## 14. One-by-One MVP Implementation Steps

1. **Analysis Job System** — unique analysis ID, workspace, artifacts, status tracking:

   ```text
   analysis/
     game_id/
       metadata/  source/  static/  apk/  devices/
       telemetry/ logs/    events/  reports/
   ```

2. **Studio Intake** — GitHub repository, branch, APK file or URL; clone, checkout and download automatically.
3. **APK Inspector** — package name, version, ABI, launcher activity, manifest metadata.
4. **Device Manager** — connected-device detection, serial numbers, model, Android version, RAM, storage. Always target `adb -s DEVICE_SERIAL`.
5. **APK Install and Launch** — install/reinstall, force stop, launch, PID detection, restart detection.
6. **Continuous Memory Telemetry** — time-series collector for process and device memory.
7. **Manual Event Marker UI** — Main Menu, Gameplay Start, Gameplay End, Shop, Inventory, Settings, Baseline, Custom Event.
8. **Static Rule Engine** — each rule returns rule ID, evidence, severity, confidence, recommendation. High-value rules: large textures; Read/Write enabled; large RenderTextures; `renderer.material`; `DontDestroyOnLoad`; unbounded collections; `Resources.LoadAll`; Addressables lifetime; frequent Instantiate; runtime Texture/Mesh creation; risky audio loading; temporary RenderTexture release.
9. **Asset Analysis** — textures, sprite atlases, meshes, audio, lightmaps, reflection probes, scenes, build settings.
10. **Anomaly Detector** — sudden spikes, sustained growth, recovery failure, repeated baseline increase, process termination.
11. **Repeated Flow Analysis** — peak, recovery delta, baseline slope, repeatability.
12. **Correlation Engine** — static finding + runtime event + memory anomaly + optional deep evidence.
13. **Scoring Engine** — Static Risk, Live Risk, Combined Risk, Confidence, Priority. Do not simply average rule counts.
14. **Report Generator** — structured JSON as the source of truth; JSON, Markdown first, HTML later, PDF later.
15. **Standard Test Templates** — cold launch, major UI, gameplay loop, repeated loop, content transition, long session.
16. **Deep Capture Triggers** — advanced capture on major anomalies.
17. **Recorded Flow Playback** — record successful manual interactions and replay them.
18. **AI Exploration** — only after the deterministic profiling pipeline is reliable.

---

## 15. Final MVP Architecture

```text
Studio
 ├─ APK / Link
 └─ GitHub + Branch
        ↓
  Intake Manager
        ↓
 ┌──────────────┬──────────────────┐
 ▼              ▼                  ▼
Static      APK Inspector    Analysis Job
Analyzer
        ↓
 ┌──────────────┴──────────────────┐
 ▼                                 ▼
Device A                        Device B
Low/Mid Memory                  Higher Memory
 ▼                                 ▼
 └──────────────┬──────────────────┘
                ▼
          ADB Telemetry
                ↓
          Manual Gameplay
                ↓
          Event Marker UI
                ↓
          Anomaly Detector
                ↓
          Correlation Engine
                ↓
           Scoring Engine
                ↓
          Structured JSON
                ↓
          Markdown Report
```

---

## Final Recommendation

> **A human plays the game while the tool automatically analyzes the Unity project, installs and launches the APK, profiles the correct process, records memory telemetry, timestamps important game states, detects anomalies, compares repeated loops, correlates runtime behaviour with source/asset risks, scores findings, and generates an evidence-based studio report.**

Evolution:

```text
Manual Gameplay + Automatic Analysis
            ↓
Recorded Deterministic Flows
            ↓
Studio Test Hooks + UI Automation
            ↓
AI-Assisted Exploration
            ↓
More Autonomous Testing
```

The core product value is not autonomous gameplay. It is:

> **Automatically identifying where memory is at risk, measuring how serious the risk is on real devices, correlating it with likely source/asset causes, and giving studios a simple evidence-based explanation of what to improve.**
