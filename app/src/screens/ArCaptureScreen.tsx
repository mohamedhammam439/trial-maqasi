import {
  ViroARScene,
  ViroARSceneNavigator,
  ViroTrackingStateConstants,
  isARSupportedOnDevice,
  type ViroARHitTestResult,
} from '@reactvision/react-viro';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, PixelRatio, Pressable, StyleSheet, Text, View } from 'react-native';

import { arScaleProblem, gridFractions, median, phoneMoved, scaleFromFloorSamples, type ArScale, type FloorSample } from '../arScale';
import { loadArTargetHeight, saveArTargetHeight } from '../arStorage';
import { C } from '../theme';
import { MAX_TILT_DEG, useTiltDeg } from './CaptureScreen';

/** A photo taken from the AR camera, with the scale measured from the floor at the same moment. */
export type ArShot = {
  uri: string;
  width: number;
  height: number;
  tiltDeg: number;
  takenAt: string;
  ar: ArScale & { distanceCm: number | null; debug?: ArDebug };
  /** Floor hits in photo pixels, for the AR + A4 fusion. */
  floor: FloorSample[];
};

/** Raw numbers to diagnose a wrong AR scale from the exported JSON. */
export type ArDebug = {
  viewPt: [number, number];
  pixelRatio: number;
  shotPx: [number, number];
  /** photo px per (view pt * pixelRatio). 1 means the screenshot is screen-sized. */
  k: number;
  /** Scale if Viro's hit-test coordinates were already photo pixels (i.e. without the k correction). */
  pxPerCmIfHitsInPhotoPx: number | null;
  hitTypes: Record<string, number>;
  gridPoints: number;
};

/** The phone must be within this many cm of the chosen height to take the shot (like the tilt limit). */
export const HEIGHT_TOL_CM = 3;
const HEIGHT_CHOICES = [120, 130, 140, 150, 160];

const FLOOR_TYPES =['ExistingPlaneUsingExtent', 'ExistingPlane', 'EstimatedHorizontalPlane'];

type SceneHooks = { onScene: (s: ViroARScene | null) => void; onTracking: (normal: boolean) => void };

/** The AR scene draws nothing: it is only there for tracking, floor detection and hit tests,
 *  so the screenshot is the plain camera image. */
function FloorScene(props: { sceneNavigator: { viroAppProps: SceneHooks } }) {
  const hooks = props.sceneNavigator.viroAppProps;
  return (
    <ViroARScene
      ref={(r) => hooks.onScene(r)}
      anchorDetectionTypes={['PlanesHorizontal']}
      onTrackingUpdated={(state) => hooks.onTracking(state === ViroTrackingStateConstants.TRACKING_NORMAL)}
    />
  );
}

function bestFloorHit(results: ViroARHitTestResult[] | null | undefined): ViroARHitTestResult | null {
  if (!results?.length) return null;
  for (const t of FLOOR_TYPES) {
    const hit = results.find((r) => r.type === t);
    if (hit) return hit;
  }
  return null;
}

const getSize = (uri: string) =>
  new Promise<{ width: number; height: number }>((resolve, reject) => Image.getSize(uri, (width, height) => resolve({ width, height }), reject));

export function ArCaptureScreen({ onShot, onBack }: { onShot: (s: ArShot) => void; onBack: () => void }) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [unsupportedWhy, setUnsupportedWhy] = useState('');
  const [tracking, setTracking] = useState(false);
  const [floorCm, setFloorCm] = useState<number | null>(null);
  const [view, setView] = useState({ w: 0, h: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sceneRef = useRef<ViroARScene | null>(null);
  const hitTypes = useRef<Record<string, number>>({});
  const navRef = useRef<ViroARSceneNavigator | null>(null);
  const tilt = useTiltDeg();
  const level = tilt <= MAX_TILT_DEG;
  const pr = PixelRatio.get();
  const [targetCm, setTargetCm] = useState<number | null>(null);
  useEffect(() => {
    loadArTargetHeight().then(setTargetCm);
  }, []);
  const chooseTarget = (cm: number) => {
    setTargetCm(cm);
    saveArTargetHeight(cm);
  };
  const heightOff = targetCm != null && floorCm != null && floorCm > 0 ? floorCm - targetCm : null;
  // floorCm === 0 means the floor is found but AR can't report the camera height: don't block on it.
  const heightUnknown = targetCm != null && floorCm === 0;
  const atHeight = heightUnknown || (heightOff != null && Math.abs(heightOff) <= HEIGHT_TOL_CM);

  useEffect(() => {
    isARSupportedOnDevice()
      .then((r) => setSupported(r.isARSupported))
      .catch((e) => {
        setSupported(false);
        setUnsupportedWhy(String(e?.message ?? e));
      });
  }, []);

  /** Hit test at a point given as fractions of the AR view. Viro takes view pixels (not points). */
  const hitAt = async (fx: number, fy: number) => {
    const scene = sceneRef.current;
    if (!scene || !view.w) return null;
    try {
      return bestFloorHit(await scene.performARHitTestWithPoint(Math.round(fx * view.w * pr), Math.round(fy * view.h * pr)));
    } catch {
      return null;
    }
  };

  const cameraHeight = async (): Promise<number | null> => {
    try {
      const p: any = await sceneRef.current?.getCameraPositionAsync();
      const pos = Array.isArray(p) ? p : Array.isArray(p?.position) ? p.position : null;
      if (pos && typeof pos[1] === 'number') return pos[1];
      const o: any = await sceneRef.current?.getCameraOrientationAsync();
      return Array.isArray(o?.position) && typeof o.position[1] === 'number' ? o.position[1] : null;
    } catch {
      return null;
    }
  };

  // Live floor check at the centre, so the user knows when the floor has been found.
  useEffect(() => {
    if (!tracking || !view.w) return;
    let alive = true;
    const id = setInterval(async () => {
      const [hit, camY] = await Promise.all([hitAt(0.5, 0.5), cameraHeight()]);
      if (!alive) return;
      setFloorCm(hit && camY != null ? Math.round((camY - hit.transform.position[1]) * 100) : hit ? 0 : null);
    }, 600);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracking, view.w, view.h]);

  /** Grid of floor hits, in photo pixels (k = photo px per view px). */
  const sampleFloor = async (k: number): Promise<FloorSample[]> => {
    const grid = gridFractions();
    const hits = await Promise.all(grid.map((g) => hitAt(g.fx, g.fy)));
    const out: FloorSample[] = [];
    hits.forEach((h, i) => {
      if (!h) return;
      hitTypes.current[h.type] = (hitTypes.current[h.type] ?? 0) + 1;
      const p = h.transform.position;
      out.push({ px: { x: grid[i].fx * view.w * pr * k, y: grid[i].fy * view.h * pr * k }, world: [p[0], p[1], p[2]] });
    });
    return out;
  };

  const ready = supported && tracking && floorCm != null && level && atHeight && !busy;

  const take = async () => {
    if (!ready || !navRef.current) return;
    setBusy(true);
    setError(null);
    try {
      const tiltAtShot = Math.round(tilt * 10) / 10;
      hitTypes.current = {};
      const before = await sampleFloor(1);
      const shot = await navRef.current.arSceneNavigator.takeScreenshot(`maqasi_ar_${Date.now()}`, false);
      const after = await sampleFloor(1);
      const camY = await cameraHeight();
      if (!shot?.success || !shot.url) throw new Error('مقدرناش ناخد الصورة من الـ AR. جرب تاني.');
      const uri = shot.url.startsWith('file://') ? shot.url : `file://${shot.url}`;
      const size = await getSize(uri);

      // The screenshot may not be exactly view-pixel sized; rescale the sample positions to photo pixels.
      const k = size.width / (view.w * pr);
      if (Math.abs(size.height / (view.h * pr) - k) / k > 0.02) {
        throw new Error('مقاس صورة الـ AR مش متطابق مع الشاشة. ابعت الملاحظة دي للمطوّر.');
      }
      const scale = (xs: FloorSample[]) => xs.map((s) => ({ ...s, px: { x: s.px.x * k, y: s.px.y * k } }));
      const a = scaleFromFloorSamples(scale(before));
      const b = scaleFromFloorSamples(scale(after));
      const problem = arScaleProblem(a) ?? arScaleProblem(b);
      if (problem) throw new Error(problem);
      if (phoneMoved(a!, b!)) throw new Error('الموبايل اتحرك وقت التصوير. ثبّته وجرب تاني.');

      const floorY = median([...before, ...after].map((s) => s.world[1]));
      const merged = scaleFromFloorSamples(scale([...before, ...after]))!;
      onShot({
        uri,
        width: size.width,
        height: size.height,
        tiltDeg: tiltAtShot,
        takenAt: new Date().toISOString(),
        floor: scale([...before, ...after]),
        ar: {
          ...merged,
          distanceCm: camY != null ? Math.round((camY - floorY) * 1000) / 10 : null,
          debug: {
            viewPt: [view.w, view.h],
            pixelRatio: pr,
            shotPx: [size.width, size.height],
            k,
            pxPerCmIfHitsInPhotoPx: scaleFromFloorSamples([...before, ...after])?.pxPerCm ?? null,
            hitTypes: hitTypes.current,
            gridPoints: 2 * gridFractions().length,
          },
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (supported === null) {
    return (
      <View style={[s.root, s.center]}>
        <ActivityIndicator color={C.petrol} />
      </View>
    );
  }
  if (!supported) {
    return (
      <View style={[s.root, s.center]}>
        <Text style={s.title}>الموبايل ده مش بيدعم الـ AR</Text>
        <Text style={s.sub}>محتاج موبايل بيدعم ARCore (أندرويد) أو ARKit (آيفون).{unsupportedWhy ? `\n${unsupportedWhy}` : ''}</Text>
        <Pressable onPress={onBack} style={s.ghost}><Text style={s.ghostText}>رجوع</Text></Pressable>
      </View>
    );
  }

  const status = !tracking
    ? 'حرّك الموبايل ببطء فوق الأرضية عشان الـ AR يبدأ'
    : floorCm == null
      ? 'لسه بندوّر على الأرضية… حرّك الموبايل شوية'
      : !level
        ? `ميّل الموبايل لحد ما يبقى موازي للأرض (${tilt.toFixed(1)}°)`
        : targetCm == null
          ? `اختار ارتفاع ثابت للموبايل من تحت (دلوقتي ${floorCm} سم)`
          : heightUnknown
            ? 'الـ AR مش قادر يقيس ارتفاع الموبايل — صوّر من نفس الارتفاع بتاع كل مرة'
            : heightOff == null
            ? 'لسه بنقيس ارتفاع الموبايل… ثبّته شوية'
            : !atHeight
              ? `${heightOff > 0 ? 'نزّل' : 'ارفع'} الموبايل ${Math.abs(heightOff)} سم (دلوقتي ${floorCm} · المطلوب ${targetCm})`
              : `الارتفاع ${floorCm} سم والميل ${tilt.toFixed(1)}° — صوّر`;

  return (
    <View style={s.root}>
      <View style={StyleSheet.absoluteFill} onLayout={(e) => setView({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
        <ViroARSceneNavigator
          ref={navRef}
          style={StyleSheet.absoluteFill}
          autofocus
          worldAlignment="Gravity"
          videoQuality="High"
          initialScene={{ scene: FloorScene as unknown as () => React.JSX.Element }}
          viroAppProps={{ onScene: (r: ViroARScene | null) => (sceneRef.current = r), onTracking: setTracking } satisfies SceneHooks}
        />
      </View>

      <View style={s.header} pointerEvents="box-none">
        <Pressable onPress={onBack} style={s.back} accessibilityLabel="رجوع">
          <Text style={{ fontSize: 18, color: C.text }}>›</Text>
        </Pressable>
        <View style={[s.pill, { backgroundColor: ready ? 'rgba(30,122,82,0.92)' : 'rgba(20,18,16,0.75)' }]}>
          <Text style={s.pillText}>{status}</Text>
        </View>
        <View style={{ width: 44 }} />
      </View>

      <View style={s.footer} pointerEvents="box-none">
        {error && <Text style={s.error}>{error}</Text>}
        <View style={s.heightRow}>
          {floorCm != null && floorCm > 0 && (
            <Pressable onPress={() => chooseTarget(floorCm)} style={s.chip} accessibilityLabel="ثبّت الارتفاع الحالي">
              <Text style={s.chipText}>ثبّت الحالي</Text>
            </Pressable>
          )}
          {HEIGHT_CHOICES.map((cm) => (
            <Pressable key={cm} onPress={() => chooseTarget(cm)} style={[s.chip, targetCm === cm && s.chipOn]} accessibilityLabel={`ارتفاع ${cm} سم`}>
              <Text style={[s.chipText, targetCm === cm && { color: C.text }]}>{cm}</Text>
            </Pressable>
          ))}
        </View>
        {targetCm != null && !HEIGHT_CHOICES.includes(targetCm) && (
          <Text style={s.pillText}>الارتفاع المطلوب: {targetCm} سم ±{HEIGHT_TOL_CM}</Text>
        )}
        <Pressable
          onPress={take}
          disabled={!ready}
          accessibilityLabel="التقاط صورة بالـ AR"
          style={[s.shutter, { borderColor: ready ? '#FFFFFF' : 'rgba(255,255,255,0.4)' }]}
        >
          {busy ? <ActivityIndicator color="#FFFFFF" /> : <View style={[s.shutterInner, { backgroundColor: ready ? '#FFFFFF' : 'rgba(255,255,255,0.3)' }]} />}
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8, backgroundColor: C.bg },
  header: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 16, paddingTop: 56 },
  back: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 17, fontWeight: '600', color: C.text, textAlign: 'center' },
  sub: { fontSize: 14, color: C.text2, textAlign: 'center' },
  pill: { flex: 1, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
  pillText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600', textAlign: 'center' },
  footer: { position: 'absolute', bottom: 0, left: 0, right: 0, alignItems: 'center', gap: 12, paddingBottom: 40, paddingHorizontal: 16 },
  error: { color: C.bad, backgroundColor: C.badBg, padding: 12, borderRadius: 12, textAlign: 'right', alignSelf: 'stretch' },
  shutter: { width: 76, height: 76, borderRadius: 38, borderWidth: 4, alignItems: 'center', justifyContent: 'center' },
  shutterInner: { width: 60, height: 60, borderRadius: 30 },
  heightRow: { flexDirection: 'row-reverse', flexWrap: 'wrap', justifyContent: 'center', gap: 6 },
  chip: { minWidth: 44, height: 36, paddingHorizontal: 10, borderRadius: 18, backgroundColor: 'rgba(20,18,16,0.75)', alignItems: 'center', justifyContent: 'center' },
  chipOn: { backgroundColor: '#FFFFFF' },
  chipText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
  ghost: { height: 44,alignItems: 'center', justifyContent: 'center' },
  ghostText: { color: C.goldText, fontSize: 15, fontWeight: '600' },
});
