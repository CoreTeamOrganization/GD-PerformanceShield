/**
 * Build- and project-level rules.
 *
 * These come from ProjectSettings and the APK rather than from assets or code,
 * and they often explain why a game with reasonable content still runs out of
 * address space - a 32-bit build being the clearest example.
 */
import { findingId } from '../../core/ids.js';
import { MB, type Finding } from '../../core/types.js';
import type { StaticRule, StaticRuleContext } from '../ruleEngine.js';

export const architectureRule: StaticRule = {
  id: 'BUILD.32BIT_ONLY',
  title: '32-bit build architecture',
  category: 'build',
  rationale:
    'A 32-bit process is limited to roughly 3-4 GB of address space, and in practice fragmentation makes ' +
    'allocation failures start well below that. The same content that is comfortable in a 64-bit build ' +
    'can be fatal in a 32-bit one.',
  run(ctx: StaticRuleContext): Finding[] {
    const apk = ctx.apk;
    if (!apk || apk.abis.length === 0) return [];
    if (apk.abis.includes('arm64-v8a')) return [];

    return [
      {
        ruleId: 'BUILD.32BIT_ONLY',
        id: findingId('BUILD.32BIT_ONLY', apk.packageName ?? 'apk'),
        source: 'static',
        title: 'The APK ships no 64-bit native library',
        description:
          `The APK contains native libraries for ${apk.abis.join(', ')} but not arm64-v8a, so the game ` +
          'runs as a 32-bit process. Address space is capped near 3-4 GB and, because of fragmentation, ' +
          'large contiguous allocations begin failing well before that ceiling.',
        severity: 'high',
        confidence: 0.95,
        recommendation:
          'Enable ARM64 under Player Settings > Other Settings > Target Architectures with the IL2CPP ' +
          'scripting backend. This is also a Google Play requirement for new releases.',
        evidence: [
          {
            kind: 'setting',
            summary: `ABIs present in the APK: ${apk.abis.join(', ')}`,
            data: { abis: apk.abis, scriptingBackend: apk.unity.scriptingBackend },
          },
        ],
        subject: 'build architecture',
        tags: ['build', 'architecture'],
      },
    ];
  },
};

export const largeHeapRule: StaticRule = {
  id: 'BUILD.LARGE_HEAP',
  title: 'android:largeHeap usage',
  category: 'build',
  rationale:
    'largeHeap raises the Java heap ceiling but does nothing for native or graphics memory, which is ' +
    'where a Unity game spends most of its budget. It is frequently enabled as a workaround for a leak ' +
    'rather than as a considered decision, and it increases the chance the OS kills the app under pressure.',
  run(ctx: StaticRuleContext): Finding[] {
    if (!ctx.apk?.largeHeap) return [];

    return [
      {
        ruleId: 'BUILD.LARGE_HEAP',
        id: findingId('BUILD.LARGE_HEAP', ctx.apk.packageName ?? 'apk'),
        source: 'static',
        title: 'The app requests android:largeHeap',
        description:
          'largeHeap is enabled in the manifest. It raises the Java/Dalvik heap limit only - Unity ' +
          'content lives mostly in native and graphics memory, which largeHeap does not affect. A larger ' +
          'requested heap also makes the app a more attractive target for the low-memory killer.',
        severity: 'low',
        confidence: 0.9,
        recommendation:
          'Confirm this is a deliberate choice with a measured Java-heap reason behind it. If it was ' +
          'added to stop OOM crashes, the underlying growth is still present and should be fixed instead.',
        evidence: [
          { kind: 'setting', summary: 'android:largeHeap="true" in AndroidManifest.xml' },
        ],
        subject: 'manifest',
        tags: ['build', 'manifest'],
      },
    ];
  },
};

export const monoBackendRule: StaticRule = {
  id: 'BUILD.MONO_BACKEND',
  title: 'Mono scripting backend on Android',
  category: 'build',
  rationale:
    'The Mono backend cannot produce 64-bit Android builds and has a less predictable memory profile ' +
    'than IL2CPP. IL2CPP is the supported configuration for shipping Android titles.',
  run(ctx: StaticRuleContext): Finding[] {
    const backend = ctx.apk?.unity.scriptingBackend ?? ctx.project.scriptingBackend;
    if (backend !== 'Mono') return [];

    return [
      {
        ruleId: 'BUILD.MONO_BACKEND',
        id: findingId('BUILD.MONO_BACKEND', 'backend'),
        source: 'static',
        title: 'The build uses the Mono scripting backend',
        description:
          'Mono is in use rather than IL2CPP. Mono builds are 32-bit only on Android and carry a larger, ' +
          'less predictable managed-memory overhead.',
        severity: 'medium',
        confidence: 0.85,
        recommendation:
          'Switch to IL2CPP and enable ARM64. Expect longer build times, but a smaller and far more ' +
          'predictable runtime footprint.',
        evidence: [{ kind: 'setting', summary: `Scripting backend: ${backend}` }],
        subject: 'scripting backend',
        tags: ['build', 'backend'],
      },
    ];
  },
};

/**
 * Total estimated content vs the weakest device. This is the headline number a
 * studio wants: does the content, as imported, even fit?
 */
export const contentBudgetRule: StaticRule = {
  id: 'BUILD.CONTENT_BUDGET',
  title: 'Total estimated asset memory against the device budget',
  category: 'build',
  rationale:
    'A game cannot use all of a device RAM figure: the OS, the engine and other apps take a large share. ' +
    'A practical working assumption is that a game should stay under about half of total device RAM.',
  run(ctx: StaticRuleContext): Finding[] {
    const totals = ctx.assets.totals;
    const estimated = totals.estimatedTextureBytes + totals.estimatedAudioBytes;
    if (estimated === 0) return [];

    const weakest = ctx.devices?.length
      ? Math.min(...ctx.devices.map((d) => d.totalRamBytes).filter((r) => r > 0))
      : null;

    // Not everything is resident at once, so compare against the whole-project
    // total only as an upper bound, and say so plainly.
    if (!weakest) {
      return [
        {
          ruleId: 'BUILD.CONTENT_BUDGET',
          id: findingId('BUILD.CONTENT_BUDGET', 'total'),
          source: 'static',
          title: `Project textures and audio total about ${fmt(estimated)} if everything were resident`,
          description:
            `The imported content in this project would cost roughly ${fmt(estimated)} if all of it were ` +
            'loaded at once. This is an upper bound, not a prediction - only a live session shows what is ' +
            'actually resident together.',
          severity: 'info',
          confidence: 0.5,
          recommendation:
            'Use this as a budget context number. The per-scene and live figures elsewhere in this report ' +
            'are the actionable ones.',
          evidence: [
            {
              kind: 'metric',
              summary: `Textures ${fmt(totals.estimatedTextureBytes)}, audio ${fmt(totals.estimatedAudioBytes)}`,
              data: totals,
            },
          ],
          estimatedBytes: estimated,
          subject: 'content budget',
          tags: ['build', 'budget'],
        },
      ];
    }

    const budget = weakest * 0.5;
    const ratio = estimated / budget;
    if (ratio < 1) return [];

    return [
      {
        ruleId: 'BUILD.CONTENT_BUDGET',
        id: findingId('BUILD.CONTENT_BUDGET', 'total'),
        source: 'static',
        title: `Imported content totals about ${fmt(estimated)} against a ${fmt(budget)} practical budget`,
        description:
          `The weakest test device has ${fmt(weakest)} of RAM, giving a practical working budget of about ` +
          `${fmt(budget)}. Total imported texture and audio content is roughly ${fmt(estimated)}, ` +
          `${ratio.toFixed(1)}x that budget. Not all of it is resident simultaneously, but a project this ` +
          'far over budget has little room for error in what any single scene loads.',
        severity: ratio > 4 ? 'high' : 'medium',
        confidence: 0.5,
        recommendation:
          'Reduce the imported size of the largest content first (texture Max Size and compression give ' +
          'the fastest returns), and make sure content is streamed or Addressable so only the current ' +
          'state is resident.',
        evidence: [
          {
            kind: 'metric',
            summary: `Textures ${fmt(totals.estimatedTextureBytes)}, audio ${fmt(totals.estimatedAudioBytes)} vs budget ${fmt(budget)}`,
            data: { ...totals, weakestDeviceRamBytes: weakest, practicalBudgetBytes: budget },
          },
        ],
        estimatedBytes: estimated,
        subject: 'content budget',
        tags: ['build', 'budget'],
      },
    ];
  },
};

function fmt(bytes: number): string {
  return bytes >= 1024 * MB
    ? `${(bytes / (1024 * MB)).toFixed(2)} GB`
    : `${(bytes / MB).toFixed(1)} MB`;
}

export const BUILD_RULES: StaticRule[] = [
  architectureRule,
  largeHeapRule,
  monoBackendRule,
  contentBudgetRule,
];
