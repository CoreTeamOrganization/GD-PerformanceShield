import { randomBytes } from 'node:crypto';

/** Lowercase, filesystem-safe slug used for game ids and workspace folders. */
export function slugify(input: string, fallback = 'game'): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase()
    .slice(0, 48)
    .replace(/^-|-$/g, '');
  return slug.length > 0 ? slug : fallback;
}

/**
 * Analysis id: sortable timestamp prefix + random suffix.
 * Sortable matters because the workspace is browsed by humans on a test bench.
 */
export function createAnalysisId(gameId: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  return `${gameId}_${stamp}_${randomBytes(3).toString('hex')}`;
}

export function shortId(bytes = 4): string {
  return randomBytes(bytes).toString('hex');
}

/** Deterministic id for a finding so repeated runs produce stable references. */
export function findingId(ruleId: string, subject: string): string {
  const normalized = `${ruleId}::${subject}`.toLowerCase();
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `f_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
