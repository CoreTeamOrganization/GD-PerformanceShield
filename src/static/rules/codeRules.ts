/**
 * Static rules 4-10 and 12 from Step 8 - the C# rules.
 *
 * Each rule reports the specific lines it matched so a studio engineer can go
 * straight to the code. Confidence reflects how certain the pattern is: some of
 * these (Resources.LoadAll, temporary RenderTexture) are near-unambiguous,
 * while others (unbounded collections) legitimately flag code that may be fine,
 * and are scored accordingly.
 */
import { findingId } from '../../core/ids.js';
import type { Evidence, Finding, Severity } from '../../core/types.js';
import {
  findMethodBodies,
  positionOf,
  scanCode,
  type CodeIndex,
  type CodeMatch,
} from '../codeIndex.js';
import type { StaticRule, StaticRuleContext } from '../ruleEngine.js';

/** Turn code matches into report evidence, capped for readability. */
function evidenceFrom(matches: CodeMatch[], limit = 20): Evidence[] {
  return matches.slice(0, limit).map((m) => ({
    kind: 'code' as const,
    // The path is carried in `path`; the summary adds only what the path does
    // not already say, so the report does not print it twice.
    summary: m.file.thirdParty ? 'in vendored SDK code' : `line ${m.line}`,
    path: m.file.relPath,
    line: m.line,
    excerpt: m.excerpt,
  }));
}

/**
 * A note for findings whose evidence is mostly vendored SDK code, which a studio
 * usually cannot edit. Worth knowing before it is treated as an action item.
 */
function thirdPartyNote(matches: CodeMatch[]): string {
  const vendored = matches.filter((m) => m.file.thirdParty).length;
  if (vendored === 0) return '';
  if (vendored === matches.length) {
    return ' Every occurrence is inside a vendored SDK, so the fix is to update or configure that SDK rather than to change your own code.';
  }
  return ` ${vendored} of ${matches.length} occurrences are inside vendored SDKs.`;
}

function distinctFiles(matches: CodeMatch[]): number {
  return new Set(matches.map((m) => m.file.relPath)).size;
}

/** Rule 4 - `renderer.material` allocates a per-instance material clone. */
export const rendererMaterialRule: StaticRule = {
  id: 'CODE.RENDERER_MATERIAL',
  title: 'renderer.material creates material instances',
  category: 'code',
  rationale:
    'Reading `renderer.material` (rather than `sharedMaterial`) clones the material the first time it is ' +
    'touched, and the clone is owned by that renderer until it is destroyed. In a loop or on many ' +
    'objects this quietly multiplies material and texture references, and the clones are never returned ' +
    'to the shared pool.',
  run(ctx: StaticRuleContext): Finding[] {
    // `.material` / `.materials` read or assigned, excluding sharedMaterial.
    const matches = scanCode(
      ctx.code,
      /\b(?:\w+(?:Renderer|renderer|rend|mr|sr))\s*\.\s*(?:material|materials)\b(?!\s*=\s*null)/g,
      300,
    ).filter((m) => !/sharedMaterial/.test(m.excerpt));

    if (matches.length === 0) return [];

    const inUpdate = matches.filter((m) => isInsideHotMethod(m));
    const severity: Severity = inUpdate.length > 0 ? 'high' : matches.length > 20 ? 'medium' : 'low';

    return [
      {
        ruleId: 'CODE.RENDERER_MATERIAL',
        id: findingId('CODE.RENDERER_MATERIAL', 'all'),
        source: 'static',
        title: `${matches.length} use(s) of renderer.material across ${distinctFiles(matches)} file(s)`,
        description:
          'Accessing `.material` clones the material for that renderer. Each clone is a separate object ' +
          'holding its own property block and texture references, and it lives until the renderer is ' +
          'destroyed.' +
          (inUpdate.length > 0
            ? ` ${inUpdate.length} of these occur inside Update/FixedUpdate/LateUpdate, where a clone may be created every frame.`
            : ''),
        severity,
        confidence: 0.75,
        recommendation:
          'Use `sharedMaterial` when you only need to read properties. When you must vary appearance ' +
          'per object, use a MaterialPropertyBlock, which changes rendering without allocating a ' +
          'material instance.',
        evidence: evidenceFrom(inUpdate.length > 0 ? inUpdate : matches),
        subject: 'material instancing',
        tags: ['code', 'material', 'allocation'],
      },
    ];
  },
};

/** Rule 5 - DontDestroyOnLoad objects survive every scene change. */
export const dontDestroyOnLoadRule: StaticRule = {
  id: 'CODE.DONT_DESTROY_ON_LOAD',
  title: 'DontDestroyOnLoad retention',
  category: 'code',
  rationale:
    'A DontDestroyOnLoad object and everything it references survives every scene load. This is the ' +
    'single most common way a game accumulates memory across a menu-gameplay-menu loop, because the ' +
    'persistent root keeps references to content from every level that has been played.',
  run(ctx: StaticRuleContext): Finding[] {
    const matches = scanCode(ctx.code, /\bDontDestroyOnLoad\s*\(/g, 200);
    if (matches.length === 0) return [];

    // A guarded singleton (checks for an existing instance) is the correct
    // pattern; an unguarded one creates a new persistent object per scene load.
    const unguarded = matches.filter((m) => !hasSingletonGuard(m));

    return [
      {
        ruleId: 'CODE.DONT_DESTROY_ON_LOAD',
        id: findingId('CODE.DONT_DESTROY_ON_LOAD', 'all'),
        source: 'static',
        title: `${matches.length} DontDestroyOnLoad call(s) across ${distinctFiles(matches)} file(s)`,
        description:
          'Objects marked DontDestroyOnLoad persist across every scene load, along with everything they ' +
          'reference.' +
          (unguarded.length > 0
            ? ` ${unguarded.length} of these calls have no visible duplicate-instance guard nearby, so a ` +
              'new persistent object may be created each time the scene containing them is loaded.'
            : ' Each call appears to sit near a duplicate-instance guard, which is the correct pattern.'),
        severity: unguarded.length > 0 ? 'high' : 'medium',
        confidence: unguarded.length > 0 ? 0.7 : 0.5,
        recommendation:
          'For each persistent object, confirm it is a true singleton (destroy the duplicate when an ' +
          'instance already exists) and audit what it holds references to. Clear cached level data, ' +
          'sprites and pooled objects when leaving gameplay rather than keeping them for the next round.',
        evidence: evidenceFrom(unguarded.length > 0 ? unguarded : matches),
        subject: 'persistent objects',
        tags: ['code', 'retention', 'scene'],
      },
    ];
  },
};

/**
 * Rule 6 - collections that only ever grow.
 *
 * Intentionally conservative: we report a field-level collection that has Add
 * calls but no Clear/Remove/RemoveAt anywhere in the same file. That still
 * produces false positives (a cache may be bounded elsewhere), so confidence is
 * held low and the wording asks the reader to verify.
 */
export const unboundedCollectionRule: StaticRule = {
  id: 'CODE.UNBOUNDED_COLLECTION',
  title: 'Collections that only grow',
  category: 'code',
  rationale:
    'A static or long-lived List/Dictionary that is only ever added to will grow for the entire session. ' +
    'This is the classic cause of a baseline that climbs with every repeat of a gameplay loop.',
  run(ctx: StaticRuleContext): Finding[] {
    const suspects: CodeMatch[] = [];

    for (const file of ctx.code.files) {
      // Fields that are static or readonly collections - the ones that outlive
      // a single scene.
      const declRe =
        /\b(?:public|private|protected|internal)?\s*static\s+(?:readonly\s+)?(?:List|Dictionary|HashSet|Queue|Stack)\s*<[^>]*>\s+(?<name>\w+)/g;
      let m: RegExpExecArray | null;
      while ((m = declRe.exec(file.code)) !== null) {
        const name = m.groups?.['name'];
        if (!name) continue;

        const addRe = new RegExp(String.raw`\b${name}\s*\.\s*(?:Add|Enqueue|Push|TryAdd)\s*\(`, 'g');
        const removeCallRe = new RegExp(
          String.raw`\b${name}\s*\.\s*(?:Clear|Remove|RemoveAt|RemoveAll|Dequeue|Pop|TrimExcess)\s*\(`,
          'g',
        );
        const reassignRe = new RegExp(String.raw`\b${name}\s*=\s*(?:new|null)`, 'g');

        const adds = (file.code.match(addRe) ?? []).length;
        if (adds === 0) continue;

        // The declaration's own initializer (`static List<T> x = new List<T>()`)
        // is textually a reassignment but says nothing about the collection's
        // lifetime, so it must not count as evidence that it is bounded.
        const declarationInitializes = /=\s*new\b/.test(
          file.code.slice(m.index, m.index + m[0].length + 40),
        );
        const reassignments = Math.max(
          0,
          (file.code.match(reassignRe) ?? []).length - (declarationInitializes ? 1 : 0),
        );
        const removes = (file.code.match(removeCallRe) ?? []).length + reassignments;
        if (removes > 0) continue;

        const { line } = positionOf(file.code, m.index);
        suspects.push({
          file,
          line,
          column: 0,
          text: m[0],
          excerpt: (file.lines[line - 1] ?? '').trim().slice(0, 240),
          groups: { name, adds: String(adds) },
        });
      }
    }

    if (suspects.length === 0) return [];

    return [
      {
        ruleId: 'CODE.UNBOUNDED_COLLECTION',
        id: findingId('CODE.UNBOUNDED_COLLECTION', 'all'),
        source: 'static',
        title: `${suspects.length} static collection(s) are added to but never cleared`,
        description:
          'These static collections have Add-style calls but no Clear, Remove or reassignment anywhere ' +
          'in the same file. If nothing outside the file bounds them, they grow for the whole session. ' +
          'Worth verifying individually - a cache bounded elsewhere would look the same to this check.',
        severity: 'medium',
        confidence: 0.5,
        recommendation:
          'Give each collection an explicit lifetime: clear it when leaving the state that populated it, ' +
          'or bound it (LRU or fixed capacity). Static collections holding GameObjects, Textures or ' +
          'Sprites also keep those assets alive.',
        evidence: suspects.slice(0, 20).map((s) => ({
          kind: 'code' as const,
          summary: `${s.file.relPath}:${s.line} - "${s.groups?.['name']}" has ${s.groups?.['adds']} add(s), no removal`,
          path: s.file.relPath,
          line: s.line,
          excerpt: s.excerpt,
        })),
        subject: 'unbounded collections',
        tags: ['code', 'leak', 'collection'],
      },
    ];
  },
};

/** Rule 7 - Resources.LoadAll loads an entire folder at once. */
export const resourcesLoadAllRule: StaticRule = {
  id: 'CODE.RESOURCES_LOAD_ALL',
  title: 'Resources.LoadAll and Resources folder usage',
  category: 'code',
  rationale:
    'Resources.LoadAll loads every asset in a folder into memory at once, whether or not it is used. ' +
    'Worse, everything in a Resources folder is included in the build and its serialized index is built ' +
    'at startup, so Resources usage inflates both the launch cost and the resident set.',
  run(ctx: StaticRuleContext): Finding[] {
    const loadAll = scanCode(ctx.code, /\bResources\s*\.\s*LoadAll\s*(?:<[^>]*>)?\s*\(/g, 200);
    const load = scanCode(ctx.code, /\bResources\s*\.\s*Load\s*(?:<[^>]*>)?\s*\(/g, 300);
    const unload = scanCode(ctx.code, /\bResources\s*\.\s*UnloadUnusedAssets\s*\(/g, 100);

    const findings: Finding[] = [];

    if (loadAll.length > 0) {
      findings.push({
        ruleId: 'CODE.RESOURCES_LOAD_ALL',
        id: findingId('CODE.RESOURCES_LOAD_ALL', 'loadall'),
        source: 'static',
        title: `${loadAll.length} call(s) to Resources.LoadAll`,
        description:
          'Resources.LoadAll pulls every asset in the target folder into memory simultaneously, ' +
          'regardless of whether the game needs them. The loaded objects stay resident until explicitly ' +
          'unloaded.',
        severity: 'high',
        confidence: 0.9,
        recommendation:
          'Load individual assets on demand, or move the content to Addressables so each item has an ' +
          'explicit load and release. If an index of available items is needed, build a lightweight ' +
          'manifest instead of loading the assets themselves.',
        evidence: evidenceFrom(loadAll),
        subject: 'Resources.LoadAll',
        tags: ['code', 'resources', 'load'],
      });
    }

    if (load.length > 20 && unload.length === 0) {
      findings.push({
        ruleId: 'CODE.RESOURCES_NO_UNLOAD',
        id: findingId('CODE.RESOURCES_NO_UNLOAD', 'nounload'),
        source: 'static',
        title: `${load.length} Resources.Load call(s) with no UnloadUnusedAssets anywhere`,
        description:
          'Assets loaded through Resources.Load remain in memory after the references to them are gone; ' +
          'they are only released by Resources.UnloadUnusedAssets. No call to it was found in the project.',
        severity: 'medium',
        confidence: 0.65,
        recommendation:
          'Call Resources.UnloadUnusedAssets after major state transitions (for example when returning ' +
          'to the menu), or migrate to Addressables where release is explicit and per-handle.',
        evidence: evidenceFrom(load, 15),
        subject: 'Resources lifetime',
        tags: ['code', 'resources', 'lifetime'],
      });
    }

    return findings;
  },
};

/** Rule 8 - Addressables handles that are never released. */
export const addressablesLifetimeRule: StaticRule = {
  id: 'CODE.ADDRESSABLES_LIFETIME',
  title: 'Addressables loaded without a matching release',
  category: 'code',
  rationale:
    'Addressables is reference counted. An asset loaded with LoadAssetAsync stays in memory until the ' +
    'handle is released, and instances created with InstantiateAsync must be released with ' +
    'ReleaseInstance. Missing releases are the most common source of retention in Addressables projects.',
  run(ctx: StaticRuleContext): Finding[] {
    const loads = scanCode(
      ctx.code,
      /\bAddressables\s*\.\s*(?:LoadAssetAsync|LoadAssetsAsync|LoadSceneAsync|InstantiateAsync)\s*(?:<[^>]*>)?\s*\(/g,
      300,
    );
    if (loads.length === 0) return [];

    const releases = scanCode(
      ctx.code,
      /\bAddressables\s*\.\s*(?:Release|ReleaseInstance)\s*\(/g,
      300,
    );

    // Per-file balance is a better signal than a project-wide count: a manager
    // class that loads 20 assets and releases none is the real problem case.
    const byFile = new Map<string, { loads: number; releases: number; first: CodeMatch }>();
    for (const m of loads) {
      const entry = byFile.get(m.file.relPath) ?? { loads: 0, releases: 0, first: m };
      entry.loads++;
      byFile.set(m.file.relPath, entry);
    }
    for (const m of releases) {
      const entry = byFile.get(m.file.relPath);
      if (entry) entry.releases++;
    }

    const unbalanced = [...byFile.entries()].filter(([, v]) => v.releases === 0);
    if (unbalanced.length === 0 && releases.length >= loads.length / 2) return [];

    const severity: Severity =
      releases.length === 0 ? 'critical' : unbalanced.length > 3 ? 'high' : 'medium';

    return [
      {
        ruleId: 'CODE.ADDRESSABLES_LIFETIME',
        id: findingId('CODE.ADDRESSABLES_LIFETIME', 'all'),
        source: 'static',
        title:
          releases.length === 0
            ? `${loads.length} Addressables load call(s) and no Release calls anywhere in the project`
            : `${unbalanced.length} file(s) load Addressables without releasing them`,
        description:
          `The project makes ${loads.length} Addressables load call(s) and ${releases.length} release ` +
          'call(s). Every loaded handle holds a reference count on the asset and its bundle; until it is ' +
          'released, neither can be unloaded. This is the mechanism behind memory that never comes back ' +
          'after visiting a screen.',
        severity,
        confidence: releases.length === 0 ? 0.9 : 0.7,
        recommendation:
          'Pair every LoadAssetAsync with Addressables.Release and every InstantiateAsync with ' +
          'ReleaseInstance, tied to the lifetime of the screen or state that requested it (release in ' +
          'OnDestroy or when closing the screen). Keep the handles in a per-screen list so nothing is missed.',
        evidence: unbalanced.slice(0, 20).map(([path, v]) => ({
          kind: 'code' as const,
          summary: `${path} - ${v.loads} load(s), 0 release(s)`,
          path,
          line: v.first.line,
          excerpt: v.first.excerpt,
        })),
        subject: 'addressables lifetime',
        tags: ['code', 'addressables', 'retention'],
      },
    ];
  },
};

/** Rule 9 - Instantiate called on a per-frame path. */
export const frequentInstantiateRule: StaticRule = {
  id: 'CODE.INSTANTIATE_HOT_PATH',
  title: 'Instantiate on a per-frame code path',
  category: 'code',
  rationale:
    'Instantiate in Update or a similar per-frame method allocates a new object graph every frame. Even ' +
    'when the objects are destroyed later, the allocation rate drives heap growth and fragmentation, and ' +
    'any object that outlives its frame accumulates.',
  run(ctx: StaticRuleContext): Finding[] {
    const matches: CodeMatch[] = [];

    for (const file of ctx.code.files) {
      const hotMethods = findMethodBodies(file, ['Update', 'FixedUpdate', 'LateUpdate', 'OnGUI']);
      if (hotMethods.length === 0) continue;

      const re = /\b(?:GameObject\s*\.\s*)?Instantiate\s*(?:<[^>]*>)?\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(file.code)) !== null) {
        const method = hotMethods.find((h) => m!.index > h.start && m!.index < h.end);
        if (!method) continue;
        const { line } = positionOf(file.code, m.index);
        matches.push({
          file,
          line,
          column: 0,
          text: m[0],
          excerpt: (file.lines[line - 1] ?? '').trim().slice(0, 240),
          groups: { method: method.name },
        });
      }
    }

    if (matches.length === 0) return [];

    return [
      {
        ruleId: 'CODE.INSTANTIATE_HOT_PATH',
        id: findingId('CODE.INSTANTIATE_HOT_PATH', 'all'),
        source: 'static',
        title: `${matches.length} Instantiate call(s) inside per-frame methods`,
        description:
          'Instantiate is called from Update, FixedUpdate, LateUpdate or OnGUI. These run every frame, ' +
          'so unless the call is behind a strict condition it allocates continuously. Sustained ' +
          'allocation is visible at runtime as a steadily rising baseline.',
        severity: 'high',
        confidence: 0.7,
        recommendation:
          'Pool the objects: create a fixed set at load time, deactivate rather than destroy, and reuse. ' +
          'If instantiation is genuinely event-driven, move it to the event handler instead of polling ' +
          'for the condition every frame.',
        evidence: matches.slice(0, 20).map((m) => ({
          kind: 'code' as const,
          summary: `${m.file.relPath}:${m.line} - inside ${m.groups?.['method']}()`,
          path: m.file.relPath,
          line: m.line,
          excerpt: m.excerpt,
        })),
        subject: 'instantiation rate',
        tags: ['code', 'allocation', 'pooling'],
      },
    ];
  },
};

/** Rule 10 - Texture2D / Mesh created at runtime. */
export const runtimeAllocationRule: StaticRule = {
  id: 'CODE.RUNTIME_TEXTURE_MESH',
  title: 'Textures and meshes created at runtime',
  category: 'code',
  rationale:
    'Objects created with `new Texture2D(...)` or `new Mesh()` are not managed by Unity asset lifetime ' +
    'rules. They are never unloaded by scene changes or UnloadUnusedAssets, and leak unless the code ' +
    'explicitly calls Destroy on them.',
  run(ctx: StaticRuleContext): Finding[] {
    const textures = scanCode(ctx.code, /\bnew\s+Texture2D\s*\(/g, 200);
    const meshes = scanCode(ctx.code, /\bnew\s+Mesh\s*\(\s*\)/g, 200);
    const renderTextures = scanCode(ctx.code, /\bnew\s+RenderTexture\s*\(/g, 200);
    const all = [...textures, ...meshes, ...renderTextures];
    if (all.length === 0) return [];

    const destroys = scanCode(
      ctx.code,
      /\b(?:Object\s*\.\s*)?(?:Destroy|DestroyImmediate)\s*\(/g,
      400,
    );

    // Only flag files that create these objects and never destroy anything.
    const creatingFiles = new Set(all.map((m) => m.file.relPath));
    const destroyingFiles = new Set(destroys.map((m) => m.file.relPath));
    const risky = all.filter((m) => !destroyingFiles.has(m.file.relPath));

    return [
      {
        ruleId: 'CODE.RUNTIME_TEXTURE_MESH',
        id: findingId('CODE.RUNTIME_TEXTURE_MESH', 'all'),
        source: 'static',
        title: `${all.length} runtime Texture2D/Mesh/RenderTexture allocation(s) across ${creatingFiles.size} file(s)`,
        description:
          'Objects created with `new Texture2D`, `new Mesh` or `new RenderTexture` are unmanaged: nothing ' +
          'unloads them automatically.' +
          (risky.length > 0
            ? ` ${risky.length} of these are in files that contain no Destroy call at all, so the created objects are very likely leaked.`
            : '') +
          thirdPartyNote(all),
        severity: risky.length > 0 ? 'high' : 'medium',
        confidence: risky.length > 0 ? 0.8 : 0.6,
        recommendation:
          'Destroy every runtime-created texture and mesh when it is no longer needed, and prefer ' +
          'RenderTexture.GetTemporary/ReleaseTemporary for short-lived render targets so the engine can ' +
          'reuse the allocation.',
        evidence: evidenceFrom(risky.length > 0 ? risky : all),
        subject: 'runtime allocations',
        tags: ['code', 'allocation', 'leak'],
      },
    ];
  },
};

/** Rule 12 - temporary RenderTextures obtained but never released. */
export const temporaryRenderTextureRule: StaticRule = {
  id: 'CODE.TEMP_RENDER_TEXTURE',
  title: 'Temporary RenderTextures not released',
  category: 'code',
  rationale:
    'RenderTexture.GetTemporary allocates from a pool that is only returned to by ReleaseTemporary. An ' +
    'unbalanced Get keeps a full-resolution render target alive for the rest of the session, and repeated ' +
    'calls allocate a new one each time.',
  run(ctx: StaticRuleContext): Finding[] {
    const gets = scanCode(ctx.code, /\bRenderTexture\s*\.\s*GetTemporary\s*\(/g, 200);
    if (gets.length === 0) return [];

    const releases = scanCode(ctx.code, /\bRenderTexture\s*\.\s*ReleaseTemporary\s*\(/g, 200);

    const byFile = new Map<string, { gets: number; releases: number; first: CodeMatch }>();
    for (const m of gets) {
      const entry = byFile.get(m.file.relPath) ?? { gets: 0, releases: 0, first: m };
      entry.gets++;
      byFile.set(m.file.relPath, entry);
    }
    for (const m of releases) {
      const entry = byFile.get(m.file.relPath);
      if (entry) entry.releases++;
    }

    const unbalanced = [...byFile.entries()].filter(([, v]) => v.releases < v.gets);
    if (unbalanced.length === 0) return [];

    return [
      {
        ruleId: 'CODE.TEMP_RENDER_TEXTURE',
        id: findingId('CODE.TEMP_RENDER_TEXTURE', 'all'),
        source: 'static',
        title: `${unbalanced.length} file(s) call GetTemporary more often than ReleaseTemporary`,
        description:
          `The project makes ${gets.length} GetTemporary call(s) against ${releases.length} ` +
          'ReleaseTemporary call(s). Every unreleased temporary render target stays allocated at full ' +
          'resolution.',
        severity: releases.length === 0 ? 'high' : 'medium',
        confidence: 0.8,
        recommendation:
          'Release every temporary render target in the same method that acquired it, using try/finally ' +
          'so an early return or exception cannot skip the release.',
        evidence: unbalanced.slice(0, 20).map(([path, v]) => ({
          kind: 'code' as const,
          summary: `${path} - ${v.gets} GetTemporary, ${v.releases} ReleaseTemporary`,
          path,
          line: v.first.line,
          excerpt: v.first.excerpt,
        })),
        subject: 'temporary render textures',
        tags: ['code', 'rendertexture', 'leak'],
      },
    ];
  },
};

/** Event subscriptions never unsubscribed - a very common retention cause. */
export const eventSubscriptionRule: StaticRule = {
  id: 'CODE.EVENT_SUBSCRIPTION',
  title: 'Event subscriptions without unsubscription',
  category: 'code',
  rationale:
    'A subscription to a static or long-lived event keeps the subscriber alive. When the subscriber is a ' +
    'MonoBehaviour on a destroyed object, the object graph it references stays in memory for the rest of ' +
    'the session.',
  run(ctx: StaticRuleContext): Finding[] {
    const suspects: CodeMatch[] = [];

    for (const file of ctx.code.files) {
      const subs = (file.code.match(/\+=\s*(?:this\s*\.\s*)?\w+\s*;/g) ?? []).length;
      const unsubs = (file.code.match(/-=\s*(?:this\s*\.\s*)?\w+\s*;/g) ?? []).length;
      if (subs === 0 || unsubs >= subs) continue;

      const m = /\+=\s*(?:this\s*\.\s*)?\w+\s*;/.exec(file.code);
      if (!m) continue;
      const { line } = positionOf(file.code, m.index);
      suspects.push({
        file,
        line,
        column: 0,
        text: m[0],
        excerpt: (file.lines[line - 1] ?? '').trim().slice(0, 240),
        groups: { subs: String(subs), unsubs: String(unsubs) },
      });
    }

    if (suspects.length < 3) return [];

    return [
      {
        ruleId: 'CODE.EVENT_SUBSCRIPTION',
        id: findingId('CODE.EVENT_SUBSCRIPTION', 'all'),
        source: 'static',
        title: `${suspects.length} file(s) subscribe to events more often than they unsubscribe`,
        description:
          'These files contain more `+=` handler registrations than `-=` removals. Handlers registered ' +
          'on static or manager-owned events keep the subscribing object - and everything it references - ' +
          'alive after it should have been collected.',
        severity: 'medium',
        confidence: 0.5,
        recommendation:
          'Unsubscribe in OnDisable or OnDestroy for every subscription made in OnEnable or Start. ' +
          'Matching the pairs symmetrically makes the imbalance easy to spot in review.',
        evidence: suspects.slice(0, 20).map((s) => ({
          kind: 'code' as const,
          summary: `${s.file.relPath} - ${s.groups?.['subs']} subscription(s), ${s.groups?.['unsubs']} removal(s)`,
          path: s.file.relPath,
          line: s.line,
          excerpt: s.excerpt,
        })),
        subject: 'event subscriptions',
        tags: ['code', 'retention', 'events'],
      },
    ];
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOT_METHOD_CACHE = new WeakMap<object, Array<{ start: number; end: number; name: string }>>();

function isInsideHotMethod(match: CodeMatch): boolean {
  let bodies = HOT_METHOD_CACHE.get(match.file);
  if (!bodies) {
    bodies = findMethodBodies(match.file, ['Update', 'FixedUpdate', 'LateUpdate', 'OnGUI']);
    HOT_METHOD_CACHE.set(match.file, bodies);
  }
  // Recover the character offset from the line number.
  const offset = offsetOfLine(match.file.code, match.line);
  return bodies.some((b) => offset > b.start && offset < b.end);
}

function offsetOfLine(text: string, line: number): number {
  let current = 1;
  for (let i = 0; i < text.length; i++) {
    if (current === line) return i;
    if (text[i] === '\n') current++;
  }
  return text.length;
}

/**
 * Look for a duplicate-instance guard within a few lines of the
 * DontDestroyOnLoad call - the standard singleton shape.
 */
function hasSingletonGuard(match: CodeMatch): boolean {
  const from = Math.max(0, match.line - 12);
  const window = match.file.lines.slice(from, match.line + 4).join('\n');
  return /\b(?:Instance|instance|_instance)\s*(?:!=|==)\s*null/.test(window) ||
    /\bDestroy\s*\(\s*(?:gameObject|this\.gameObject|this)\s*\)/.test(window);
}

export const CODE_RULES: StaticRule[] = [
  rendererMaterialRule,
  dontDestroyOnLoadRule,
  unboundedCollectionRule,
  resourcesLoadAllRule,
  addressablesLifetimeRule,
  frequentInstantiateRule,
  runtimeAllocationRule,
  temporaryRenderTextureRule,
  eventSubscriptionRule,
];
