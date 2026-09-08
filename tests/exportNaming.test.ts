/**
 * Naming of the exported PDFs.
 *
 * These are the files that leave the machine, and the write happens inside the
 * export loop, so a name the filesystem refuses surfaces to the operator only
 * as "it didn't save". The module is plain CommonJS with no Electron import
 * precisely so this can be checked here rather than by running the app.
 */
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

// A real `require`, because the module under test is the CommonJS one Electron's
// main process loads - loading it any other way would test a different thing.
const require_ = createRequire(import.meta.url);
const { AUDIENCE_FILE_LABEL, pdfFileName, safeFileName, withoutAutoPrint } = require_(
  '../desktop/exportNaming.cjs',
) as {
  AUDIENCE_FILE_LABEL: Record<string, string>;
  pdfFileName: (gameName: unknown, audience: unknown) => string;
  safeFileName: (value: unknown) => string;
  withoutAutoPrint: (url: string) => string;
};

/** Every character Windows rejects outright in a file name. */
const WINDOWS_RESERVED = /[\\/:*?"<>|]/;

describe('safeFileName', () => {
  it('replaces the characters Windows refuses', () => {
    const name = safeFileName('Robot Era: Reloaded <alpha> / "final"? *');
    expect(name).not.toMatch(WINDOWS_RESERVED);
    expect(name).toContain('Robot Era');
  });

  it('removes control characters rather than leaving them in a path', () => {
    // An app label read off the device is whatever the manifest stored, so a
    // newline is possible and would make the reported path unusable.
    expect(safeFileName('Robot\nEra\tGame')).toBe('Robot Era Game');
  });

  it('drops trailing dots and spaces, which Windows silently strips', () => {
    // If they survived here the path shown to the operator would differ from
    // the path that actually exists on disk.
    expect(safeFileName('Robot Era ... ')).toBe('Robot Era');
    expect(safeFileName('Robot Era  ')).toBe('Robot Era');
  });

  it('never returns an empty name', () => {
    // Stripping can consume the whole label, and an empty name would make the
    // export write to the directory itself.
    expect(safeFileName('...')).toBe('OOM Report');
    expect(safeFileName('   ')).toBe('OOM Report');
    expect(safeFileName(null)).toBe('OOM Report');
    expect(safeFileName(undefined)).toBe('OOM Report');
  });

  it('caps the length so the whole path stays inside the Windows limit', () => {
    expect(safeFileName('x'.repeat(400)).length).toBeLessThanOrEqual(80);
  });
});

describe('pdfFileName', () => {
  it('names the file after the game and the audience it is written for', () => {
    // The recipient has no way to look up an analysis id, so the game name and
    // the reader are what the file has to say.
    expect(pdfFileName('Robot Era Game', 'lead')).toBe('Robot Era Game - Summary.pdf');
    expect(pdfFileName('Robot Era Game', 'developer')).toBe(
      'Robot Era Game - Developer Report.pdf',
    );
    expect(pdfFileName('Robot Era Game', 'complete')).toBe('Robot Era Game - Full Report.pdf');
  });

  it('produces a writable name from a game name full of reserved characters', () => {
    const file = pdfFileName('Robot Era: Reloaded', 'complete');
    expect(file).not.toMatch(WINDOWS_RESERVED);
    expect(file.endsWith('.pdf')).toBe(true);
  });

  it('falls back to a generic name when the game name is missing', () => {
    expect(pdfFileName('', 'lead')).toBe('OOM Report - Summary.pdf');
    expect(pdfFileName(undefined, 'lead')).toBe('OOM Report - Summary.pdf');
  });

  it('still produces a safe name for an audience it has no label for', () => {
    // A cut added to the server before this table is updated must not write a
    // file called "OOM Report - ../evil.pdf".
    expect(pdfFileName('Game', '../evil')).toBe('Game - ..-evil.pdf');
  });

  it('covers every audience the reports are cut for', () => {
    expect(Object.keys(AUDIENCE_FILE_LABEL).sort()).toEqual(['complete', 'developer', 'lead']);
  });
});

describe('withoutAutoPrint', () => {
  it('strips print=1, which is what put a print dialog on screen', () => {
    expect(
      withoutAutoPrint('http://127.0.0.1:5123/api/analysis/abc/report.html?audience=lead&print=1'),
    ).toBe('http://127.0.0.1:5123/api/analysis/abc/report.html?audience=lead');
  });

  it('strips it regardless of value or position', () => {
    expect(withoutAutoPrint('http://127.0.0.1:1/api/compare.html?print=1&before=a&after=b')).toBe(
      'http://127.0.0.1:1/api/compare.html?before=a&after=b',
    );
    expect(withoutAutoPrint('http://127.0.0.1:1/x?print=0')).toBe('http://127.0.0.1:1/x');
  });

  it('leaves a URL with no print parameter alone, and adds no bare question mark', () => {
    expect(withoutAutoPrint('http://127.0.0.1:1/api/analysis/abc/report.md')).toBe(
      'http://127.0.0.1:1/api/analysis/abc/report.md',
    );
    expect(withoutAutoPrint('https://example.com/guide#section')).toBe(
      'https://example.com/guide#section',
    );
  });

  it('returns unparseable input untouched rather than throwing', () => {
    // This runs on a URL that is about to be opened for reading, so refusing to
    // open it would be worse than opening it unscrubbed.
    expect(withoutAutoPrint('not a url')).toBe('not a url');
  });
});
