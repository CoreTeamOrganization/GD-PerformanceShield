/**
 * Context events from the system's own activity log.
 *
 * ActivityTaskManager announces every activity start with its component name,
 * and the moments an operator most wants marked on the charts are exactly
 * activity switches: an interstitial ad opening (a separate activity with a
 * recognizable SDK class), leaving for the home screen, coming back. Reading
 * them from logcat costs nothing the tool is not already paying and needs no
 * SDK integration in the game.
 *
 * Honest limits, stated where the labels are made: banner ads and rewarded
 * videos rendered inside the game's own activity never start one, so they are
 * invisible here. What this catches is interstitials and app switches - the
 * events that explain a memory step or a frame-rate cliff on the timeline.
 */

/** Known ad-SDK activity fragments, and the name a label should use. */
const AD_ACTIVITIES: Array<{ fragment: string; sdk: string }> = [
  { fragment: 'com.google.android.gms.ads', sdk: 'AdMob' },
  { fragment: 'com.unity3d.services.ads', sdk: 'Unity Ads' },
  { fragment: 'com.unity3d.ads', sdk: 'Unity Ads' },
  { fragment: 'com.applovin', sdk: 'AppLovin' },
  { fragment: 'com.ironsource', sdk: 'ironSource' },
  { fragment: 'com.vungle', sdk: 'Vungle' },
  { fragment: 'com.facebook.ads.AudienceNetworkActivity', sdk: 'Meta Audience Network' },
  { fragment: 'com.bytedance.sdk', sdk: 'Pangle' },
  { fragment: 'com.mbridge.msdk', sdk: 'Mintegral' },
  { fragment: 'com.adcolony', sdk: 'AdColony' },
  { fragment: 'com.chartboost', sdk: 'Chartboost' },
  { fragment: 'com.moloco', sdk: 'Moloco' },
  { fragment: 'com.inmobi', sdk: 'InMobi' },
  { fragment: 'com.fyber', sdk: 'Fyber' },
  { fragment: 'sg.bigo.ads', sdk: 'BIGO Ads' },
  { fragment: 'com.my.target', sdk: 'myTarget' },
];

export type ActivitySignal =
  | { kind: 'ad'; sdk: string }
  | { kind: 'home' }
  | { kind: 'game' };

/**
 * Classify one `START u...` line from ActivityTaskManager.
 *
 * Stateless on purpose - whether a game-activity start means "returned from an
 * ad" depends on what happened before, and that judgement lives with the
 * session, which sees the events in order.
 */
export function classifyActivityStart(
  message: string,
  packageName: string | undefined,
): ActivitySignal | null {
  if (!/\bSTART u\d+\b/.test(message)) return null;

  // cmp=package/class is the component actually being started.
  const cmp = /cmp=([^\s}]+)/.exec(message)?.[1] ?? '';
  const full = cmp.replace('/', cmp.includes('/.') ? '' : '/');

  for (const ad of AD_ACTIVITIES) {
    if (full.includes(ad.fragment) || message.includes(ad.fragment)) {
      return { kind: 'ad', sdk: ad.sdk };
    }
  }

  if (message.includes('android.intent.category.HOME')) return { kind: 'home' };

  if (packageName && cmp.startsWith(`${packageName}/`)) return { kind: 'game' };

  return null;
}
