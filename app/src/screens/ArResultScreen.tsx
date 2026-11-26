import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Svg, { Circle, Line as SvgLine, Polygon } from 'react-native-svg';

import { measure } from '../api';
import { fitScaleModel, fuseA4WithAr, type FusedScale } from '../arScale';
import { saveArRecord } from '../arStorage';
import { C, MEASUREMENT_LABELS } from '../theme';
import type { MeasureResponse } from '../types';
import type { ArShot } from './ArCaptureScreen';

type Props = { shot: ArShot; serverUrl: string; onBack: () => void; onDone: () => void };

const num = (v: string | undefined) => {
  const x = parseFloat((v ?? '').replace(',', '.'));
  return Number.isFinite(x) ? x : null;
};
const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'حصل خطأ في الاتصال بالسيرفر.');

function DiffText({ value, truth }: { value: number | undefined; truth: number | null }) {
  if (value == null) return <Text style={[s.value, { flex: 1 }]}>—</Text>;
  const diff = truth == null ? null : value - truth;
  return (
    <View style={{ flex: 1, alignItems: 'center' }}>
      <Text style={s.value}>{value.toFixed(1)}</Text>
      {diff != null && (
        <Text style={[s.diff, { color: Math.abs(diff) <= 1 ? C.good : Math.abs(diff) <= 2 ? C.warn : C.bad }]}>
          {diff > 0 ? '+' : ''}{diff.toFixed(1)}
        </Text>
      )}
    </View>
  );
}

/** Max spread (cm) between the frames of one shot for chest, hem and length before it's flagged. */
const MAX_FRAME_SPREAD_CM = 0.5;
const CORE_KEYS = ['chest_width', 'hem_width', 'body_length'];

const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Median over frames: px/cm and each measurement; keeps frame 1's lines and reference for drawing.
 *  spread = max - min per measurement. */
function medianOfFrames(frames: MeasureResponse[]): { res: MeasureResponse; spread: Record<string, number> } {
  const first = frames[0];
  const measurements: Record<string, number> = {};
  const spread: Record<string, number> = {};
  for (const key of Object.keys(first.measurements_cm)) {
    const xs = frames.map((f) => f.measurements_cm[key]).filter((v) => v != null);
    measurements[key] = Math.round(med(xs) * 10) / 10;
    spread[key] = Math.round((Math.max(...xs) - Math.min(...xs)) * 10) / 10;
  }
  return { res: { ...first, px_per_cm: med(frames.map((f) => f.px_per_cm)), measurements_cm: measurements }, spread };
}

/** Centre of the garment from the measurement lines (photo px). */
function garmentCenter(r: MeasureResponse) {
  const pts = r.lines.filter((l) => l.confidence === 'high').flatMap((l) => [l.a, l.b]);
  if (!pts.length) return null;
  return { x: pts.reduce((t, p) => t + p.x, 0) / pts.length, y: pts.reduce((t, p) => t + p.y, 0) / pts.length };
}

/** Measures the AR photo three ways and compares each with the tape-measured garment:
 *  - AR only: the AR floor scale.
 *  - A4 only: the sheet in the photo (found automatically by the server).
 *  - AR + A4: A4's absolute scale, moved from the sheet to the garment with AR's perspective. */
/** AR vs A4 scale gap (fraction) above which the gap is shown, for the record. */
const AR_A4_MAX_GAP = 0.04;

export function ArResultScreen({ shot, serverUrl, onBack, onDone }: Props) {
  const [boxW, setBoxW] = useState(0);
  const [arRes, setArRes] = useState<MeasureResponse | null>(null);
  const [a4Res, setA4Res] = useState<MeasureResponse | null>(null);
  const [a4Error, setA4Error] = useState<string | null>(null);
  const [fused, setFused] = useState<FusedScale | null>(null);
  const [fusedRes, setFusedRes] = useState<MeasureResponse | null>(null);
  /** Multi-frame: number of frames in the sheet median and the per-measurement spread. */
  const [frameInfo, setFrameInfo] = useState<{ n: number; spread: Record<string, number> } | null>(null);
  const sheetKind = shot.sheet ?? 'a4';
  const sheetLabel = sheetKind === 'aruco' ? 'ArUco' : 'A4';
  const [truth, setTruth] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const boxH = boxW ? (boxW * shot.height) / shot.width : 0;
  const k = boxW ? shot.width / boxW : 1; // display px -> image px
  // Sleeve set by hand (photo px): from the shoulder seam on top of the sleeve to the end of the sleeve.
  const [sleeve, setSleeve] = useState<{ a: { x: number; y: number }; b: { x: number; y: number } } | null>(null);
  const [placing, setPlacing] = useState<'a' | 'b' | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // A4 first: its corners are then left out of the garment on the AR and fused calls too.
        let a4: MeasureResponse | null = null;
        try {
          a4 = await measure(serverUrl, shot.uri, { type: sheetKind });
        } catch (e) {
          if (alive) setA4Error(errMsg(e));
        }
        if (!alive) return;
        // Multi-frame: measure the extra photos with the sheet too and take the median per measurement.
        if (a4 && shot.frames?.length) {
          const all = [a4];
          for (const f of shot.frames) {
            try {
              all.push(await measure(serverUrl, f.uri, { type: sheetKind }));
            } catch {
              // a frame where the sheet or garment wasn't found just drops out of the median
            }
            if (!alive) return;
          }
          if (all.length > 1) {
            const m = medianOfFrames(all);
            a4 = m.res;
            setFrameInfo({ n: all.length, spread: m.spread });
          }
        }
        if (a4) setA4Res(a4);
        const corners = a4?.reference?.corners;
        const exclude = corners ? [corners] : undefined;
        const ar = await measure(serverUrl, shot.uri, { type: 'px_per_cm', pxPerCm: shot.ar.pxPerCm }, exclude);
        if (!alive) return;
        setArRes(ar);
        if (!a4 || !corners) return;
        const model = fitScaleModel(shot.floor ?? []);
        const center = garmentCenter(ar);
        if (!model || !center) return;
        const sheet = { x: corners.reduce((t, c) => t + c[0], 0) / 4, y: corners.reduce((t, c) => t + c[1], 0) / 4 };
        const f = fuseA4WithAr(a4.px_per_cm, sheet, center, model);
        if (!f) return;
        setFused(f);
        const fr = await measure(serverUrl, shot.uri, { type: 'px_per_cm', pxPerCm: f.pxPerCm }, exclude);
        if (alive) setFusedRes(fr);
      } catch (e) {
        if (alive) setError(errMsg(e));
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [serverUrl, shot, sheetKind]);

  const keys = Object.keys(arRes?.measurements_cm ?? {});

  // Start the hand-set sleeve from the server's guess, once there is one.
  const guess = (fusedRes ?? a4Res ?? arRes)?.lines.find((l) => l.name === 'sleeve_length');
  const sl = sleeve ?? (guess ? { a: guess.a, b: guess.b } : null);
  const sleevePx = sl ? Math.hypot(sl.b.x - sl.a.x, sl.b.y - sl.a.y) : null;
  /** A method's measurements, with the sleeve replaced by the hand-set one (same scale). */
  const withSleeve = (r: MeasureResponse | null): Record<string, number> | undefined => {
    if (!r) return undefined;
    if (!sleeve || sleevePx == null) return r.measurements_cm;
    return { ...r.measurements_cm, sleeve_length: Math.round((sleevePx / r.px_per_cm) * 10) / 10 };
  };
  const onImagePress = (x: number, y: number) => {
    if (!placing || !sl) return;
    const p = { x: x * k, y: y * k };
    setSleeve(placing === 'a' ? { a: p, b: sl.b } : { a: sl.a, b: p });
    setPlacing(null);
  };

  const save = async () => {
    if (!arRes) return;
    const parsed: Record<string, number | null> = {};
    for (const key of keys) parsed[key] = num(truth[key]);
    await saveArRecord({
      id: `${Date.now()}`,
      takenAt: shot.takenAt,
      tiltDeg: shot.tiltDeg,
      ar: {
        pxPerCm: shot.ar.pxPerCm,
        distanceCm: shot.ar.distanceCm,
        debug: shot.ar.debug,
        spread: shot.ar.spread,
        topBottomDiff: shot.ar.topBottomDiff,
        samples: shot.ar.samples,
      },
      tape: null,
      scaleDiffPct: null,
      a4: a4Res ? { pxPerCm: a4Res.px_per_cm, detected: !!a4Res.reference?.detected } : null,
      fused,
      sheet: sheetKind,
      frames: frameInfo ? { n: frameInfo.n, maxSpreadCm: Math.max(...CORE_KEYS.map((k) => frameInfo.spread[k] ?? 0)) } : null,
      measuredAr: withSleeve(arRes)!,
      measuredA4: withSleeve(a4Res) ?? null,
      measuredFused: withSleeve(fusedRes) ?? null,
      measuredTape: null,
      truth: parsed,
      note: sleeve ? `${note}${note ? ' · ' : ''}الكم متحدد باليد` : note,
    });
    setSaved(true);
  };

  // Draw the lines of the best result we have.
  const shown = fusedRes ?? a4Res ?? arRes;
  const sheetCorners = a4Res?.reference?.corners;
  /** AR vs A4 scale on the same photo. They should agree within a few %; a bigger gap means one of them is off. */
  const arA4Gap = a4Res ? shot.ar.pxPerCm / a4Res.px_per_cm - 1 : null;

  return (
    <ScrollView style={s.root} contentContainerStyle={{ padding: 16, paddingTop: 56, gap: 14 }}>
      <View style={s.header}>
        <Pressable onPress={onBack} style={s.back} accessibilityLabel="رجوع">
          <Text style={{ fontSize: 18, color: C.text }}>›</Text>
        </Pressable>
        <Text style={s.title}>القياس بورقة {sheetLabel}</Text>
        <View style={{ width: 44 }} />
      </View>

      <View style={s.card}>
        <Text style={s.label}>مقياس الـ AR: {shot.ar.pxPerCm.toFixed(2)} px/cm</Text>
        {a4Res && <Text style={s.label}>مقياس الـ {sheetLabel}: {a4Res.px_per_cm.toFixed(2)} px/cm</Text>}
        {frameInfo && (
          <Text style={s.sub}>
            الوسيط من {frameInfo.n} لقطات · أكبر فرق بينهم{' '}
            {Math.max(...CORE_KEYS.map((k) => frameInfo.spread[k] ?? 0)).toFixed(1)} سم
          </Text>
        )}
        {frameInfo && Math.max(...CORE_KEYS.map((k) => frameInfo.spread[k] ?? 0)) > MAX_FRAME_SPREAD_CM && (
          <Text style={s.warn}>اللقطات مختلفة عن بعض أكتر من نص سم. غالباً الموبايل اتحرك وقت التصوير. صوّر تاني.</Text>
        )}
        {fused && (
          <Text style={s.label}>
            المدمج: {fused.pxPerCm.toFixed(2)} px/cm · غلط الـ AR {((1 / fused.arCorrection - 1) * 100).toFixed(0)}% · تصحيح الميل{' '}
            {((fused.perspective - 1) * 100).toFixed(1)}%
          </Text>
        )}
        {arA4Gap != null && Math.abs(arA4Gap) > AR_A4_MAX_GAP && (
          <Text style={s.sub}>
            الـ AR مختلف عن الـ {sheetLabel} بـ {(arA4Gap * 100).toFixed(1)}%. القياس بيعتمد على الورقة، فده مش بيأثر على النتيجة.
          </Text>
        )}
        {shot.arProblem && <Text style={s.sub}>ملاحظة على الـ AR: {shot.arProblem}</Text>}
        <Text style={s.sub}>
          بُعد الموبايل عن الأرض: {shot.ar.distanceCm != null ? `${shot.ar.distanceCm} سم` : 'مش معروف'} · الميل {shot.tiltDeg}° · ثبات القياس ±
          {(shot.ar.spread * 100).toFixed(1)}%
        </Text>
      </View>

      <View style={{ width: '100%' }} onLayout={(e) => setBoxW(e.nativeEvent.layout.width)}>
        {boxW > 0 && (
          <Pressable
            style={{ width: boxW, height: boxH }}
            disabled={!placing}
            onPress={(e) => onImagePress(e.nativeEvent.locationX, e.nativeEvent.locationY)}
          >
            <Image source={{ uri: shot.uri }} style={{ width: boxW, height: boxH, borderRadius: 16 }} />
            <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
              {sheetCorners && (
                <Polygon points={sheetCorners.map((c) => `${c[0] / k},${c[1] / k}`).join(' ')} fill="none" stroke={C.gold} strokeWidth={2.5} />
              )}
              {sl && (
                <>
                  <SvgLine x1={sl.a.x / k} y1={sl.a.y / k} x2={sl.b.x / k} y2={sl.b.y / k} stroke={sleeve ? C.petrol : C.warn} strokeWidth={3} />
                  <Circle cx={sl.a.x / k} cy={sl.a.y / k} r={placing === 'a' ? 9 : 6} fill="#FFFFFF" stroke={C.petrol} strokeWidth={2.5} />
                  <Circle cx={sl.b.x / k} cy={sl.b.y / k} r={placing === 'b' ? 9 : 6} fill={C.petrol} stroke="#FFFFFF" strokeWidth={2} />
                </>
              )}
              {shown?.lines.filter((ln) => ln.name !== 'sleeve_length').map((ln) => (
                <SvgLine
                  key={ln.name}
                  x1={ln.a.x / k} y1={ln.a.y / k} x2={ln.b.x / k} y2={ln.b.y / k}
                  stroke={ln.confidence === 'high' ? C.petrol : C.warn}
                  strokeWidth={3}
                  strokeDasharray={ln.confidence === 'high' ? undefined : '6 4'}
                />
              ))}
              {shown?.lines.filter((ln) => ln.name !== 'sleeve_length').flatMap((ln) => [ln.a, ln.b].map((p, i) => (
                <Circle key={`${ln.name}${i}`} cx={p.x / k} cy={p.y / k} r={5} fill={C.gold} stroke="#FFFFFF" strokeWidth={1.5} />
              )))}
            </Svg>
          </Pressable>
        )}
      </View>

      {sl && (
        <View style={s.card}>
          <Text style={s.label}>طول الكم: من خياطة الكتف فوق الكم (النقطة البيضا) لآخر الكم (النقطة الغامقة).</Text>
          <View style={s.sleeveRow}>
            <Pressable onPress={() => setPlacing(placing === 'a' ? null : 'a')} style={[s.chip, placing === 'a' && s.chipOn]}>
              <Text style={[s.chipText, placing === 'a' && { color: '#FFFFFF' }]}>حدّد الخياطة</Text>
            </Pressable>
            <Pressable onPress={() => setPlacing(placing === 'b' ? null : 'b')} style={[s.chip, placing === 'b' && s.chipOn]}>
              <Text style={[s.chipText, placing === 'b' && { color: '#FFFFFF' }]}>حدّد آخر الكم</Text>
            </Pressable>
            {sleeve && (
              <Pressable onPress={() => setSleeve(null)} style={s.chip}>
                <Text style={s.chipText}>رجّع تخمين السيرفر</Text>
              </Pressable>
            )}
          </View>
          {placing && <Text style={s.sub}>اضغط على الصورة في المكان الصح.</Text>}
        </View>
      )}

      {error && <Text style={s.error}>{error}</Text>}
      {a4Error && <Text style={s.warn}>ورقة الـ {sheetLabel}: {a4Error}</Text>}
      {busy && <ActivityIndicator color={C.petrol} />}
      {arRes?.warnings.map((w) => <Text key={w} style={s.warn}>{w}</Text>)}

      {arRes && (
        <View style={s.card}>
          <View style={s.headRow}>
            <Text style={s.colHead}>AR</Text>
            <Text style={[s.colHead, { color: C.text, fontWeight: '700' }]}>{sheetLabel}</Text>
            <Text style={s.colHead}>AR+{sheetLabel}</Text>
            <Text style={s.colHead}>بالمتر</Text>
            <Text style={[s.colHead, { flex: 1.1, textAlign: 'right' }]}>القياس</Text>
          </View>
          {keys.map((key) => {
            const t = num(truth[key]);
            return (
              <View key={key} style={s.row}>
                <DiffText value={withSleeve(arRes)?.[key]} truth={t} />
                <DiffText value={withSleeve(a4Res)?.[key]} truth={t} />
                <DiffText value={withSleeve(fusedRes)?.[key]} truth={t} />
                <TextInput
                  value={truth[key] ?? ''}
                  onChangeText={(v) => setTruth((p) => ({ ...p, [key]: v }))}
                  keyboardType="decimal-pad"
                  placeholder="—"
                  placeholderTextColor={C.muted}
                  style={s.input}
                  accessibilityLabel={`قياس ${MEASUREMENT_LABELS[key] ?? key} بالمتر`}
                />
                <Text style={[s.label, { flex: 1.1, fontSize: 13 }]}>{MEASUREMENT_LABELS[key] ?? key}</Text>
              </View>
            );
          })}
        </View>
      )}

      <TextInput value={note} onChangeText={setNote} placeholder="ملاحظة (الأرضية، الإضاءة، الموبايل...)" placeholderTextColor={C.muted} style={s.note} multiline />

      {saved ? (
        <Pressable onPress={onDone} style={s.btn}><Text style={s.btnText}>اتحفظ — رجوع لصفحة الـ AR</Text></Pressable>
      ) : (
        <Pressable onPress={save} disabled={!arRes || busy} style={[s.btn, (!arRes || busy) && { opacity: 0.4 }]}><Text style={s.btnText}>احفظ النتيجة</Text></Pressable>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' },
  back: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 18, fontWeight: '600', color: C.text },
  sub: { fontSize: 14, lineHeight: 22, color: C.text2, textAlign: 'right' },
  card: { backgroundColor: C.surface, borderRadius: 24, padding: 14, gap: 6, borderWidth: 1, borderColor: '#F0F2F2' },
  label: { fontSize: 14, color: C.text, textAlign: 'right' },
  warn: { color: C.warn, backgroundColor: C.warnBg, padding: 10, borderRadius: 12, textAlign: 'right' },
  error: { color: C.bad, backgroundColor: C.badBg, padding: 12, borderRadius: 12, textAlign: 'right' },
  headRow: { flexDirection: 'row', paddingBottom: 8 },
  colHead: { flex: 1, fontSize: 12, color: C.muted, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderTopWidth: 1, borderTopColor: C.border },
  value: { fontSize: 15, fontWeight: '600', color: C.text, textAlign: 'center' },
  diff: { fontSize: 11, fontWeight: '600' },
  input: { flex: 1, height: 42, marginHorizontal: 3, borderRadius: 10, borderWidth: 1.5, borderColor: C.borderStrong, textAlign: 'center', fontSize: 15, color: C.text, backgroundColor: C.surface },
  note: { minHeight: 60, borderRadius: 14, borderWidth: 1.5, borderColor: C.borderStrong, backgroundColor: C.surface, padding: 12, textAlign: 'right', color: C.text },
  sleeveRow: { flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 8 },
  chip: { height: 38, paddingHorizontal: 14, borderRadius: 19, borderWidth: 1.5, borderColor: C.petrol, alignItems: 'center', justifyContent: 'center' },
  chipOn: { backgroundColor: C.petrol },
  chipText: { color: C.petrol, fontSize: 13, fontWeight: '600' },
  btn: { height: 54, borderRadius: 16, backgroundColor: C.petrol, alignItems: 'center', justifyContent: 'center' },
  btnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
});
