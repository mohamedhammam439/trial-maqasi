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

/** px/cm as a linear function of photo position, fitted to the pair estimates at each pair's midpoint.
 *  When the phone isn't exactly parallel to the floor, the scale changes across the photo; AR measures
 *  that change well even when its absolute scale is off, because a uniform scale error cancels in ratios. */
export type ScaleModel = { a: number; bx: number; by: number; at: (x: number, y: number) => number };

export function fitScaleModel(samples: FloorSample[]): ScaleModel | null {
  const rows: [number, number, number][] = [];
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      const p = samples[i];
      const q = samples[j];
      const dpx = Math.hypot(p.px.x - q.px.x, p.px.y - q.px.y);
      const dcm = 100 * Math.hypot(p.world[0] - q.world[0], p.world[1] - q.world[1], p.world[2] - q.world[2]);
      if (dpx >= MIN_PAIR_PX && dcm > 0.5) rows.push([(p.px.x + q.px.x) / 2, (p.px.y + q.px.y) / 2, dpx / dcm]);
    }
  }
  if (rows.length < 6) return null;
  // Normal equations for r = a + bx*x + by*y.
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const t = [0, 0, 0];
  for (const [x, y, r] of rows) {
    const v = [1, x, y];
    for (let m = 0; m < 3; m++) {
      t[m] += v[m] * r;
      for (let n = 0; n < 3; n++) S[m][n] += v[m] * v[n];
    }
  }
  const sol = solve3(S, t);
  if (!sol) return null;
  const [a, bx, by] = sol;
  return { a, bx, by, at: (x, y) => a + bx * x + by * y };
}

function solve3(A: number[][], b: number[]): number[] | null {
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}

export type FusedScale = {
  pxPerCm: number;
  /** A4 scale / AR scale at the sheet: how far off AR's absolute scale was (1 = exact). */
  arCorrection: number;
  /** Fused scale / A4 scale: the perspective correction AR added (1 = none). */
  perspective: number;
};

/** A4 gives the absolute scale where the sheet lies; AR gives how the scale changes from the sheet
 *  to the garment. Fused scale at the garment = A4 scale x AR(garment) / AR(sheet). */
export function fuseA4WithAr(
  a4PxPerCm: number,
  a4Center: { x: number; y: number },
  garmentCenter: { x: number; y: number },
  model: ScaleModel,
): FusedScale | null {
  const atSheet = model.at(a4Center.x, a4Center.y);
  const atGarment = model.at(garmentCenter.x, garmentCenter.y);
  if (!(atSheet > 0) || !(atGarment > 0)) return null;
  const perspective = atGarment / atSheet;
  return { pxPerCm: a4PxPerCm * perspective, arCorrection: a4PxPerCm / atSheet, perspective };
}
