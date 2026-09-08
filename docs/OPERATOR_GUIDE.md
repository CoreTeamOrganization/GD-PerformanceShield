# Operator guide

How to run a session that produces a report worth sending to a studio.

The tool measures everything technical automatically. Your job is to play the
game and label what state it is in. The quality of the report depends almost
entirely on how you do the second part.

---

## Before you start

1. **Two devices.** Device A should be the lowest-memory device you support —
   that is the one that exposes real risk. Device B should be comfortably above
   it. Roles are assigned automatically from measured RAM; you do not choose them.
2. **Both devices unlocked, screens on, USB debugging authorized.** Check with
   `npx gdshield devices` — every device you intend to use must be listed.
3. **Close background apps** on both devices. A device already under pressure
   produces results you cannot compare against anything.
4. **Know the game.** Skim the screens you intend to visit before you start
   recording. Fumbling through a menu during a session adds noise you cannot
   remove afterwards.

---

## Markers

Press a marker the moment the game *reaches* the state, not while it is still
loading into it. The analysis measures memory before and after each marker, so a
marker pressed mid-transition blurs exactly the number it exists to produce.

| Key | Marker | Press it when |
|---|---|---|
| `b` | Baseline | Memory is stable at a reference state. All recovery deltas measure against this. |
| `1` | Main Menu | The menu is loaded and idle. |
| `g` | Gameplay Start | Control has been handed to the player. |
| `h` | Gameplay End | Gameplay is over and you are returning to the menu. |
| `2` | Shop | The shop is open and settled. |
| `3` | Inventory | Inventory/customization is open. |
| `4` | Settings | Settings is open. |
| `c` | Close Screen | You have closed the screen you just opened. |
| `f` | Flow Complete | One full test cycle is finished and memory has settled. |
| `x` | Custom Event | Anything else worth marking (prompts for a label). |

Two rules that matter more than the rest:

- **Always pair an open with a close.** `Shop` then `Close Screen` is what lets
  the tool measure whether the shop's memory was released. `Shop` followed by
  `Inventory` measures nothing about release.
- **Wait for memory to settle before `Flow Complete`.** Give it a few seconds
  back at the menu. Pressing it the instant you arrive measures the transition,
  not the recovered state.

---

## The standard protocol

Run these in order. Each one answers a different question.

### Test A — Cold launch

Start the analysis with **Clear app data before launch** enabled.

```
launch → wait until fully idle (~15–30 s) → press Baseline
```

Gives you the reference every other number is measured against.

### Test B — Major UI

For each of Shop, Inventory, Customization, Settings and any major popup:

```
press the screen's marker → look around briefly → close it → press Close Screen
→ wait ~5 s → press Baseline
```

Repeat each screen 2–3 times. One visit tells you what a screen costs; repeated
visits tell you whether the cost is being given back.

### Test C — Repeated gameplay loop

**The most important test.** Run it 3–5 times:

```
Main Menu → press Gameplay Start → play a full round → press Gameplay End
→ return to menu → wait to settle → press Flow Complete
```

Play roughly the same way each round. Consistency is what makes the cycles
comparable — the report scores repeatability and discounts confidence when the
rounds diverge.

This is what produces the recovery-delta table: whether returning to the menu
costs +150 MB, then +310 MB, then +470 MB.

### Test D — Content transition

```
Content A → B → C → back to A → press Flow Complete
```

Returning to A is the point. If A costs more the second time, content is not
being released on transition.

### Test E — Long session

Play continuously for 10–20 minutes with markers as states change. This is the
only test that reliably separates a slow leak from normal load peaks.

---

## During the session

There are two charts on one clock: **memory** and **frame rate**. Click either
one anywhere — not just on the lettered dots — and it opens what every subsystem
was doing at that instant, including the category breakdown of what memory did.

Where a frame-rate drop lines up with a memory jump, the frame-rate panel names
the memory event by its letter. That is one event seen twice, not two problems.

Three things are worth reacting to:

- **A device card turns red** — the process died. That is the strongest result
  the tool can produce. Note what you were doing; it will be in the report, but
  your own note is worth more.
- **The baseline visibly steps up after each cycle** — you have found the thing
  you came for. Keep going: more cycles make the finding stronger, and running
  until it dies makes it undeniable.
- **The frame-rate chart says it is waiting for samples for more than a few
  seconds** — check the game is actually on screen. See below.

If the game crashes, do not stop the session. The tool records the kill, the
restart and the new PID, and continues. Restarting the session throws that away.

### Keep the game in the foreground

This is the one operator error that produces a report full of numbers that are
quietly wrong. A backgrounded Unity app keeps its process and keeps reporting
memory, but its renderer is throttled or paused — so the frame rate recorded is
the frame rate of a paused game, and it looks entirely normal.

The tool checks after launch that the game holds the foreground, brings it back
if something else takes it, and if it cannot win, says so in the report and
disowns every frame-rate figure in that run. Memory figures stay valid.

In practice: unlock the phone, leave it on the game, and let **Close other apps
first** do its work. Ad-heavy titles left running in the background are the usual
culprit — they can take the foreground back a second after launch.

---

## After

Press **Stop & generate report**. You get `report.json` (the structured source of
truth) and two Markdown cuts of the same data - `report-summary.md` for a lead,
and `report.md` with the whole evidence trail.

The summary is one page and is meant to be understood at a glance: the risk
status and score, how much of the intended testing actually happened, the four
numbers that matter (peak memory, average frame rate, peak heat, stutter), the
single biggest issue, how the game felt to play, and one line of conclusion. It
is the page you send to someone who will not read a report. Everything that
explains those figures - the memory and frame-rate charts, the memory jumps, the
findings with their fixes, the methodology and the caveats - is in `report.md`.

Nothing needs exporting for those: they are written into the session's own
`reports` folder the moment the run finishes, and the report panel lists their
full paths under **Saved on this machine**. **Show files** opens that folder.

**Export PDF…** is only for the standalone copies you send on. It asks for a
folder - defaulting to the same `reports` folder - renders each chosen cut
offscreen, and then lists exactly which files it wrote. If it cannot write one,
it says which and why; it never opens a print dialog.

Before sending, check the report's own limitations section. If it says confidence
was low because you ran one device, or fewer than three cycles, or a session
under two minutes — that is worth a second run rather than a caveated report.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `No usable Android devices are connected` | Enable USB debugging and accept the prompt on the device. Verify with `adb devices`. |
| Install fails with `signatures do not match` | Only reachable from `gdshield scan --apk`: a build with a different key is installed. Re-run with `--fresh-install`. |
| Install fails with `NO_MATCHING_ABIS` | The APK has no native library for that device (e.g. arm64-only APK on a 32-bit device). |
| `did not start within 60000ms` | The game crashed on launch. Check `adb logcat` for a fatal exception; confirm the screen is on and unlocked. |
| Chart shows a dashed line only | The fast probe is unavailable (release build on a device with `hidepid`), so only RSS is being sampled. The report will say so. Results are still valid, at lower resolution. |
| Memory looks suspiciously flat | Possibly profiling a helper process. Check the PID on the device card against `adb shell ps -A \| grep <package>`. |

## Comparing two sessions

Two gameplay sessions are joined **by marked screen**, never by elapsed time —
sixty seconds into one playthrough is a different point in the game from sixty
seconds into another, so only named game states can be lined up.

### 1. Record a baseline, then repeat it

In **Play the game**, pick a previous run under *Repeat a previous session*. Its
markers appear as an ordered checklist and tick off as you press them. Order is a
suggestion; coverage is what matters, so a step pressed out of sequence still
ticks. Nothing is forced — a checklist that blocked the tester would produce a
tidy comparison of a session nobody actually played.

### 2. Establish the noise floor (do this once per device)

Record the **same build twice**, then name that pair as the baseline in
*Compare sessions*. Whatever two identical builds disagree about is run-to-run
variance by definition, and later comparisons mark anything smaller as noise
rather than as change.

Without a baseline the comparison still runs and says so plainly. Skipping this
step is what makes a 1 MB drift look like a regression.

### 3. Compare

Pick the earlier and later runs and press **Compare**. The comparison reports:

| | |
| --- | --- |
| **Per-screen retention** | What did not come back after leaving each screen. The most reliable figure: a closed loop, independent of what the tester did before or after. Retention going up is a regression. |
| **Process kills** | Binary, and never subject to the noise floor. |
| **Budget verdict** | green / yellow / red against the same device tier. |
| **Session peak** | Reported **only** where both runs visited the same screens. A longer playthrough peaks higher; that is the tester, not the build. |

It refuses outright on a different app or different hardware, and warns on a
different Android version or a second handset of the same model.

### From the command line

```
gdshield route <analysisId>                      # print a past session's marker route
gdshield compare <beforeId> <afterId>            # Markdown to stdout
gdshield compare <a> <b> --baseline <c>,<d>      # with a measured noise floor
gdshield compare <a> <b> --fail-on-regression    # exit 1 on a regression, 2 if not comparable
```

The last form is what a studio runs in CI against last week's baseline.

## Frame rate, heat and battery

Recorded automatically alongside memory. While you play, each device card shows
live **FPS**, **temperature** and **battery**, and flags the device when Android
reports that it is throttling.

**Frame rate** is measured from the compositor, so it is what the player saw.
For a Unity build this needs SurfaceFlinger's per-layer timing; where a device
does not support that, the tool falls back to `gfxinfo` and says so in the
report, because `gfxinfo` cannot see a Unity surface and under-reports.

It is reported as a **percentile ladder**, not just an average, because an
average of 58 with a p01 of 12 is a game that stutters and the average alone
hides it:

| | |
|---|---|
| `p50` | the typical second |
| `p05` | whether drops are frequent |
| `p01` | the player's worst moments |

These are computed exactly as the in-game recorder (`GDPerfTracker`) computes
`fps_p01`, `fps_p50` and the rest — same formula, same one-second samples — so a
report and an analytics payload from the same build can be read side by side.
The complete report has a table mapping the two field-for-field.

Read them against the cap the build asked for, not against 60: the tool cannot
see `Application.targetFrameRate` from outside the process, so it leaves that
column blank rather than guessing.

**Heat** is reported as the rise as well as the peak — phones idle anywhere from
24 to 35 degrees, so the rise is what compares between sessions.

**Battery drain cannot be measured over a USB cable**, because the phone is
charging. The report says so rather than printing a meaningless figure. To
measure it, profile over wireless adb:

```
adb tcpip 5555
adb connect <device-ip>:5555      # then unplug the cable
```

## GPU, CPU, storage and audio

Recorded automatically alongside memory, on the same slow cadence as
`dumpsys meminfo`. The summary report gives each of them one line, says which
was limiting the frame rate, and — where the frame rate collapsed — what every
other subsystem was doing at the same moment.

Two of them depend on the device, and two on the build. It is worth knowing
which before you start, because the report will tell you afterwards either way:

| What | Needs | If it is missing |
|---|---|---|
| GPU load and clock | Vendor sysfs readable by an adb shell | Most retail phones deny it. The report says which nodes were tried and what came back. Use a rooted or engineering device to get it. |
| Draw calls, triangles, texture memory, per-frame main/render/GPU times | The reporter component in the build | Add `scripts/unity/PerformanceShieldReporter.cs` and make a **development build**. Without it the tool can only infer what limited the frame, and says so. |
| Per-core and per-thread CPU | `/proc` readable — usually fine | Reported as not measurable rather than as an idle device. |
| Storage read/write and loading stalls | A debuggable build (`run-as`) or a rooted device | A release build on a stock handset denies the counters. |
| Audio voices and audio-thread CPU | The reporter component | Mixer track counts still come from the device. |
| Audio buffer underruns (crackle) | The device's audio server printing them | Many do not. The report says the counters were absent rather than claiming the audio was clean. |

**A figure that is missing is never shown as zero.** A zero GPU utilisation
would read as "the GPU was idle" and a zero underrun count as "nothing
crackled", so anything the run could not measure appears as *not measured*, with
the reason and what to change. A subsystem row that says "not measured" is not a
pass.

**The one thing worth changing before a serious session** is the reporter
component. It is a single file, it costs three log lines a second, and it is the
only source for draw calls, geometry and the three per-frame stage times — which
are what turn "the frame rate dropped" into "the GPU took 58 ms for that frame
while draw calls tripled". Compiled only into development builds, so it cannot
reach players by accident.

**Close other apps first, and check the background figure.** The report states
how much CPU everything other than the game used. Above about a quarter of the
device, the session measured a busy phone as much as it measured the build — the
summary flags it, and the fix is a fresh-start run on a quiet device.

## Build checks for a pipeline

Every session writes `quality-gate.json` next to the report. It grades the run
against thresholds for the device's hardware class — low-end, mid-range or
high-end — and is meant to be read by a build job rather than a person:

```
status     "pass" | "warn" | "fail"
passed     true unless something failed
exitCode   0, or 1 on failure
summary    counts, plus the names of the checks that failed or were skipped
devices[]  every check with its measured value, its limit and one line of detail
```

A minimal GitHub Actions or Jenkins step:

```
jq -e '.status != "fail"' reports/quality-gate.json
```

Three things to know about it. **A check that could not be measured is skipped,
never passed** — `summary.skipped` and `summary.skippedChecks` say which, and a
green gate with four skipped checks is not a green build. **A figure within 10%
of its limit is a warning rather than a failure**, because two runs of the same
build on the same phone differ by a few percent. And **the thresholds travel with
the result**, so when a build goes red the first question is answerable from the
file: it carries the limit, the measurement, and the device class the limit came
from.

The thresholds themselves are printed in the complete report, under
*Performance thresholds per device class*. They are common practice rather than
anything a platform publishes, and a studio is meant to disagree with them where
their game warrants it.

## Comparison PDF

After running a comparison, **Save as PDF** produces a single print-ready
document covering frame rate, heat, battery, risk, peak usage, per-screen
retention, session times and both devices' details. It is written for someone
who was not present at either session — no tool jargon, and every figure the
comparison cannot stand behind appears as the reason it is missing rather than
as a number.

## Close other apps first

Checked by default in **Choose what to analyze**. Before the game launches, the
tool frees memory so the peak is what the build needs rather than what was left
over from whatever else was resident.

Two steps: `am kill-all`, which asks Android to reclaim every background
process, then force-stopping the third-party apps that still hold one. The
**home screen and the keyboard are left running** — resolved from the system, so
this is correct on any vendor's phone rather than a guess. Anything skipped is
recorded with the reason.

The report states how much was freed and how much was free at launch, because
that changes what the peak means: the same build on the same phone can survive a
cleared start and be killed on a busy device. Comparing a cleared run against an
uncleared one raises a warning for the same reason.

Uncheck it to measure the phone as a player would actually have it.

## Start and end readings

Every report records temperature and battery **at the start and at the end** of
the session, alongside the peak. The peak is what throttled; the end is the
state the next session would begin from, and a device can touch 46 °C mid-run
and settle back to 40. Both appear in all three cuts and in the comparison.
