import { scaleFromFloorSamples, gridFractions, arScaleProblem, type FloorSample } from '../src/arScale.ts';
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
// Pinhole camera looking down from height h (m), tilted by t deg about x axis. Image W x H px, focal f px.
function sim(h: number, tDeg: number, noiseM = 0, W = 1080, H = 2340, f = 1900) {
  const t = tDeg * Math.PI / 180; const out: FloorSample[] = [];
  for (const { fx, fy } of gridFractions()) {
    const u = fx * W, v = fy * H;
    // ray in camera coords (x right, y down image, z forward)
    let dx = (u - W / 2) / f, dy = (v - H / 2) / f, dz = 1;
    // camera forward points down (-Y world); tilt rotates about x.
    // world: X = dx, Y = -(dz*cos t - dy*sin t), Z = dy*cos t + dz*sin t
    const X = dx, Y = -(dz * Math.cos(t) - dy * Math.sin(t)), Z = dy * Math.cos(t) + dz * Math.sin(t);
    const s = h / -Y; // hit floor y = 0 from camera at y = h
    const n = () => (rand() - 0.5) * 2 * noiseM;
    out.push({ px: { x: u, y: v }, world: [X * s + n(), n() * 0.3, Z * s + n()] });
  }
  return out;
}
import assert from 'node:assert/strict';

// Run: node --experimental-strip-types scripts/test-ar-scale.mts
const cases: [number, number, number, boolean][] = [
  // height m, tilt deg, noise m, should be accepted
  [1.0, 0, 0, true],
  [1.2, 0, 0, true],
  [1.0, 3, 0, true],
  [1.0, 0, 0.003, true],
  [1.0, 3, 0.005, true],
  [1.0, 0, 0.01, true],
  [1.0, 8, 0, false],
];
for (const [h, t, noise, ok] of cases) {
  const a = scaleFromFloorSamples(sim(h, t, noise))!;
  const truth = 1900 / (h * 100);
  const err = a.pxPerCm / truth - 1;
  console.log(`h=${h}m tilt=${t}° noise=${noise * 1000}mm -> ${a.pxPerCm.toFixed(2)} px/cm (truth ${truth.toFixed(2)}, ${(100 * err).toFixed(2)}%) problem=${arScaleProblem(a) ?? 'none'}`);
  if (ok) {
    assert.ok(Math.abs(err) < 0.01, 'scale error over 1%');
    assert.equal(arScaleProblem(a), null);
  } else {
    assert.notEqual(arScaleProblem(a), null);
  }
}
assert.equal(scaleFromFloorSamples([]), null);
assert.notEqual(arScaleProblem(null), null);
console.log('ok');

// Fusion: AR with a 25% absolute scale error + 3° tilt, A4 measured exactly at its own spot.
{
  const { fitScaleModel, fuseA4WithAr } = await import('../src/arScale.ts');
  const h = 1.5, t = 3, f = 1900, W = 1080, H = 2340;
  const truthAt = (v: number) => {
    // local px/cm at image row v for the simulated tilted camera (numerical: two rays 1 px apart)
    const pt = (u: number, vv: number) => {
      const tt = (t * Math.PI) / 180;
      const dx = (u - W / 2) / f, dy = (vv - H / 2) / f;
      const Y = -(Math.cos(tt) - dy * Math.sin(tt)), Z = dy * Math.cos(tt) + Math.sin(tt);
      const s = h / -Y;
      return [dx * s, Z * s];
    };
    // average of the vertical and horizontal local scale (pair estimates mix both directions)
    const a = pt(W / 2, v), b = pt(W / 2, v + 1), c = pt(W / 2 + 1, v);
    const sv = 1 / (100 * Math.hypot(a[0] - b[0], a[1] - b[1]));
    const sh = 1 / (100 * Math.hypot(a[0] - c[0], a[1] - c[1]));
    return Math.sqrt(sv * sh);
  };
  const wrong = sim(h, t).map((s) => ({ ...s, world: s.world.map((c) => c * 1.25) as [number, number, number] }));
  const model = fitScaleModel(wrong)!;
  const sheet = { x: 540, y: 1900 }, garment = { x: 540, y: 1000 };
  const fused = fuseA4WithAr(truthAt(sheet.y), sheet, garment, model)!;
  const errFused = fused.pxPerCm / truthAt(garment.y) - 1;
  const errA4Only = truthAt(sheet.y) / truthAt(garment.y) - 1;
  console.log(`fusion: A4-only ${(100 * errA4Only).toFixed(2)}%, fused ${(100 * errFused).toFixed(2)}%, AR correction ${fused.arCorrection.toFixed(3)}`);
  assert.ok(Math.abs(errFused) < 0.005, 'fused scale should be within 0.5%');
  assert.ok(Math.abs(fused.arCorrection - 1.25) < 0.02);
  console.log('fusion ok');
}
