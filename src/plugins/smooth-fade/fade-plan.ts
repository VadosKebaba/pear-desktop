export type FadeCurve = 'equal-power' | 'linear';

export interface FadePlan {
  /** Fade-in occupies song time [0, fadeIn) */
  fadeIn: number | null;
  /** Fade-out occupies song time [outStart, duration) */
  outStart: number | null;
  duration: number;
  /**
   * After the fade-out lands at 0, gain climbs back to 1 over this many
   * seconds. Doubles as the next song's fade-in, and guarantees the gain is
   * never left at 0 even if the next song is never detected.
   */
  recover: number;
}

/** Songs shorter than this multiple of (fadeOut + fadeIn) get no fades */
export const SHORT_SONG_FACTOR = 3;
const MIN_RECOVER_S = 0.05;

export const planFade = ({
  duration,
  durationStable,
  fadeInS,
  fadeOutS,
}: {
  duration: number;
  durationStable: boolean;
  fadeInS: number;
  fadeOutS: number;
}): FadePlan => {
  const short =
    durationStable && duration < SHORT_SONG_FACTOR * (fadeInS + fadeOutS);
  return {
    // Duration is often unknown/stale at song start, so fade in unless we
    // already know the song is short
    fadeIn: fadeInS > 0 && !short ? fadeInS : null,
    outStart:
      fadeOutS > 0 && durationStable && !short ? duration - fadeOutS : null,
    duration,
    recover: Math.max(fadeInS, MIN_RECOVER_S),
  };
};

/** Gain for progress p in [0, 1] of a fade */
export const curveValue = (
  kind: 'in' | 'out',
  curve: FadeCurve,
  p: number,
): number => {
  const x = Math.min(1, Math.max(0, p));
  const up = curve === 'equal-power' ? Math.sin((x * Math.PI) / 2) : x;
  const down = curve === 'equal-power' ? Math.cos((x * Math.PI) / 2) : 1 - x;
  return kind === 'in' ? up : down;
};

export interface FadeSegment {
  kind: 'in' | 'out';
  from: number;
  to: number;
}

export const segments = (plan: FadePlan): FadeSegment[] => {
  const result: FadeSegment[] = [];
  if (plan.fadeIn !== null) {
    result.push({ kind: 'in', from: 0, to: plan.fadeIn });
  }
  if (plan.outStart !== null) {
    result.push({ kind: 'out', from: plan.outStart, to: plan.duration });
    result.push({
      kind: 'in',
      from: plan.duration,
      to: plan.duration + plan.recover,
    });
  }
  return result;
};

/** Gain the plan wants at song time t */
export const gainAt = (t: number, plan: FadePlan, curve: FadeCurve): number => {
  for (const seg of segments(plan)) {
    if (t >= seg.from && t < seg.to) {
      return curveValue(seg.kind, curve, (t - seg.from) / (seg.to - seg.from));
    }
  }
  return 1;
};

/** Samples for setValueCurveAtTime, covering progress p0..1 of a segment */
export const curveSamples = (
  kind: 'in' | 'out',
  curve: FadeCurve,
  p0: number,
): Float32Array => {
  const count = Math.max(2, Math.ceil(128 * (1 - p0)));
  const samples = new Float32Array(count);
  const step = (1 - p0) / (count - 1);
  for (let i = 0, p = p0; i < count; i++, p += step) {
    samples[i] = curveValue(kind, curve, p);
  }
  return samples;
};
