/**
 * The pure parts of the PDF export: what a file is called, and what a URL is
 * allowed to ask the report page to do.
 *
 * Split out of main.cjs so tests/exportNaming.test.ts can cover them, because
 * these are the two pieces of the export that fail invisibly. The write happens
 * inside the export loop, so a game name carrying a character Windows refuses
 * ("Robot Era: Reloaded" is the shape that broke it) throws ENOENT/EINVAL and
 * the only visible effect is that no file appears - which is exactly the
 * "didn't save" the operator reported. And a report URL that still carries
 * `print=1` puts a print dialog on screen instead of writing anything, which is
 * the other half of the same report. Neither needs Electron to test.
 *
 * CommonJS to match main.cjs, which requires it directly out of the asar.
 */

/**
 * What each audience cut is called on disk.
 *
 * Deliberately not the internal audience id: these files are emailed to a
 * studio, so "Summary" and "Developer Report" say who they are for, while
 * "lead" and "developer" only make sense inside this tool.
 */
const AUDIENCE_FILE_LABEL = {
  lead: 'Summary',
  developer: 'Developer Report',
  complete: 'Full Report',
};

/**
 * Strip characters Windows and macOS refuse in a file name.
 *
 * The reserved set is Windows': \ / : * ? " < > |. A colon is the one that
 * actually turns up, because subtitled game names use it. Control characters go
 * too - an app label read off the device is whatever the manifest stored, and a
 * stray newline in a path is an error the operator cannot act on.
 *
 * Trailing dots and spaces are removed last: Windows silently drops them when
 * creating the file, so leaving them would make the path we report back to the
 * UI differ from the path that exists on disk.
 */
function safeFileName(value) {
  const cleaned = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, '');

  // Everything can be stripped - an app label of "???" leaves nothing - and an
  // empty name would write to the directory itself.
  return cleaned.length > 0 ? cleaned : 'OOM Report';
}

/**
 * The file name for one audience cut of one game.
 *
 * Named after the game rather than the analysis id because these files leave
 * this machine: the recipient has no way to look an id up.
 */
function pdfFileName(gameName, audience) {
  const label = AUDIENCE_FILE_LABEL[audience] ?? safeFileName(audience);
  return `${safeFileName(gameName || 'OOM Report')} - ${label}.pdf`;
}

/**
 * Remove `print=1` from a console URL.
 *
 * `?print=1` makes the server embed a `window.print()` call in the report page.
 * That is the browser-only route to a PDF, and it is what the operator saw as
 * "print option with reports preview": inside the app it opened a report window
 * with Chromium's print dialog over it and saved nothing at all. Nothing the
 * desktop app loads or hands to the browser should carry it - PDFs come from
 * `printToPDF`, which writes files.
 *
 * A URL that will not parse is returned untouched rather than thrown on: this
 * only ever runs on a URL that is about to be opened for reading, so refusing
 * to open it would be a worse outcome than opening it unscrubbed.
 */
function withoutAutoPrint(url) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('print');
    // A URL that had no query keeps none, rather than gaining a bare "?".
    if ([...parsed.searchParams.keys()].length === 0) parsed.search = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

module.exports = { AUDIENCE_FILE_LABEL, safeFileName, pdfFileName, withoutAutoPrint };
