/**
 * Activity-start classification - the source of the "Ad opened / Left the
 * game / Back in the game" context lines. Lines are real ActivityTaskManager
 * shapes; the contract is that ads and home are recognized, the game's own
 * activity is only a signal (the session decides whether it means "returned"),
 * and everything else is silence.
 */
import { describe, expect, it } from 'vitest';

import { classifyActivityStart } from '../src/telemetry/activityEvents.js';

const PKG = 'com.gd.planesim';

describe('classifyActivityStart', () => {
  it('recognizes interstitial ad activities by their SDK class', () => {
    const line =
      'START u0 {flg=0x10000000 cmp=com.gd.planesim/com.google.android.gms.ads.AdActivity} from uid 10412';
    expect(classifyActivityStart(line, PKG)).toEqual({ kind: 'ad', sdk: 'AdMob' });

    const applovin =
      'START u0 {cmp=com.gd.planesim/com.applovin.adview.AppLovinFullscreenActivity} from uid 10412';
    expect(classifyActivityStart(applovin, PKG)).toEqual({ kind: 'ad', sdk: 'AppLovin' });

    const unity =
      'START u0 {cmp=com.gd.planesim/com.unity3d.services.ads.adunit.AdUnitActivity}';
    expect(classifyActivityStart(unity, PKG)).toEqual({ kind: 'ad', sdk: 'Unity Ads' });
  });

  it('recognizes leaving for the home screen', () => {
    const line =
      'START u0 {act=android.intent.action.MAIN cat=[android.intent.category.HOME] flg=0x10200000 ' +
      'cmp=com.miui.home/.launcher.Launcher} from uid 1000';
    expect(classifyActivityStart(line, PKG)).toEqual({ kind: 'home' });
  });

  it("flags the game's own activity as a game signal, and only with a package to match", () => {
    const line =
      'START u0 {cmp=com.gd.planesim/com.unity3d.player.UnityPlayerActivity} from uid 10412';
    expect(classifyActivityStart(line, PKG)).toEqual({ kind: 'game' });
    expect(classifyActivityStart(line, undefined)).toBeNull();
  });

  it('stays silent on unrelated activity starts and non-START lines', () => {
    expect(
      classifyActivityStart('START u0 {cmp=com.whatsapp/.Main} from uid 10099', PKG),
    ).toBeNull();
    expect(classifyActivityStart('Displayed com.gd.planesim/.MainActivity: +1s340ms', PKG)).toBeNull();
  });

  it('an ad class wins over the game package prefix on the same component', () => {
    // Ad activities run inside the game's process and package - the class is
    // what identifies them, so the ad must win over the "game" match.
    const line = 'START u0 {cmp=com.gd.planesim/com.ironsource.sdk.controller.ControllerActivity}';
    expect(classifyActivityStart(line, PKG)).toEqual({ kind: 'ad', sdk: 'ironSource' });
  });
});
