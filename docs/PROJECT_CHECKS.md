# Project Analysis Checks

Every check performed against the **Unity project** — what triggers it, the actual
threshold, and what it does and does not prove.

Scope: this document covers project-side analysis only. It does not cover the APK
inspection or the live device profiling.

Everything here is a **prediction**. Each finding describes a content or code
pattern that commonly causes memory problems, with an estimated size. A prediction
is a hypothesis worth investigating, not an observation — nothing in this phase has
been confirmed on hardware.

Rule ids are stable and appear in `report.json`, so you can filter or suppress by id.

---

## What is excluded before any rule runs

Unity never ships these, so nothing inside them can occupy runtime memory. They are
dropped from the index entirely rather than analysed and then discounted.

| Excluded | Why |
|---|---|
| `Editor/`, `Editor Default Resources/`, `Gizmos/` | Compiled for the Editor only, never in a player build |
| `Generated/`, `*.g.cs`, `*.designer.cs` | Generated code; findings would be noise |
| C# files above 2 MB, scenes above 24 MB | Read cost; counted and reported as a limitation |

Vendored SDK code (`Plugins/`, `ThirdParty/`, `MaxSdk/`, `GoogleMobileAds/`,
`Firebase/`, `AppLovin/`, `IronSource/`, `Photon/` and similar) is **kept and
analysed** — third-party runtime code can genuinely leak — but every finding from it
is labelled *"in vendored SDK code"*, because the fix is usually to update or
reconfigure the SDK rather than to change your own code.

Counts for everything excluded appear in the report's limitations section.

---

## What is indexed

Three indexes are built once and shared by every rule.

| Index | Covers | Extracts |
|---|---|---|
| **Assets** | Everything under `Assets/` | Kind, file size, GUID, image dimensions, import settings, estimated runtime memory |
| **Code** | `.cs` files | Source with comments and string literals blanked, line map, third-party flag |
| **Scenes** | `.unity`, `.prefab` | Object counts, per-Unity-class-id breakdown, referenced GUIDs resolved to assets, Build Settings membership |

Project metadata read from `ProjectSettings/`: Unity version, scripting backend,
Build Settings scene list and enabled flags, and whether Addressables is in
`Packages/manifest.json`.

---

## Textures and images

| Rule | Fires when | Severity |
|---|---|---|
| `UNITY.TEXTURE.OVERSIZED` | Estimated runtime cost exceeds `max(8 MB, 1% of the weakest test device's RAM)`, or 12 MB when no device is known | `critical` above 48 MB · `high` above 24 MB · else `medium` |
| `UNITY.TEXTURE.OVERSIZED_GROUP` | Companion to the above: the 15 largest are listed individually, the remainder rolled into one aggregate finding | `high` above 300 MB total · else `medium` |
| `UNITY.TEXTURE.READ_WRITE_ENABLED` | `isReadable` is set — Unity keeps an uncompressed CPU copy alongside the GPU one | Scales with the extra bytes |
| `UNITY.TEXTURE.UNCOMPRESSED` | `textureCompression` is off on a large texture — 32 bpp instead of 8 or fewer | Scales with the saving available |
| `UNITY.TEXTURE.NO_ANDROID_OVERRIDE` | No Android platform override on 5 or more large textures, so desktop defaults apply to a mobile build | `medium` |

**How the estimate is built:** source dimensions are read straight from the file
header (PNG, JPEG, TGA, BMP, GIF, PSD, TIFF, WebP — no image library), scaled by the
effective `maxTextureSize`, multiplied by bits-per-pixel for the resolved format,
and by 1.33 when mipmaps are on.

**Where it is uncertain:** when the importer is set to Automatic, Unity decides the
real format at build time. The estimate assumes the usual Android outcome
(ASTC 6x6 / ETC2 RGBA8) and **drops confidence to 0.55**. Every estimate carries the
assumption it was made under, in words, in the report.

---

## Audio

| Rule | Fires when |
|---|---|
| `UNITY.AUDIO.DECOMPRESS_ON_LOAD` | `loadType` is Decompress On Load and the file is over 512 KB — expands to raw PCM in RAM, roughly 10x the compressed size |
| `UNITY.AUDIO.PRELOAD` | `preloadAudioData` is set and the file is over 2 MB — loads with the scene whether or not it is ever played |

Load types are read from the `.meta`: `0` Decompress On Load, `1` Compressed In
Memory, `2` Streaming.

---

## Meshes and render targets

| Rule | Fires when |
|---|---|
| `UNITY.MESH.READ_WRITE_ENABLED` | Model has `isReadable` — mesh data stays in CPU memory after upload to the GPU |
| `UNITY.RENDER_TEXTURE.LARGE` | Estimated cost above 8 MB, computed as `width x height x (colour + depth bytes) x MSAA samples x mipmap factor` from the `.renderTexture` asset. `high` above 32 MB |

---

## Scenes

| Rule | Fires when |
|---|---|
| `UNITY.SCENE.HEAVY` | A scene's referenced-asset estimate exceeds 15% of the weakest device's RAM, or 250 MB when no device is known |

This is the **one asset check that is reference-aware**: GUIDs are extracted from
each `.unity` and `.prefab` file and resolved against the asset index, so the figure
reflects what that scene actually pulls in — not every asset on disk.

---

## C# — lifetime and allocation

Regex over source with **comments and string literals blanked out first** (character
positions preserved, so line numbers stay accurate). A commented-out
`Resources.LoadAll`, or a log message mentioning it, never becomes a finding.

| Rule | Fires when | Confidence |
|---|---|---|
| `CODE.ADDRESSABLES_LIFETIME` | `LoadAssetAsync` / `LoadSceneAsync` / `InstantiateAsync` outnumber `Release` / `ReleaseInstance` in a file | 0.9 |
| `CODE.DONT_DESTROY_ON_LOAD` | `DontDestroyOnLoad` with no duplicate-instance guard within 6 lines | 0.7 / 0.5 |
| `CODE.RESOURCES_LOAD_ALL` | `Resources.LoadAll` present — pulls an entire folder into memory at once, used or not | High |
| `CODE.RESOURCES_NO_UNLOAD` | `Resources.Load` used with no `UnloadUnusedAssets` anywhere in the project, so nothing ever releases what was loaded | 0.65 |
| `CODE.INSTANTIATE_HOT_PATH` | `Instantiate` inside `Update` / `FixedUpdate` / `LateUpdate` / `OnGUI` — confirmed by brace-matching the method body, not by proximity | High |
| `CODE.RUNTIME_TEXTURE_MESH` | `new Texture2D` / `new Mesh` / `new RenderTexture`; escalated when the file contains no `Destroy` at all | 0.8 / 0.6 |
| `CODE.TEMP_RENDER_TEXTURE` | `GetTemporary` outnumbers `ReleaseTemporary` in a file | High |
| `CODE.RENDERER_MATERIAL` | `.material` on a renderer, excluding `.sharedMaterial`; escalated when inside a per-frame method | 0.75 |
| `CODE.EVENT_SUBSCRIPTION` | More `+=` handler adds than `-=` removals in a file | Medium |
| `CODE.UNBOUNDED_COLLECTION` | Static `List` / `Dictionary` / `HashSet` with `Add` calls but no `Clear` or `Remove` anywhere in the file | **Deliberately low** — a cache may be bounded elsewhere, and the wording asks you to verify |

---

## Related: the per-app memory budget

Live analysis grades a device's measured peak against how much memory one app may
reasonably use on hardware that size. That table lives with the live checks, not
here, but it is worth knowing it exists: a static estimate of 800 MB of textures
reads very differently on a 2 GB device (past the practical limit) than on an
8 GB one (inside target).

| Device RAM | Common industry target | Hard practical limit |
|---|---|---|
| 1 GB (Android Go) | 150–250 MB | ~350 MB |
| 2 GB | 300–450 MB | ~600 MB |
| 3 GB | 450–600 MB | ~900 MB |
| 4 GB | 600–800 MB | ~1.2 GB |
| 6 GB | 900 MB–1.2 GB | ~1.8 GB |
| 8 GB or more | 1.2–1.5 GB | ~2.5 GB |

Devices are matched on measured `MemTotal`, which is always below the marketed
RAM — a "4 GB" phone reports about 3.7 GB.

---

## Known limits

Stated plainly, because a check that looks stronger than it is misleads more than a
missing one.

### Usage is not verified for most asset checks

`UNITY.SCENE.HEAVY` is reference-aware. **The per-texture and per-audio rules are
not** — they flag by size regardless of whether anything references the asset.

Unity only ships an asset that is transitively referenced by an enabled Build
Settings scene, or sits in `Resources/`, `StreamingAssets/`, or an Addressables
group. An unreferenced texture is **not in the build at all**, so reporting its
runtime cost overstates the risk. Three consequences:

- Totals across all assets include orphaned art, which inflates them
- The reference graph is **one level deep** — only `.unity` and `.prefab` are
  GUID-scanned, so the common scene to material to texture chain is invisible
- `Resources/`, `StreamingAssets/` and Addressables **group membership** are not
  detected; there is only a project-wide "uses Addressables" boolean

### Third-party code is labelled, not weighted

Vendored findings are marked, but the label does not yet change severity, confidence
or ranking, and vendored hits are merged into the same finding as first-party ones.
A vendored SDK ships many code paths a given game never calls, so these should rank
below first-party findings.

### Every size figure is an estimate

Runtime memory depends on the format Unity picks at build time. Where the importer
is Automatic the estimate assumes the usual Android outcome and says so, with
reduced confidence. Import settings also come from `.meta` files — if those are
missing from the repository, the count of unreadable ones is reported and those
assets are analysed on file size alone.

### Code analysis is lexical

Regex over blanked source, not a compiler. It cannot see reflection, `SendMessage`,
inspector-wired references, or string-keyed loads. Rules that are inherently
uncertain carry low confidence and wording that asks you to verify, rather than
being dropped or overstated.

### Findings are per-file, not per-pattern

A pattern duplicated across several copies of a file is reported as separate
occurrences rather than recognised as one duplicated source. Six copies of the same
paint-canvas script read as six findings, when the actionable fact is that there is
one pattern in six places.
