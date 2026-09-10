/**
 * Step 12 - Correlation Engine.
 *
 * Joins static hypotheses to what actually happened on the device. This is the
 * step that turns "the shop textures look heavy" and "closing the shop keeps
 * 180 MB" into one high-confidence finding with a named cause, which is exactly
 * the example the spec uses in section 12.
 *
 * Matching is deliberately explainable rather than clever: every correlation
 * records *why* the two findings were joined, so a studio engineer can judge it
 * rather than being asked to trust a score.
 */
import { findingId } from '../core/ids.js';
import { MB, type Evidence, type Finding, type Severity } from '../core/types.js';
import type { AssetIndex } from '../static/assetIndex.js';
import type { SceneIndex } from '../static/sceneIndex.js';
import { fmtMb } from './anomaly.js';

export interface CorrelationInput {
  staticFindings: Finding[];
  liveFindings: Finding[];
  assets?: AssetIndex;
  scenes?: SceneIndex;
}

export interface CorrelationLink {
  liveFindingId: string;
  staticFindingId: string;
  /** Why these two were joined, in plain language. */
  reason: string;
  strength: number;
}

export interface CorrelationResult {
  /** New, merged findings. These supersede their inputs in the report. */
  correlated: Finding[];
  links: CorrelationLink[];
  /** Ids of inputs that were folded into a correlated finding. */
  consumedStaticIds: Set<string>;
  consumedLiveIds: Set<string>;
}

/** Live rule ids that indicate retention, and the static causes that explain it. */
const RETENTION_LIVE_RULES = new Set([
  'LIVE.RECOVERY_FAILURE',
  'LIVE.BASELINE_CLIMB',
  'LIVE.SCREEN_RETENTION',
  'LIVE.SUSTAINED_GROWTH',
]);

const RETENTION_STATIC_RULES = new Set([
  'CODE.ADDRESSABLES_LIFETIME',
  'CODE.DONT_DESTROY_ON_LOAD',
  'CODE.UNBOUNDED_COLLECTION',
  'CODE.EVENT_SUBSCRIPTION',
  'CODE.RUNTIME_TEXTURE_MESH',
  'CODE.TEMP_RENDER_TEXTURE',
  'CODE.RESOURCES_LOAD_ALL',
  'CODE.RESOURCES_NO_UNLOAD',
  'CODE.RENDERER_MATERIAL',
  'CODE.INSTANTIATE_HOT_PATH',
]);

/** Live rule ids indicating a load-time peak, and the static causes for those. */
const PEAK_LIVE_RULES = new Set(['LIVE.SPIKE', 'LIVE.DEVICE_PRESSURE', 'LIVE.PROCESS_TERMINATED']);

const PEAK_STATIC_RULES = new Set([
  'UNITY.SCENE.HEAVY',
  'UNITY.TEXTURE.OVERSIZED',
  'UNITY.TEXTURE.OVERSIZED_GROUP',
  'UNITY.TEXTURE.UNCOMPRESSED',
  'UNITY.TEXTURE.NO_ANDROID_OVERRIDE',
  'UNITY.TEXTURE.READ_WRITE_ENABLED',
  'UNITY.AUDIO.DECOMPRESS_ON_LOAD',
  'UNITY.AUDIO.PRELOAD',
  'UNITY.RENDER_TEXTURE.LARGE',
  'BUILD.CONTENT_BUDGET',
  'BUILD.32BIT_ONLY',
]);

export function correlate(input: CorrelationInput): CorrelationResult {
  const links: CorrelationLink[] = [];
  const correlated: Finding[] = [];
  const consumedStaticIds = new Set<string>();
  const consumedLiveIds = new Set<string>();

  for (const live of input.liveFindings) {
    const candidates = findCandidates(live, input);
    if (candidates.length === 0) continue;

    // Keep the strongest few: a correlated finding listing twenty static causes
    // is not actionable.
    const chosen = candidates.sort((a, b) => b.strength - a.strength).slice(0, 4);

    for (const candidate of chosen) {
      links.push({
        liveFindingId: live.id,
        staticFindingId: candidate.finding.id,
        reason: candidate.reason,
        strength: candidate.strength,
      });
    }

    const merged = mergeFindings(live, chosen);
    correlated.push(merged);
    consumedLiveIds.add(live.id);
    for (const candidate of chosen) consumedStaticIds.add(candidate.finding.id);
  }

  return { correlated, links, consumedStaticIds, consumedLiveIds };
}

interface Candidate {
  finding: Finding;
  reason: string;
  strength: number;
}

function findCandidates(live: Finding, input: CorrelationInput): Candidate[] {
  const candidates: Candidate[] = [];
  const subjectTokens = tokenize(live.subject ?? '');
  const screenTag = live.tags.find((t) => t.startsWith('screen:'))?.slice('screen:'.length);

  for (const staticFinding of input.staticFindings) {
    // 1. Name overlap: the strongest signal we have. A live finding about the
    //    "Shop" screen and a static finding whose evidence paths contain "shop"
    //    are almost certainly about the same content.
    const nameMatch = matchByName(screenTag ?? null, subjectTokens, staticFinding);
    if (nameMatch) {
      candidates.push(nameMatch);
      continue;
    }

    // 2. Mechanism match: retention at runtime explained by a lifetime bug in
    //    code, or a load spike explained by heavy content.
    if (RETENTION_LIVE_RULES.has(live.ruleId) && RETENTION_STATIC_RULES.has(staticFinding.ruleId)) {
      candidates.push({
        finding: staticFinding,
        reason:
          `Runtime memory was retained after returning to the same state, and this code pattern is a ` +
          `known cause of exactly that behaviour.`,
        strength: 0.6,
      });
      continue;
    }

    if (PEAK_LIVE_RULES.has(live.ruleId) && PEAK_STATIC_RULES.has(staticFinding.ruleId)) {
      // Weight by how large the static finding's estimate is relative to the
      // observed jump - a 5 MB texture does not explain a 400 MB spike.
      const strength = magnitudeAgreement(live.estimatedBytes, staticFinding.estimatedBytes);
      if (strength > 0) {
        candidates.push({
          finding: staticFinding,
          reason:
            `The observed memory increase is consistent in magnitude with this content's estimated cost.`,
          strength,
        });
      }
    }
  }

  return candidates;
}

function matchByName(
  screen: string | null,
  subjectTokens: string[],
  staticFinding: Finding,
): Candidate | null {
  const tokens = screen ? [screen, ...subjectTokens] : subjectTokens;
  const meaningful = tokens.filter((t) => t.length >= 4 && !STOP_WORDS.has(t));
  if (meaningful.length === 0) return null;

  const haystack = [
    staticFinding.subject ?? '',
    ...staticFinding.evidence.map((e) => `${e.path ?? ''} ${e.summary}`),
  ]
    .join(' ')
    .toLowerCase();

  for (const token of meaningful) {
    if (haystack.includes(token)) {
      return {
        finding: staticFinding,
        reason: `Both refer to "${token}" - the runtime observation and the static finding concern the same content.`,
        strength: 0.9,
      };
    }
  }
  return null;
}

/**
 * How well a static estimate explains an observed runtime delta.
 *
 * Returns 0 when the static finding is too small to be a plausible explanation,
 * which prevents the report filling up with weak "maybe related" links.
 */
function magnitudeAgreement(observed: number | undefined, estimated: number | undefined): number {
  if (!observed || !estimated) return 0.35; // no numbers - weak but not absent
  const ratio = estimated / observed;
  if (ratio >= 0.5 && ratio <= 2) return 0.8; // same order of magnitude
  if (ratio >= 0.2 && ratio < 0.5) return 0.55; // a meaningful part of it
  if (ratio > 2 && ratio <= 10) return 0.45; // static is an upper bound
  return 0;
}

/**
 * Build the merged finding.
 *
 * Confidence rises above either input because agreement between an independent
 * static prediction and a runtime measurement is genuinely stronger evidence
 * than either alone - but it is capped, since both can share a wrong premise.
 */
function mergeFindings(live: Finding, causes: Candidate[]): Finding {
  const severity = maxSeverity([live.severity, ...causes.map((c) => c.finding.severity)]);
  const confidence = Math.min(
    0.97,
    live.confidence + (1 - live.confidence) * (0.5 * Math.max(...causes.map((c) => c.strength))),
  );

  const evidence: Evidence[] = [
    {
      kind: 'note',
      summary: 'Runtime observation',
    },
    ...live.evidence,
    {
      kind: 'note',
      summary: `Likely cause${causes.length > 1 ? 's' : ''} found in the project`,
    },
    ...causes.flatMap((c) => [
      {
        kind: 'note' as const,
        summary: `${c.finding.title} - ${c.reason}`,
      },
      ...c.finding.evidence.slice(0, 6),
    ]),
  ];

  const recommendation = [
    live.recommendation,
    ...causes.map((c) => `From "${c.finding.title}": ${c.finding.recommendation}`),
  ].join('\n\n');

  const estimatedBytes = live.estimatedBytes ?? causes[0]?.finding.estimatedBytes;

  return {
    ruleId: `CORRELATED.${live.ruleId}`,
    id: findingId('CORRELATED', `${live.id}:${causes.map((c) => c.finding.id).join(',')}`),
    source: 'correlated',
    title: live.title,
    description:
      `${live.description}\n\n` +
      `This was measured on a real device, and the project contains ${causes.length === 1 ? 'a matching cause' : 'matching causes'}: ` +
      causes.map((c) => c.finding.title).join('; ') +
      `.${estimatedBytes ? ` Estimated impact: ${fmtMb(estimatedBytes)}.` : ''}`,
    severity,
    confidence,
    recommendation,
    evidence,
    ...(estimatedBytes !== undefined ? { estimatedBytes } : {}),
    subject: live.subject ?? causes[0]?.finding.subject,
    tags: [...new Set([...live.tags, ...causes.flatMap((c) => c.finding.tags), 'correlated'])],
  };
}

const SEVERITY_ORDER: Severity[] = ['info', 'low', 'medium', 'high', 'critical'];

export function maxSeverity(severities: Severity[]): Severity {
  return severities.reduce<Severity>(
    (best, s) => (SEVERITY_ORDER.indexOf(s) > SEVERITY_ORDER.indexOf(best) ? s : best),
    'info',
  );
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'from',
  'into',
  'device',
  'memory',
  'screen',
  'state',
  'unknown',
  'session',
  'wide',
  'growth',
  'process',
  'termination',
  'repeated',
  'flow',
  'baseline',
  'climb',
  'pressure',
  'crash',
]);

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Bytes formatter kept local so the report can reuse the same wording. */
export function formatBytes(bytes: number): string {
  return bytes >= 1024 * MB
    ? `${(bytes / (1024 * MB)).toFixed(2)} GB`
    : `${(bytes / MB).toFixed(1)} MB`;
}
