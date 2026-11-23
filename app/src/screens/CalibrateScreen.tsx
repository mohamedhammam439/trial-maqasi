import { useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Svg, { Circle, Line as SvgLine } from 'react-native-svg';

import { measure } from '../api';
import { C } from '../theme';
import type { MeasureResponse, Pt, Shot } from '../types';

type Props = {
  shot: Shot;
  serverUrl: string;
  onBack: () => void;
  onResult: (r: MeasureResponse, calibrationCm: number) => void;
};

/** The scale for this PoC comes from two taps on a known distance (e.g. a tape measure on the floor).
 *  In the real app this scale will come from AR (ARKit/ARCore), so this screen only isolates
 *  how accurate the garment detection is. */
export function CalibrateScreen({ shot, serverUrl, onBack, onResult }: Props) {
  const [boxW, setBoxW] = useState(0);
  const [pts, setPts] = useState<Pt[]>([]);
  const [cm, setCm] = useState('50');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const boxH = boxW ? (boxW * shot.height) / shot.width : 0;
  const k = boxW ? shot.width / boxW : 1; // display px -> image px

  const tap = (x: number, y: number) => setPts((p) => (p.length >= 2 ? [{ x, y }] : [...p, { x, y }]));

  const submit = async () => {
    const value = parseFloat(cm.replace(',', '.'));
    if (pts.length !== 2 || !(value > 0)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await measure(serverUrl, shot.uri, {
        p1: { x: pts[0].x * k, y: pts[0].y * k },
        p2: { x: pts[1].x * k, y: pts[1].y * k },
        cm: value,
      });
      onResult(res, value);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'حصل خطأ في الاتصال بالسيرفر.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={s.root} contentContainerStyle={{ padding: 16, paddingTop: 56, gap: 14 }}>
      <View style={s.header}>
        <Pressable onPress={onBack} style={s.back} accessibilityLabel="رجوع">
          <Text style={{ fontSize: 18, color: C.text }}>›</Text>
        </Pressable>
        <Text style={s.title}>حدّد المقياس</Text>
        <View style={{ width: 44 }} />
      </View>
      <Text style={s.sub}>اضغط على نقطتين معروف المسافة بينهم، مثلاً علامة 0 وعلامة 50 على متر مفرود جنب القطعة.</Text>

      <View style={{ width: '100%' }} onLayout={(e) => setBoxW(e.nativeEvent.layout.width)}>
        {boxW > 0 && (
          <Pressable onPress={(e) => tap(e.nativeEvent.locationX, e.nativeEvent.locationY)} style={{ width: boxW, height: boxH }}>
            <Image source={{ uri: shot.uri }} style={{ width: boxW, height: boxH, borderRadius: 16 }} />
            <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
              {pts.length === 2 && <SvgLine x1={pts[0].x} y1={pts[0].y} x2={pts[1].x} y2={pts[1].y} stroke={C.gold} strokeWidth={3} />}
              {pts.map((p, i) => (
                <Circle key={i} cx={p.x} cy={p.y} r={8} fill={C.petrol} stroke="#FFFFFF" strokeWidth={2} />
              ))}
            </Svg>
          </Pressable>
        )}
      </View>

      <View style={s.row}>
        <Text style={s.label}>المسافة بين النقطتين</Text>
        <View style={s.inputBox}>
          <TextInput value={cm} onChangeText={setCm} keyboardType="decimal-pad" style={s.input} accessibilityLabel="المسافة بالسنتيمتر" />
          <Text style={s.unit}>cm</Text>
        </View>
      </View>

      {error && <Text style={s.error}>{error}</Text>}

      <Pressable onPress={submit} disabled={pts.length !== 2 || busy} style={[s.btn, (pts.length !== 2 || busy) && { opacity: 0.4 }]}>
        {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={s.btnText}>قيس القطعة</Text>}
      </Pressable>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' },
  back: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 18, fontWeight: '600', color: C.text },
  sub: { fontSize: 14, lineHeight: 22, color: C.text2, textAlign: 'right' },
  row: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' },
  label: { fontSize: 15, color: C.text },
  inputBox: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 48, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1.5, borderColor: C.borderStrong, backgroundColor: C.surface },
  input: { minWidth: 60, fontSize: 18, fontWeight: '600', color: C.text, textAlign: 'center' },
  unit: { fontSize: 13, color: C.muted },
  error: { color: C.bad, backgroundColor: C.badBg, padding: 12, borderRadius: 12, textAlign: 'right' },
  btn: { height: 54, borderRadius: 16, backgroundColor: C.petrol, alignItems: 'center', justifyContent: 'center' },
  btnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
});
