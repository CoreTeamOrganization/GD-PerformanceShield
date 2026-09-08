/**
 * What a session is called.
 *
 * Two real sessions were filed wrongly before these existed. Both survived the
 * run: the title becomes the report heading, the folder on disk, and the key
 * every later comparison looks the session up by, so neither could be corrected
 * afterwards by re-reading anything.
 *
 *  - `com.gdm.prison.guard` filed as `unnamed-game`, because reading an app's
 *    display name off the device takes about 770 ms and pressing Analyze right
 *    after choosing beat the lookup.
 *  - the same package filed as `wedding-rush-draw-puzzle`, because the title
 *    field still held the name autofilled for an app chosen moments earlier and
 *    the code could not tell its own text from the operator's.
 */
import { describe, expect, it } from 'vitest';

// @ts-expect-error - the console's browser JS carries JSDoc types, not .d.ts
import { chooseGameName, chooseSubmittedName } from '../src/ui/naming.js';

const PRISON = 'Prison Riot: Guard Simulator';
const WEDDING = 'Wedding Rush Draw Puzzle';

describe('filling the title field', () => {
  it('fills an empty field from the chosen app', () => {
    expect(chooseGameName('', '', PRISON)).toBe(PRISON);
  });

  it('replaces its own text when the app changes', () => {
    // The wedding-rush fault. The field held a name, but one this code had put
    // there for a different app - so it was never the operator's to protect.
    expect(chooseGameName(WEDDING, WEDDING, PRISON)).toBe(PRISON);
  });

  it('never overwrites a name the operator typed', () => {
    expect(chooseGameName('My Build v3', '', PRISON)).toBeNull();
  });

  it('leaves the operator alone even after they change app', () => {
    expect(chooseGameName('My Build v3', WEDDING, PRISON)).toBeNull();
  });

  it('treats an edit of its own text as the operator taking ownership', () => {
    expect(chooseGameName(`${PRISON} (staging)`, PRISON, PRISON)).toBeNull();
  });

  it('fills again once the operator clears the field', () => {
    expect(chooseGameName('', WEDDING, PRISON)).toBe(PRISON);
  });

  it('clears its own stale text rather than keep it while the label loads', () => {
    // An empty title is still recoverable at submit; a wrong one is not, and
    // for the ~770 ms the lookup takes it would otherwise name another game.
    expect(chooseGameName(WEDDING, WEDDING, '')).toBe('');
  });

  it('counts whitespace as empty', () => {
    expect(chooseGameName('   ', '', PRISON)).toBe(PRISON);
  });
});

describe('the name a session is submitted under', () => {
  it('uses the label when the field only holds our autofill', () => {
    expect(chooseSubmittedName(PRISON, PRISON, PRISON)).toBe(PRISON);
  });

  it('lets the real label beat a stale autofill', () => {
    // The last line of defence against the wedding-rush fault: even if the
    // field somehow still holds the old name, the selected app's label wins.
    expect(chooseSubmittedName(WEDDING, WEDDING, PRISON)).toBe(PRISON);
  });

  it('gives the operator the final word', () => {
    expect(chooseSubmittedName('My Build v3', PRISON, PRISON)).toBe('My Build v3');
  });

  it('falls back to a placeholder only when nothing is known', () => {
    expect(chooseSubmittedName('', '', undefined)).toBe('Unnamed game');
  });

  it('uses the label when the operator typed nothing', () => {
    expect(chooseSubmittedName('', '', PRISON)).toBe(PRISON);
  });

  it('keeps a once-real autofill over a placeholder', () => {
    // No label for the current selection, but the field holds a name that was
    // read off an APK at some point. Better than "Unnamed game".
    expect(chooseSubmittedName(WEDDING, WEDDING, undefined)).toBe(WEDDING);
  });
});
