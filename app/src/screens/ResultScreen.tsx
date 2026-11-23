import { useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Svg, { Circle, Line as SvgLine } from 'react-native-svg';

import { saveRecord } from '../storage';
import { C, MEASUREMENT_LABELS } from '../theme';
import type { MeasureResponse, Shot } from '../types';

type Props = { shot: Shot; result: MeasureResponse; calibrationCm: number; onDone: () => void };

export function ResultScreen({ shot, result, calibrationCm, onDone }: Props) {
  const [boxW, setBoxW] = useState(0);
  const [truth, setTruth] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [saved, setSaved] = useState(false);

  const [imgW, imgH] = result.image_size;
  const boxH = boxW ? (boxW * imgH) / imgW : 0;
  const k = boxW ? boxW / imgW : 1; // image px -> display px

  const save = async () => {
    const parsed: Record<string, number | null> = {};
    for (const key of Object.keys(result.measurements_cm)) {
      const v = parseFloat((truth[key] ?? '').replace(',', '.'));
      parsed[key] = Number.isFinite(v) ? v : null;
    }
    await saveRecord({
      id: `${Date.now()}`,
      takenAt: shot.takenAt,
      tiltDeg: shot.tiltDeg,
      scaleMethod: 'calibration',
      calibrationCm,
      pxPerCm: result.px_per_cm,
      measured: result.measurements_cm,
      truth: parsed,
      note,
    });
    setSaved(true);
  };

  return (
    <ScrollView style={s.root} contentContainerStyle={{ padding: 16, paddingTop: 56, gap: 14 }}>
      <Text style={s.title}>النتيجة</Text>

      <View style={{ width: '100%' }} onLayout={(e) => setBoxW(e.nativeEvent.layout.width)}>
        {boxW > 0 && (
          <View style={{ width: boxW, height: boxH }}>
            <Image source={{ uri: shot.uri }} style={{ width: boxW, height: boxH, borderRadius: 16 }} />
            <Svg style={StyleSheet.absoluteFill}>
              {result.lines.map((ln) => (
                <SvgLine
                  key={ln.name}
                  x1={ln.a.x * k} y1={ln.a.y * k} x2={ln.b.x * k} y2={ln.b.y * k}
                  stroke={ln.confidence === 'high' ? C.petrol : C.warn}
                  strokeWidth={3}
                  strokeDasharray={ln.confidence === 'high' ? undefined : '6 4'}
                />
              ))}
              {result.lines.flatMap((ln) => [ln.a, ln.b].map((p, i) => (
                <Circle key={`${ln.name}${i}`} cx={p.x * k} cy={p.y * k} r={5} fill={C.gold} stroke="#FFFFFF" strokeWidth={1.5} />
              )))}
            </Svg>
          </View>
        )}
      </View>

      {result.warnings.map((w) => (
        <Text key={w} style={s.warn}>{w}</Text>
      ))}

      <View style={s.card}>
        <View style={s.headRow}>
          <Text style={s.colHead}>مقاسي</Text>
          <Text style={s.colHead}>بالمتر</Text>
          <Text style={[s.colHead, { flex: 1.4, textAlign: 'right' }]}>القياس</Text>
        </View>
        {Object.entries(result.measurements_cm).map(([key, cm]) => {
          const t = parseFloat((truth[key] ?? '').replace(',', '.'));
          const diff = Number.isFinite(t) ? cm - t : null;
          return (
            <View key={key} style={s.row}>
              <View style={{ flex: 1, alignItems: 'center' }}>
                <Text style={s.value}>{cm.toFixed(1)}</Text>
                {diff !== null && (
                  <Text style={[s.diff, { color: Math.abs(diff) <= 1 ? C.good : Math.abs(diff) <= 2 ? C.warn : C.bad }]}>
                    {diff > 0 ? '+' : ''}{diff.toFixed(1)}
                  </Text>
                )}
              </View>
              <TextInput
                value={truth[key] ?? ''}
                onChangeText={(v) => setTruth((p) => ({ ...p, [key]: v }))}
                keyboardType="decimal-pad"
                placeholder="—"
                placeholderTextColor={C.muted}
                style={s.input}
                accessibilityLabel={`قياس ${MEASUREMENT_LABELS[key] ?? key} بالمتر`}
              />
              <Text style={[s.label, { flex: 1.4 }]}>{MEASUREMENT_LABELS[key] ?? key}</Text>
            </View>
          );
        })}
      </View>

      <TextInput value={note} onChangeText={setNote} placeholder="ملاحظة (نوع القماش، الإضاءة، الأرضية...)" placeholderTextColor={C.muted} style={s.note} multiline />

      {saved ? (
        <Pressable onPress={onDone} style={s.btn}><Text style={s.btnText}>اتحفظ — تجربة جديدة</Text></Pressable>
      ) : (
        <Pressable onPress={save} style={s.btn}><Text style={s.btnText}>احفظ النتيجة</Text></Pressable>
      )}
      <Pressable onPress={onDone} style={s.ghost}><Text style={s.ghostText}>رجوع للرئيسية</Text></Pressable>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  title: { fontSize: 22, fontWeight: '700', color: C.text, textAlign: 'right' },
  warn: { color: C.warn, backgroundColor: C.warnBg, padding: 10, borderRadius: 12, textAlign: 'right' },
  card: { backgroundColor: C.surface, borderRadius: 24, padding: 16, borderWidth: 1, borderColor: '#F0F2F2' },
  headRow: { flexDirection: 'row', paddingBottom: 8 },
  colHead: { flex: 1, fontSize: 13, color: C.muted, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderTopWidth: 1, borderTopColor: C.border },
  value: { fontSize: 18, fontWeight: '600', color: C.text },
  diff: { fontSize: 12, fontWeight: '600' },
  input: { flex: 1, height: 44, marginHorizontal: 6, borderRadius: 12, borderWidth: 1.5, borderColor: C.borderStrong, textAlign: 'center', fontSize: 16, color: C.text, backgroundColor: C.surface },
  label: { fontSize: 15, color: C.text, textAlign: 'right' },
  note: { minHeight: 60, borderRadius: 14, borderWidth: 1.5, borderColor: C.borderStrong, backgroundColor: C.surface, padding: 12, textAlign: 'right', color: C.text },
  btn: { height: 54, borderRadius: 16, backgroundColor: C.petrol, alignItems: 'center', justifyContent: 'center' },
  btnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  ghost: { height: 44, alignItems: 'center', justifyContent: 'center' },
  ghostText: { color: C.goldText, fontSize: 15, fontWeight: '600' },
});
