/**
 * Step 8 - Static Rule Engine.
 *
 * Every rule returns rule id, evidence, severity, confidence and a
 * recommendation, exactly as the spec requires. Rules are pure functions over a
 * shared context: they never read the filesystem themselves, so the expensive
 * indexing work happens once and adding a rule costs nothing at scan time.
 *
 * A rule that throws is isolated - one broken rule must not lose the other
 * eleven findings.
 */
import type { ApkInfo } from '../apk/inspector.js';
import type { Logger } from '../core/logger.js';
import type { Finding } from '../core/types.js';
import type { DeviceInfo } from '../devices/deviceManager.js';
import type { UnityProjectInfo } from '../intake/unityProject.js';
import type { AssetIndex } from './assetIndex.js';
import type { CodeIndex } from './codeIndex.js';
import type { SceneIndex } from './sceneIndex.js';

export type RuleCategory = 'asset' | 'import_setting' | 'code' | 'scene' | 'build';

export interface StaticRuleContext {
  project: UnityProjectInfo;
  assets: AssetIndex;
  code: CodeIndex;
  scenes: SceneIndex;
  apk?: ApkInfo | null;
  /** Used to express thresholds relative to the weakest target device. */
  devices?: DeviceInfo[];
  logger?: Logger;
}

export interface StaticRule {
  id: string;
  title: string;
  category: RuleCategory;
  /** Why this matters for OOM, shown in the report's rule appendix. */
  rationale: string;
  run(ctx: StaticRuleContext): Finding[];
}

export interface RuleRunResult {
  findings: Finding[];
  errors: Array<{ ruleId: string; error: string }>;
  ranRules: string[];
  durationMs: number;
}

export class RuleEngine {
  private readonly rules: StaticRule[] = [];

  register(...rules: StaticRule[]): this {
    for (const rule of rules) {
      if (this.rules.some((r) => r.id === rule.id)) {
        throw new Error(`Duplicate static rule id: ${rule.id}`);
      }
      this.rules.push(rule);
    }
    return this;
  }

  get registered(): StaticRule[] {
    return [...this.rules];
  }

  run(ctx: StaticRuleContext): RuleRunResult {
    const started = Date.now();
    const findings: Finding[] = [];
    const errors: Array<{ ruleId: string; error: string }> = [];
    const ranRules: string[] = [];

    for (const rule of this.rules) {
      try {
        const produced = rule.run(ctx);
        findings.push(...produced);
        ranRules.push(rule.id);
        if (produced.length > 0) {
          ctx.logger?.debug(`Rule ${rule.id} produced ${produced.length} finding(s)`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ ruleId: rule.id, error: message });
        ctx.logger?.warn(`Static rule failed: ${rule.id}`, { error: message });
      }
    }

    return { findings, errors, ranRules, durationMs: Date.now() - started };
  }
}

/** Memory budget of the weakest device, used for relative severity. */
export function weakestDeviceRam(ctx: StaticRuleContext): number | null {
  if (!ctx.devices?.length) return null;
  return Math.min(...ctx.devices.map((d) => d.totalRamBytes).filter((r) => r > 0));
}
