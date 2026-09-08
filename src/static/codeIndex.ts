/**
 * C# source index for the static rules.
 *
 * Deliberately regex-based rather than a full Roslyn-style parse. The rules we
 * need (Resources.LoadAll, renderer.material, DontDestroyOnLoad, Instantiate in
 * Update, unreleased Addressables handles) are all recognisable lexically, and
 * a real C# parser would add a heavyweight dependency and a large amount of
 * maintenance for marginal precision.
 *
 * What we do take seriously is *false positives*: comments and string literals
 * are blanked before matching, so a commented-out `Resources.LoadAll` or a log
 * message mentioning it does not become a finding. Line numbers are preserved
 * by replacing rather than deleting characters.
 */
import { readFileSync, statSync } from 'node:fs';
import { relative, sep } from 'node:path';

import type { Logger } from '../core/logger.js';
import { walk } from '../intake/unityProject.js';

export interface SourceFile {
  path: string;
  relPath: string;
  /** Vendored SDK code: analyzed, but reported with that context attached. */
  thirdParty: boolean;
  /** Source with comments and string contents blanked out. */
  code: string;
  /** Original text, used for report excerpts. */
  original: string;
  lines: string[];
  sizeBytes: number;
}

export interface CodeIndex {
  files: SourceFile[];
  totalBytes: number;
  skipped: number;
  /** Editor-only files excluded because they never reach a player build. */
  editorOnlyExcluded: number;
  scannedInMs: number;
}

export interface CodeMatch {
  file: SourceFile;
  /** 1-indexed. */
  line: number;
  column: number;
  text: string;
  /** The original source line, trimmed. */
  excerpt: string;
  /** Named capture groups from the pattern, when present. */
  groups?: Record<string, string>;
}

export interface BuildCodeIndexOptions {
  projectRoot: string;
  logger?: Logger;
  maxFileBytes?: number;
  maxFiles?: number;
}

/**
 * Editor-only code, which Unity compiles for the Editor and *never* includes in
 * a player build.
 *
 * Excluding it is a correctness requirement, not a noise filter: a
 * `new Texture2D` in an editor window cannot leak at runtime because the code is
 * not in the shipped app at all. Unity treats any directory named `Editor` as
 * special regardless of where it sits, so the whole path is checked, and so are
 * the other folders Unity excludes from builds.
 */
const EDITOR_ONLY_PATH =
  /(^|\/)(Editor|Editor Default Resources|Gizmos)(\/|$)/i;

/** Generated code that would only produce noise. */
const GENERATED_PATH = /(^|\/)Generated(\/|$)|\.g\.cs$|\.designer\.cs$/i;

/**
 * Vendored SDKs. Kept in the index - third-party runtime code can genuinely
 * leak - but flagged, because a studio usually cannot fix it directly and needs
 * to know that before treating it as an action item.
 */
const THIRD_PARTY_PATH =
  /(^|\/)(Plugins|ThirdParty|Third Party|MaxSdk|GoogleMobileAds|Firebase|FacebookSDK|AppLovin|UnityAds|IronSource|Adjust|AppsFlyer|Photon|PlayServicesResolver|ExternalDependencyManager)(\/|$)/i;

export function buildCodeIndex(opts: BuildCodeIndexOptions): CodeIndex {
  const started = Date.now();
  const maxFileBytes = opts.maxFileBytes ?? 2 * 1024 * 1024;
  const maxFiles = opts.maxFiles ?? 20_000;

  const files: SourceFile[] = [];
  let skipped = 0;
  let editorOnlyExcluded = 0;
  let totalBytes = 0;

  walk(opts.projectRoot, (filePath) => {
    if (!filePath.endsWith('.cs')) return;
    if (files.length >= maxFiles) {
      skipped++;
      return;
    }

    const relPath = relative(opts.projectRoot, filePath).split(sep).join('/');

    // Editor-only code is not in the shipped build, so it cannot cause a
    // runtime leak. Counted separately from ordinary skips so the report can
    // say how much was excluded and why.
    if (EDITOR_ONLY_PATH.test(relPath)) {
      editorOnlyExcluded++;
      return;
    }
    if (GENERATED_PATH.test(relPath)) {
      skipped++;
      return;
    }

    let sizeBytes = 0;
    try {
      sizeBytes = statSync(filePath).size;
    } catch {
      return;
    }
    if (sizeBytes > maxFileBytes) {
      skipped++;
      return;
    }

    let original: string;
    try {
      original = readFileSync(filePath, 'utf8');
    } catch {
      skipped++;
      return;
    }

    totalBytes += sizeBytes;
    files.push({
      path: filePath,
      relPath,
      thirdParty: THIRD_PARTY_PATH.test(relPath),
      original,
      code: blankCommentsAndStrings(original),
      lines: original.split(/\r?\n/),
      sizeBytes,
    });
  });

  const scannedInMs = Date.now() - started;
  opts.logger?.info('Code index built', {
    files: files.length,
    thirdParty: files.filter((f) => f.thirdParty).length,
    editorOnlyExcluded,
    skipped,
    kb: Math.round(totalBytes / 1024),
    ms: scannedInMs,
  });

  return { files, totalBytes, skipped, editorOnlyExcluded, scannedInMs };
}

/**
 * Replace comment and string-literal content with spaces, keeping every
 * character position (and therefore every line number) intact.
 */
export function blankCommentsAndStrings(source: string): string {
  const out = source.split('');
  let i = 0;
  const n = source.length;

  const blankTo = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    }
  };

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      blankTo(i, end === -1 ? n : end);
      i = end === -1 ? n : end;
      continue;
    }

    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      blankTo(i, end === -1 ? n : end + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }

    // Verbatim string: @"..." where "" is an escaped quote.
    if (ch === '@' && next === '"') {
      let k = i + 2;
      while (k < n) {
        if (source[k] === '"') {
          if (source[k + 1] === '"') k += 2;
          else break;
        } else k++;
      }
      blankTo(i, Math.min(k + 1, n));
      i = k + 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      let k = i + 1;
      while (k < n) {
        if (source[k] === '\\') {
          k += 2;
          continue;
        }
        if (source[k] === ch || source[k] === '\n') break;
        k++;
      }
      blankTo(i, Math.min(k + 1, n));
      i = k + 1;
      continue;
    }

    i++;
  }

  return out.join('');
}

/** Run a pattern across the whole index. The regex must carry the `g` flag. */
export function scanCode(index: CodeIndex, pattern: RegExp, limit = 200): CodeMatch[] {
  const matches: CodeMatch[] = [];

  for (const file of index.files) {
    const re = new RegExp(pattern.source, ensureGlobal(pattern.flags));
    let m: RegExpExecArray | null;
    while ((m = re.exec(file.code)) !== null) {
      const { line, column } = positionOf(file.code, m.index);
      matches.push({
        file,
        line,
        column,
        text: m[0],
        excerpt: (file.lines[line - 1] ?? '').trim().slice(0, 240),
        ...(m.groups ? { groups: m.groups } : {}),
      });
      if (matches.length >= limit) return matches;
      if (m[0].length === 0) re.lastIndex++; // guard against zero-width patterns
    }
  }

  return matches;
}

function ensureGlobal(flags: string): string {
  return flags.includes('g') ? flags : `${flags}g`;
}

export function positionOf(text: string, index: number): { line: number; column: number } {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < index; i++) {
    if (text[i] === '\n') {
      line++;
      lastNewline = i;
    }
  }
  return { line, column: index - lastNewline };
}

/**
 * Extract the body of a named method, so rules can ask "is this call inside
 * Update()?". Brace-matched on the comment-blanked source, which makes the
 * matching reliable without a parser.
 */
export function findMethodBodies(
  file: SourceFile,
  methodNames: string[],
): Array<{ name: string; start: number; end: number; startLine: number }> {
  const results: Array<{ name: string; start: number; end: number; startLine: number }> = [];
  const namePattern = methodNames.map(escapeRegex).join('|');
  const re = new RegExp(String.raw`\b(?:void|IEnumerator)\s+(${namePattern})\s*\([^)]*\)\s*\{`, 'g');

  let m: RegExpExecArray | null;
  while ((m = re.exec(file.code)) !== null) {
    const braceStart = file.code.indexOf('{', m.index + m[0].length - 1);
    if (braceStart === -1) continue;
    const end = matchBrace(file.code, braceStart);
    if (end === -1) continue;
    results.push({
      name: m[1] ?? 'unknown',
      start: braceStart,
      end,
      startLine: positionOf(file.code, m.index).line,
    });
  }
  return results;
}

export function matchBrace(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
