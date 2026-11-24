import { useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Svg, { Circle, Line as SvgLine, Polygon } from 'react-native-svg';

import { measure } from '../api';
import { C } from '../theme';
import type { MeasureResponse, Pt, ReferenceKind, Scale, ScaleInfo, Shot } from '../types';

type Props = {
  shot: Shot;
  serverUrl: string;
  onBack: () => void;
  onResult: (r: MeasureResponse, scale: ScaleInfo) => void;
};

type Option = { kind: ReferenceKind; label: string; hint: string; size?: [number, number] };

/** Objects the user can lay next to the garment for scale. Sizes in cm (long, short). */
export const REFERENCES: Option[] = [
  {
    kind: 'tape',
    label: 'متر',
    hint: 'اضغط على نقطتين معروف المسافة بينهم، مثلاً علامة 0 وعلامة 50 على متر مفرود جنب القطعة.',
  },
  {
    kind: 'a4',
    label: 'ورقة A4',
    size: [29.7, 21.0],
    hint: 'حط ورقة A4 مفرودة على الأرض جنب القطعة (مش فوقها). سيب الأركان فاضية ومقاسي هيلاقي الورقة لوحده، أو اضغط على أركانها الأربعة.',
  },
  {
    kind: 'card',
    label: 'كارت بنكي',
    size: [8.56, 5.4],
    hint: 'أي كارت بمقاس الفيزا (8.56 × 5.4 سم): كارت بنك، بطاقة، كارت مواصلات. حطه مفرود لازق في القطعة جنب الصدر.',
  },
  {
    kind: 'rect',
    label: 'حاجة تانية',
    hint: 'أي حاجة مستطيلة ومفرودة معروف مقاسها (كتاب، كيس، بلاطة). اكتب طولها وعرضها، وحطها جنب القطعة.',
  },
];

const CARD_WARNING =
  'الكارت صغير، فأي خطأ بسيط في حروفه بيتضاعف على القطعة: ممكن يغلّط الصدر لحد ±0.7 سم تقريباً. ' +
  'عشان تقلل الخطأ: حطه مفرود تماماً ولازق في القطعة جنب الصدر، وقرّب الموبايل على قد ما القطعة كلها لسه باينة. ' +
  'للدقة الأعلى استخدم ورقة A4 أو المتر.';

const parseCm = (v: string) => parseFloat(v.replace(',', '.'));

export function CalibrateScreen({ shot, serverUrl, onBack, onResult }: Props) {
  const [kind, setKind] = useState<ReferenceKind>('tape');
  const [boxW, setBoxW] = useState(0);
  const [pts, setPts] = useState<Pt[]>([]);
  const [cm, setCm] = useState('50');
  const [rectW, setRectW] = useState('');
  const [rectH, setRectH] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const opt = REFERENCES.find((r) => r.kind === kind)!;
  const isTape = kind === 'tape';
  const need = isTape ? 2 : 4;

  const boxH = boxW ? (boxW * shot.height) / shot.width : 0;
  const k = boxW ? shot.width / boxW : 1; // display px -> image px
  const toImg = (p: Pt) => ({ x: p.x * k, y: p.y * k });

  const choose = (next: ReferenceKind) => {
    setKind(next);
    setPts([]);
    setError(null);
  };
  const tap = (x: number, y: number) => setPts((p) => (p.length >= need ? [{ x, y }] : [...p, { x, y }]));

  // Rectangles: no taps = let the server find it, 4 taps = use them. Tape always needs 2.
  const rectSize: [number, number] | null =
    kind === 'rect'
      ? parseCm(rectW) > 0 && parseCm(rectH) > 0
        ? [parseCm(rectW), parseCm(rectH)]
        : null
      : opt.size ?? null;
  const ready = isTape ? pts.length === 2 && parseCm(cm) > 0 : (pts.length === 0 || pts.length === 4) && rectSize !== null;

  const submit = async () => {
    if (!ready) return;
    let scale: Scale;
    if (isTape) {
      scale = { type: 'tape', p1: toImg(pts[0]), p2: toImg(pts[1]), cm: parseCm(cm) };
    } else {
      const corners = pts.length === 4 ? pts.map(toImg) : undefined;
      scale =
        kind === 'rect'
          ? { type: 'rect', wCm: rectSize![0], hCm: rectSize![1], corners }
          : { type: kind as 'a4' | 'card', corners };
    }
    setBusy(true);
    setError(null);
    try {
      const res = await measure(serverUrl, shot.uri, scale);
      onResult(res, {
        method: kind,
        calibrationCm: isTape ? parseCm(cm) : null,
        reference: isTape ? undefined : { wCm: rectSize![0], hCm: rectSize![1], autoDetected: pts.length === 0 },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'حصل خطأ في الاتصال بالسيرفر.');
    } finally {
      setBusy(false);
    }
  };

  const btnLabel = isTape || pts.length === 4 ? 'قيس القطعة' : pts.length === 0 ? 'قيس القطعة (المرجع هيتحدد لوحده)' : `كمّل الأركان (${pts.length}/4)`;

  return (
    <ScrollView style={s.root} contentContainerStyle={{ padding: 16, paddingTop: 56, gap: 14 }}>
      <View style={s.header}>
        <Pressable onPress={onBack} style={s.back} accessibilityLabel="رجوع">
          <Text style={{ fontSize: 18, color: C.text }}>›</Text>
        </Pressable>
        <Text style={s.title}>حدّد المقياس</Text>
        <View style={{ width: 44 }} />
      </View>

      <Text style={s.label}>إيه اللي جنب القطعة في الصورة؟</Text>
      <View style={s.chips} accessibilityRole="radiogroup">
        {REFERENCES.map((r) => (
          <Pressable
            key={r.kind}
            onPress={() => choose(r.kind)}
            style={[s.chip, r.kind === kind && s.chipOn]}
            accessibilityRole="radio"
            accessibilityState={{ selected: r.kind === kind }}
          >
            <Text style={[s.chipText, r.kind === kind && s.chipTextOn]}>{r.label}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={s.sub}>{opt.hint}</Text>
      {kind === 'card' && <Text style={s.warn}>{CARD_WARNING}</Text>}

      {kind === 'rect' && (
        <View style={s.row}>
          <Text style={s.label}>المقاس</Text>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <View style={s.inputBox}>
              <TextInput value={rectW} onChangeText={setRectW} keyboardType="decimal-pad" placeholder="طول" placeholderTextColor={C.muted} style={s.input} accessibilityLabel="الطول بالسنتيمتر" />
              <Text style={s.unit}>cm</Text>
            </View>
            <Text style={s.unit}>×</Text>
            <View style={s.inputBox}>
              <TextInput value={rectH} onChangeText={setRectH} keyboardType="decimal-pad" placeholder="عرض" placeholderTextColor={C.muted} style={s.input} accessibilityLabel="العرض بالسنتيمتر" />
              <Text style={s.unit}>cm</Text>
            </View>
          </View>
        </View>
      )}

      <View style={{ width: '100%' }} onLayout={(e) => setBoxW(e.nativeEvent.layout.width)}>
        {boxW > 0 && (
          <Pressable onPress={(e) => tap(e.nativeEvent.locationX, e.nativeEvent.locationY)} style={{ width: boxW, height: boxH }}>
            <Image source={{ uri: shot.uri }} style={{ width: boxW, height: boxH, borderRadius: 16 }} />
            <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
              {isTape && pts.length === 2 && <SvgLine x1={pts[0].x} y1={pts[0].y} x2={pts[1].x} y2={pts[1].y} stroke={C.gold} strokeWidth={3} />}
              {!isTape && pts.length >= 3 && (
                <Polygon points={orderAround(pts).map((p) => `${p.x},${p.y}`).join(' ')} fill="rgba(201,162,126,0.25)" stroke={C.gold} strokeWidth={2} />
              )}
              {pts.map((p, i) => (
                <Circle key={i} cx={p.x} cy={p.y} r={isTape ? 8 : 6} fill={C.petrol} stroke="#FFFFFF" strokeWidth={2} />
              ))}
            </Svg>
          </Pressable>
        )}
      </View>
      {pts.length > 0 && (
        <Pressable onPress={() => setPts([])} style={s.ghost}>
          <Text style={s.ghostText}>{isTape ? 'امسح النقط' : 'امسح الأركان'}</Text>
        </Pressable>
      )}

      {isTape && (
        <View style={s.row}>
          <Text style={s.label}>المسافة بين النقطتين</Text>
          <View style={s.inputBox}>
            <TextInput value={cm} onChangeText={setCm} keyboardType="decimal-pad" style={s.input} accessibilityLabel="المسافة بالسنتيمتر" />
            <Text style={s.unit}>cm</Text>
          </View>
        </View>
      )}

      {error && <Text style={s.error}>{error}</Text>}

      <Pressable onPress={submit} disabled={!ready || busy} style={[s.btn, (!ready || busy) && { opacity: 0.4 }]}>
        {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={s.btnText}>{btnLabel}</Text>}
      </Pressable>
    </ScrollView>
  );
}

/** Taps can come in any order; sort them around their centre so the outline doesn't cross itself. */
function orderAround(pts: Pt[]): Pt[] {
  const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  return [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' },
  back: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 18, fontWeight: '600', color: C.text },
  sub: { fontSize: 14, lineHeight: 22, color: C.text2, textAlign: 'right' },
  warn: { color: C.warn, backgroundColor: C.warnBg, padding: 12, borderRadius: 12, textAlign: 'right', lineHeight: 21 },
  chips: { flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 44, paddingHorizontal: 16, borderRadius: 22, borderWidth: 1.5, borderColor: C.borderStrong, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center' },
  chipOn: { backgroundColor: C.petrol, borderColor: C.petrol },
  chipText: { fontSize: 15, fontWeight: '600', color: C.text },
  chipTextOn: { color: '#FFFFFF' },
  row: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' },
  label: { fontSize: 15, color: C.text, textAlign: 'right' },
  inputBox: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 48, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1.5, borderColor: C.borderStrong, backgroundColor: C.surface },
  input: { minWidth: 60, fontSize: 18, fontWeight: '600', color: C.text, textAlign: 'center' },
  unit: { fontSize: 13, color: C.muted },
  error: { color: C.bad, backgroundColor: C.badBg, padding: 12, borderRadius: 12, textAlign: 'right' },
  btn: { height: 54, borderRadius: 16, backgroundColor: C.petrol, alignItems: 'center', justifyContent: 'center' },
  btnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  ghost: { height: 40, alignItems: 'center', justifyContent: 'center' },
  ghostText: { color: C.goldText, fontSize: 14, fontWeight: '600' },
});
