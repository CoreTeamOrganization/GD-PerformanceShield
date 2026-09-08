# Architecture

How the pieces fit, and where to extend them.

---

## Layering

Dependencies point downward only. Nothing in `core/` knows about Unity, Android
or reports; nothing in `static/` knows about devices; nothing in `analysis/`
knows how telemetry was collected.

```text
cli/  server/                    entry points — thin, no logic of their own
      │
   pipeline/                     the single end-to-end orchestration
      │
 ┌────┴─────┬──────────┬──────────┬──────────┐
 ▼          ▼          ▼          ▼          ▼
intake/   apk/     devices/  telemetry/  static/     stage implementations
 │          │          │          │          │
 └──────────┴──────────┴────┬─────┴──────────┘
                            ▼
                       analysis/                      pure functions over data
                            ▼
                        report/                       schema + rendering
                            │
                          core/                       job, workspace, exec, log
```

`analysis/` is deliberately pure: it takes loaded telemetry and findings and
returns findings. It never touches a device or the filesystem, which is why it is
the easiest layer to test and the layer where the interesting logic lives.

---

## The pipeline

[`src/pipeline/pipeline.ts`](../src/pipeline/pipeline.ts) sequences the process
from spec §2. It has three phases with a deliberate pause between the second and
third:

```text
runIntakeAndStatic()      clone → validate → fetch APK → inspect → detect devices → static rules
        ↓
prepareCapture()          install → launch → resolve PID → start sampling
        ↓
   ... the human plays, pressing markers ...
        ↓
stopCapture() → finish()  timeline → anomaly → flow → correlate → score → report
```

The pause is the MVP's central design decision (spec §4). Everything on either
side is automated; the middle is a human. `prepareCapture` returns as soon as
telemetry is flowing, and the CLI or the browser console holds the session open.

Device detection runs *before* static analysis, so static rules can express
thresholds relative to the weakest device actually being tested rather than
against a hardcoded constant.

### Stage bookkeeping

Every stage runs through `job.runStage(name, fn, { optional })`, which records
start/finish/status into `metadata/job.json` after each transition and streams
the change to any UI subscriber. Optional stages that fail are recorded as
`skipped` with their reason and the run continues in degraded form — an
APK-only analysis is still useful, it just cannot identify causes. Skipped stages
become report limitations, so the output always states what it could not do.

---

## Extension points

### Adding a static rule

A rule is a pure function over the shared context. Add it to the appropriate file
in [`src/static/rules/`](../src/static/rules/) and register it in
[`src/static/index.ts`](../src/static/index.ts):

```ts
export const myRule: StaticRule = {
  id: 'UNITY.MY_RULE',
  title: 'Short name',
  category: 'import_setting',
  rationale: 'Why this causes OOM, in the report appendix.',
  run(ctx) {
    return ctx.assets.byKind.texture
      .filter(/* ... */)
      .map((asset) => ({
        ruleId: 'UNITY.MY_RULE',
        id: findingId('UNITY.MY_RULE', asset.relPath),
        source: 'static',
        title: '...',
        description: '...',
        severity: 'medium',
        confidence: 0.8,
        recommendation: 'What to actually change.',
        evidence: [{ kind: 'asset', summary: asset.relPath, path: asset.relPath }],
        estimatedBytes: asset.estimate?.bytes,
        subject: asset.relPath,
        tags: ['texture'],
      }));
  },
};
```

The indexes (`ctx.assets`, `ctx.code`, `ctx.scenes`) are built once, so a rule
costs nothing at scan time. A rule that throws is isolated and reported — it
cannot lose the other rules' findings.

Two things matter for a rule to be useful downstream:

- **`subject` and `tags`** are what the correlation engine matches on. A rule
  about shop content should have the word in its subject or evidence paths.
- **`confidence` must be honest.** It flows directly into the score. A rule that
  is often right but sometimes wrong should say so rather than being dropped.

### Adding a memory probe

Implement `MemoryProbe` in [`src/telemetry/probes.ts`](../src/telemetry/probes.ts):

```ts
class MyProbe implements MemoryProbe {
  readonly name = 'my_probe';
  readonly tier = 'fast';                       // or 'deep'
  async isAvailable(device, pid) { /* capability check, once per session */ }
  async sample(device, pid) { /* return a ProbeReading, or null on failure */ }
}
```

Add it to the candidate list in `MemorySampler.prepare()`. Availability is
checked once and recorded in the session manifest, so a report always states
which probes produced its numbers. A probe that is unavailable degrades the
session rather than failing it.

### Adding a marker

Add to `MARKERS` in [`src/events/markers.ts`](../src/events/markers.ts). The
operator UI renders buttons and hotkeys from that list automatically. Give it a
`semantics` value if the analysis layer should treat it specially — `flow_start`,
`flow_end`, `screen_open`, `screen_close` and `baseline` all drive measurements.

### Deep capture triggers (spec Step 16)

`CaptureSession` already emits everything a trigger needs (`sample`, `event`,
`lifecycle`, `probe_lost`). A trigger subscribes, decides, and writes into
`workspace.dir('artifacts')`. See
[SPEC_DEVIATIONS.md §2](./SPEC_DEVIATIONS.md) for which capture artifacts are
achievable against a release APK and which are not.

### Recorded flows and UI automation (spec Steps 17–18)

The event log is already a complete, timestamped record of a successful manual
session. Replay needs a driver that emits the same markers while issuing input;
`AdbDevice` is the natural place for `input tap/swipe` primitives. Nothing in the
analysis layer needs to change — it consumes the marker stream regardless of
whether a human or a script produced it, which is the property that makes
recorded flows and eventual AI exploration comparable to manual runs.

---

## Data contracts

| Concern | Type | Location |
|---|---|---|
| A finding, from any source | `Finding` | `core/types.ts` |
| One memory sample | `MemorySample` | `telemetry/types.ts` |
| An operator or system marker | `TimelineEvent` | `telemetry/types.ts` |
| The report | `AnalysisReport` (zod) | `report/model.ts` |

Telemetry records carry a `schema` field and the report carries
`schemaVersion`, so a build can read runs produced by an older one. The report is
validated before it is written; a schema mismatch fails the run loudly rather
than shipping a malformed report to a studio.

---

## Testing

`tests/fixtures/` builds real artifacts rather than mocks:

- A synthetic Unity project containing one deliberate instance of each problem
  class, plus decoys (a commented-out `Resources.LoadAll`, a well-configured
  texture) that must **not** be reported.
- A real binary `AndroidManifest.xml` built chunk by chunk, so the AXML parser is
  tested against genuine structures — string pool, typed attribute values,
  nested intent filters.
- A real ZIP with a Unity-shaped layout.
- Synthetic telemetry shaped like real sessions: a load spike, a linear leak, and
  three menu→gameplay→menu cycles whose baseline climbs 150 MB each time.

The end-to-end test runs the whole unattended path and asserts the report on disk
validates against the published schema.
