/** Scale (pixels per cm) of an AR photo, from floor hit tests.
 *
 *  At capture we hit-test a grid of screen points against the detected floor plane. Each hit gives the
 *  3D point (metres) under that pixel, so for any two hits:  px/cm = pixel distance / world distance (cm).
 *  We take the median over all pairs, which is robust to a few bad hits. Pure functions only, so this
 *  file can be tested without a phone. */

export type Vec3 = [number, number, number];

/** One floor hit: where it is in the photo (photo pixels) and in the world (metres). */
export type FloorSample = { px: { x: number; y: number }; world: Vec3 };

export type ArScale = {
  pxPerCm: number;
  /** Relative spread of the pair estimates (IQR / median). Small = consistent floor and steady phone. */
  spread: number;
  /** (top-of-photo scale - bottom-of-photo scale) / scale. Non-zero means the phone isn't parallel to the floor. */
  topBottomDiff: number;
  /** Highest minus lowest floor point (cm). Large = hits landed on different surfaces. */
  floorHeightRangeCm: number;
  samples: number;
};

/** Minimum pixel distance between two samples for a pair to count (short pairs are noisy). */
const MIN_PAIR_PX = 80;

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

function pairRatios(samples: FloorSample[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      const a = samples[i];
      const b = samples[j];
      const dpx = Math.hypot(a.px.x - b.px.x, a.px.y - b.px.y);
      const dcm = 100 * Math.hypot(a.world[0] - b.world[0], a.world[1] - b.world[1], a.world[2] - b.world[2]);
      if (dpx >= MIN_PAIR_PX && dcm > 0.5) out.push(dpx / dcm);
    }
  }
  return out;
}

export function scaleFromFloorSamples(samples: FloorSample[]): ArScale | null {
  if (samples.length < 4) return null;
  const ratios = pairRatios(samples);
  if (ratios.length < 6) return null;
  const pxPerCm = median(ratios);

  const ys = samples.map((s) => s.px.y);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const third = (yMax - yMin) / 3;
  const top = pairRatios(samples.filter((s) => s.px.y <= yMin + third));
  const bottom = pairRatios(samples.filter((s) => s.px.y >= yMax - third));
  const topBottomDiff = top.length && bottom.length ? (median(top) - median(bottom)) / pxPerCm : 0;

  // World is gravity-aligned (Viro worldAlignment "Gravity"), so y is height.
  const heights = samples.map((s) => s.world[1]);
  return {
    pxPerCm,
    spread: (quantile(ratios, 0.75) - quantile(ratios, 0.25)) / pxPerCm,
    topBottomDiff,
    floorHeightRangeCm: 100 * (Math.max(...heights) - Math.min(...heights)),
    samples: samples.length,
  };
}

/** Grid of screen points (fractions of the view) to hit-test: n x n over the central part of the view. */
export function gridFractions(n = 5, margin = 0.12): { fx: number; fy: number }[] {
  const out: { fx: number; fy: number }[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      out.push({ fx: margin + ((1 - 2 * margin) * c) / (n - 1), fy: margin + ((1 - 2 * margin) * r) / (n - 1) });
    }
  }
  return out;
}

/** Why an AR scale shouldn't be trusted, or null if it looks fine. Messages are user-facing. */
export function arScaleProblem(a: ArScale | null): string | null {
  if (!a) return 'الأرضية مش متحددة كفاية. حرّك الموبايل ببطء فوق الأرضية لحد ما يلاقيها، وجرب تاني.';
  if (Math.abs(a.topBottomDiff) > 0.09) return 'الموبايل مش موازي للأرض كفاية. عدّل الميل وجرب تاني.';
  if (a.floorHeightRangeCm > 2) return 'نقط الأرضية مش على نفس المستوى. اتأكد إن الأرضية مستوية ومفيش حاجة عالية في الكادر.';
  if (a.spread > 0.04) return 'قياس الأرضية مش ثابت. ثبّت الموبايل وجرب تاني.';
  return null;
}

/** Two estimates taken just before and after the photo should agree, otherwise the phone moved. */
export function phoneMoved(before: ArScale, after: ArScale, tol = 0.015): boolean {
  return Math.abs(before.pxPerCm - after.pxPerCm) / before.pxPerCm > tol;
}
