/**
 * Deciding what a session is called.
 *
 * A module of its own, and the only part of the console with tests, because
 * this decision has been wrong twice and each time it was wrong in a way that
 * outlived the session. The title picks the report heading, the folder on disk
 * and the key every later comparison looks the session up by, so a wrong one
 * cannot be corrected by re-reading the report.
 *
 * What went wrong, both times, is recorded in the functions below - the rules
 * only make sense next to the mistakes they exist to prevent.
 */

/**
 * What the title field should hold, given what is in it and what is known.
 *
 * The field is filled from the chosen app's display name, but must never
 * overwrite a name the operator typed themselves. The first version tested that
 * by asking whether the field was empty, which cannot tell the operator's text
 * from text this function put there on a previous choice: selecting
 * "Wedding Rush Draw Puzzle", changing to `com.gdm.prison.guard` and pressing
 * Analyze filed the whole session under the wedding game. A wrong name is worse
 * than a missing one, because it looks like a real answer.
 *
 * Remembering what we last wrote separates the two cases. When no label is
 * known yet the answer is the empty string rather than the stale text: an empty
 * title is still recoverable at submit, and a wrong one is not.
 *
 * @param {string} current      what the field holds now
 * @param {string} autofilled   what this function last put there
 * @param {string} label        the chosen app's display name, '' if unknown
 * @returns {string | null}     the new value, or null to leave the field alone
 */
export function chooseGameName(current, autofilled, label) {
  const typed = current.trim();
  const isOurs = typed === '' || typed === autofilled;
  if (!isOurs) return null;
  return label ?? '';
}

/**
 * The name a session is finally submitted under.
 *
 * Three sources in order of authority: what the operator wrote, the display
 * name of the app actually selected, then a placeholder. The operator's text
 * only counts as theirs if it differs from what this module autofilled -
 * otherwise a stale autofill from a previously chosen app would outrank the
 * real label for the app being profiled, which is exactly the fault above.
 *
 * `typedName` still appears as a late fallback: if it is our own autofill and
 * no label is known, it is at least a name that was once read off a real APK.
 *
 * @param {string} typedName        the field's contents at submit
 * @param {string} autofilledName   what this module last autofilled
 * @param {string | undefined} knownLabel  label for the selected package
 * @returns {string}
 */
export function chooseSubmittedName(typedName, autofilledName, knownLabel) {
  const operatorTyped = typedName !== '' && typedName !== autofilledName;
  return (operatorTyped ? typedName : '') || knownLabel || typedName || 'Unnamed game';
}
